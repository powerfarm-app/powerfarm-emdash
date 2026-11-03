/**
 * Powerfarm Graph: an entity-centred view over EmDash data.
 *
 * Nothing is loaded wholesale. A caller opens one node and asks for its
 * neighbours, a bounded traversal, its history or its provenance. Every answer
 * is assembled from EmDash-owned sources and filtered for the caller:
 *
 *   content nodes     EmDash entries (published view by default)
 *   relation edges    EmDash's live relation edges              state: published
 *   staged edges      reference selections in a draft revision  state: proposed (editors, draft view)
 *   link edges        operational link fields                   state: published / draft
 *   storage nodes     jobs, bridges, leases, journal entries and reconciliation records
 *                     from this plugin's EmDash storage
 *   history           the operational journal                   state: historical
 *
 * Node ids are `<type>:<stable id>` (see ontology.ts). Content edge sets are
 * cached per node and invalidated through the `graph:version` counter that the
 * content hooks bump; storage-derived edges are always read fresh.
 */

import type { PluginContext, StorageCollection } from "emdash";

import { type Access, canSeeClassification, canSeeType, filterFields, mask } from "./access.js";
import { type ContentReader, type Entity, nodeIdOf, parseNodeId } from "./content.js";
import { formatSubject, isEntityCollection, parseSubject } from "./entities.js";
import { entriesFor, type JournalEntry, streamEntries, streamForAsset } from "./journal.js";
import { jobsOf, listJobs } from "./jobs.js";
import { COLLECTIONS, type CollectionSlug, isPowerfarmCollection, type Job, LINK_FIELDS, SUBJECT_LINKS } from "./model.js";
import {
	collectionOfNodeType,
	DERIVED_EDGES,
	NODE_TYPES,
	type NodeTypeSpec,
	nodeTypeOfCollection,
	REFERENCE_FIELDS,
	RELATION_EDGES,
	RELATION_ENDS,
} from "./ontology.js";

export interface NodeView {
	id: string;
	type: string;
	domain: string;
	key: string | null;
	title: string;
	status: string | null;
	state: "published" | "draft" | "record";
	updatedAt: string | null;
	/** 1.2 entities only. Drives visibility (access.canSeeClassification). */
	classification?: string | null;
	data?: Record<string, unknown>;
	adminUrl?: string;
}

export interface EdgeView {
	id: string;
	type: string;
	label: string;
	from: string;
	to: string;
	source: "relation" | "staged" | "link" | "storage" | "journal";
	state: "published" | "draft" | "proposed" | "historical";
	recordedAt: string | null;
	origin: string;
}

export interface Neighbour {
	edge: EdgeView;
	direction: "out" | "in";
	node: NodeView;
}

export type SearchFn = (query: string, options: { collections?: string[]; limit?: number }) => Promise<{ items: Array<{ collection: string; id: string; title?: string; snippet?: string }> }>;

type Ctx = Pick<PluginContext, "storage" | "kv" | "content" | "log">;

const CACHE_MAX = 500;
const cache = new Map<string, { version: number; value: Neighbour[] }>();

export function clearGraphCache(): void {
	cache.clear();
}

function typeSpec(type: string): NodeTypeSpec | undefined {
	return (NODE_TYPES as Record<string, NodeTypeSpec>)[type];
}

function admin(collection: string, id: string): string {
	return `/_emdash/admin/content/${collection}/${id}`;
}

function edgeId(from: string, type: string, to: string): string {
	return `${from}|${type}|${to}`;
}

export class GraphService {
	private readonly ctx: Ctx;
	private readonly reader: ContentReader;
	private readonly access: Access;
	private readonly searchFn: SearchFn | null;

	constructor(ctx: Ctx, reader: ContentReader, access: Access, searchFn: SearchFn | null = null) {
		this.ctx = ctx;
		this.reader = reader;
		this.access = access;
		this.searchFn = searchFn;
	}

	// ---- nodes -----------------------------------------------------------------

	contentNode(entity: Entity, withData = true): NodeView {
		const type = nodeTypeOfCollection(entity.collection) ?? entity.collection;
		// An identifier entry's title and key are the identifier itself: masked like its value.
		const masked = type === "identifier" && !this.access.revealIdentifiers ? `${String(entity.data.namespace ?? "")}:${mask(String(entity.data.value ?? ""))}` : null;
		return {
			id: nodeIdOf(type, entity.group),
			type,
			domain: typeSpec(type)?.domain ?? "institution",
			key: masked ?? entity.key,
			title: masked ?? entity.title,
			status: entity.status,
			state: entity.state,
			updatedAt: entity.updatedAt,
			classification: typeof entity.data.classification === "string" ? entity.data.classification : null,
			data: withData ? filterFields(this.access, type, entity.data) : undefined,
			adminUrl: admin(entity.collection, entity.id),
		};
	}

	/** Type and classification together: the one visibility test for every node. */
	visible(node: Pick<NodeView, "type" | "classification">): boolean {
		return canSeeType(this.access, node.type) && canSeeClassification(this.access, node.classification);
	}

	jobNode(job: Job, withData = true): NodeView {
		return {
			id: `job:${job.id}`,
			type: "job",
			domain: "operations",
			key: job.opCode,
			title: `${job.opCode} ${job.operation} on ${job.assetTag}`,
			status: job.status,
			state: "record",
			updatedAt: job.updatedAt,
			data: withData
				? filterFields(this.access, "job", {
						operation: job.operation,
						assetTag: job.assetTag,
						opRevision: job.opRevision,
						executionMode: job.executionMode,
						dryRun: job.dryRun,
						destructive: job.destructive,
						claimedBy: job.claimedBy,
						leaseExpiresAt: job.leaseExpiresAt,
						startedAt: job.startedAt,
						finishedAt: job.finishedAt,
						approvedBy: job.approvedBy,
						ecid: job.ecid,
						serialNumber: job.serialNumber,
						result: job.result,
						inspection: job.inspection,
						auditGap: job.auditGap,
					})
				: undefined,
		};
	}

	private journalNode(entry: JournalEntry): NodeView {
		return {
			id: `journal_event:${entry.eventId}`,
			type: "journal_event",
			domain: "operations",
			key: `${entry.stream}#${entry.seq}`,
			title: entry.title,
			status: entry.projectionStatus,
			state: "record",
			updatedAt: entry.at,
			data: { type: entry.type, actor: entry.actor, source: entry.source, stream: entry.stream, seq: entry.seq, hash: entry.hash, prevHash: entry.prevHash },
		};
	}

	async getNode(nodeId: string): Promise<NodeView | null> {
		const parsed = parseNodeId(nodeId);
		if (!parsed || !canSeeType(this.access, parsed.type)) return null;
		const collection = collectionOfNodeType(parsed.type);
		if (collection) {
			const [entity] = await this.reader.byGroups(collection, [parsed.id], this.access.view);
			const node = entity ? this.contentNode(entity) : null;
			return node && this.visible(node) && (await this.subjectVisible(entity!)) ? node : null;
		}
		if (parsed.type === "job") {
			const job = await jobsOf(this.ctx).get(parsed.id);
			return job ? this.jobNode(job) : null;
		}
		if (parsed.type === "lease") {
			const job = await jobsOf(this.ctx).get(parsed.id);
			return job?.leaseId ? this.leaseNode(job) : null;
		}
		if (parsed.type === "bridge") {
			const bridge = await this.storage("bridges").get(parsed.id);
			return bridge ? this.bridgeNode(parsed.id, bridge as Record<string, unknown>) : null;
		}
		if (parsed.type === "journal_event") {
			const page = await this.storage("journal").query({ where: { eventId: parsed.id }, limit: 1 });
			const entry = page.items[0]?.data as JournalEntry | undefined;
			return entry ? this.journalNode(entry) : null;
		}
		if (parsed.type === "reconciliation") {
			const rec = await this.storage("reconciliations").get(parsed.id);
			return rec ? this.reconciliationNode(parsed.id, rec as Record<string, unknown>) : null;
		}
		return null;
	}

	/** Resolve a business key, entry id or node id to a node id. */
	async resolve(typeOrCollection: string, ref: string): Promise<string | null> {
		if (ref.includes(":") && parseNodeId(ref) && (await this.getNode(ref))) return ref;
		const collection = isPowerfarmCollection(typeOrCollection) ? typeOrCollection : collectionOfNodeType(typeOrCollection);
		if (collection) {
			const type = nodeTypeOfCollection(collection)!;
			if (!canSeeType(this.access, type)) return null;
			const entity = await this.reader.resolve(collection, ref, this.access.view);
			return entity ? nodeIdOf(type, entity.group) : null;
		}
		if (typeOrCollection === "job") return (await jobsOf(this.ctx).get(ref)) && canSeeType(this.access, "job") ? `job:${ref}` : null;
		return null;
	}

	/** Records about an entity (identifiers, work items, exceptions, evidence) are only as visible as the entity. */
	private async subjectVisible(entity: Entity): Promise<boolean> {
		const link = SUBJECT_LINKS.find((l) => l.collection === entity.collection);
		const subject = link ? parseSubject(entity.data[link.field]) : null;
		if (!subject) return true;
		const [target] = await this.reader.byField(subject.collection, "code", [subject.key], "draft", 1);
		return !target || canSeeClassification(this.access, target.data.classification);
	}

	private storage(name: string): StorageCollection<unknown> {
		return (this.ctx.storage as Record<string, StorageCollection<unknown>>)[name]!;
	}

	private leaseNode(job: Job): NodeView {
		return {
			id: `lease:${job.id}`,
			type: "lease",
			domain: "operations",
			key: null,
			title: `Lease on ${job.opCode} (${job.claimedBy ?? "unclaimed"})`,
			status: job.leaseExpiresAt && job.leaseExpiresAt > new Date().toISOString() ? "held" : "expired",
			state: "record",
			updatedAt: job.claimedAt,
			data: { holder: job.claimedBy, expiresAt: job.leaseExpiresAt, claimedAt: job.claimedAt },
		};
	}

	private bridgeNode(id: string, bridge: Record<string, unknown>): NodeView {
		return {
			id: `bridge:${id}`,
			type: "bridge",
			domain: "operations",
			key: id,
			title: `Bridge ${id}`,
			status: String(bridge.status ?? "unknown"),
			state: "record",
			updatedAt: String(bridge.lastSeenAt ?? ""),
			data: {
				bridgeVersion: bridge.bridgeVersion,
				macosVersion: bridge.macosVersion,
				cfgutilVersion: bridge.cfgutilVersion,
				mode: bridge.mode,
				validatedOperations: bridge.validatedOperations,
				unsupportedOperations: bridge.unsupportedOperations,
				lastSeenAt: bridge.lastSeenAt,
			},
		};
	}

	private reconciliationNode(id: string, rec: Record<string, unknown>): NodeView {
		return {
			id: `reconciliation:${id}`,
			type: "reconciliation",
			domain: "operations",
			key: String(rec.kind ?? ""),
			title: String(rec.detail ?? id),
			status: String(rec.status ?? ""),
			state: "record",
			updatedAt: String(rec.at ?? ""),
			data: { kind: rec.kind, opId: rec.opId, jobId: rec.jobId },
		};
	}

	// ---- edges -----------------------------------------------------------------

	private async contentNeighbours(entity: Entity): Promise<Neighbour[]> {
		// The cache holds unfiltered content edges per view; access filtering is applied
		// on every request, so one caller's view never leaks into another's.
		const versionKey = `${this.access.view}|${entity.collection}:${entity.group}`;
		const version = (await this.ctx.kv.get<number>("graph:version")) ?? 0;
		const hit = cache.get(versionKey);
		if (hit && hit.version === version) return hit.value.filter((n) => this.visible(n.node));

		const self = this.contentNode(entity, false);
		const out: Neighbour[] = [];
		const want = new Map<CollectionSlug, Set<string>>();
		const pending: Array<{ collection: CollectionSlug; group: string; make: (node: NodeView) => Neighbour }> = [];
		const add = (collection: CollectionSlug, group: string, make: (node: NodeView) => Neighbour) => {
			if (!want.has(collection)) want.set(collection, new Set());
			want.get(collection)!.add(group);
			pending.push({ collection, group, make });
		};

		// Native relations (live).
		for (const e of await this.reader.readPort.edgesTouching([entity.group])) {
			const spec = RELATION_EDGES[e.relation] ?? { type: e.relation, label: e.relation, inverse: `${e.relation} (inverse)` };
			const outgoing = e.parent_group === entity.group && e.parent_collection === entity.collection;
			const otherCollection = (outgoing ? e.child_collection : e.parent_collection) as CollectionSlug;
			const otherGroup = outgoing ? e.child_group : e.parent_group;
			add(otherCollection, otherGroup, (node) => ({
				direction: outgoing ? "out" : "in",
				node,
				edge: {
					id: edgeId(outgoing ? self.id : node.id, spec.type, outgoing ? node.id : self.id),
					type: spec.type,
					label: outgoing ? spec.label : spec.inverse,
					from: outgoing ? self.id : node.id,
					to: outgoing ? node.id : self.id,
					source: "relation",
					state: "published",
					recordedAt: e.created_at,
					origin: `relation:${e.relation}`,
				},
			}));
		}

		// Staged selections in a draft revision: proposed, not yet published.
		if (this.access.view === "draft" && entity.stagedReferences) {
			for (const [field, groups] of Object.entries(entity.stagedReferences)) {
				const ref = REFERENCE_FIELDS[`${entity.collection}.${field}`];
				const ends = ref ? RELATION_ENDS[ref.relation] : undefined;
				if (!ref || !ends || !Array.isArray(groups)) continue;
				const spec = RELATION_EDGES[ref.relation]!;
				const otherCollection = ref.side === "parent" ? ends.child : ends.parent;
				for (const group of groups) {
					add(otherCollection, String(group), (node) => ({
						direction: ref.side === "parent" ? "out" : "in",
						node,
						edge: {
							id: `${edgeId(self.id, spec.type, node.id)}|proposed`,
							type: spec.type,
							label: `${ref.side === "parent" ? spec.label : spec.inverse} (proposed)`,
							from: ref.side === "parent" ? self.id : node.id,
							to: ref.side === "parent" ? node.id : self.id,
							source: "staged",
							state: "proposed",
							recordedAt: entity.updatedAt,
							origin: `draft-revision:${entity.draftRevisionId}`,
						},
					}));
				}
			}
		}

		// Outgoing link fields.
		for (const link of LINK_FIELDS.filter((l) => l.collection === entity.collection)) {
			const value = entity.data[link.field];
			if (typeof value !== "string" || !value) continue;
			const target = await this.reader.resolve(link.target, value, this.access.view);
			if (!target) continue;
			const d = DERIVED_EDGES[link.edge]!;
			const node = this.contentNode(target, false);
			out.push({
				direction: "out",
				node,
				edge: { id: edgeId(self.id, link.edge, node.id), type: link.edge, label: d.label, from: self.id, to: node.id, source: "link", state: entity.state, recordedAt: entity.updatedAt, origin: `field:${entity.collection}.${link.field}` },
			});
		}
		// Incoming link fields.
		if (entity.key) {
			for (const link of LINK_FIELDS.filter((l) => l.target === entity.collection)) {
				const sources = await this.reader.byField(link.collection, link.field, [entity.key.toUpperCase()], this.access.view, 100);
				const d = DERIVED_EDGES[link.edge]!;
				for (const source of sources) {
					const node = this.contentNode(source, false);
					out.push({
						direction: "in",
						node,
						edge: { id: edgeId(node.id, link.edge, self.id), type: link.edge, label: d.inverse, from: node.id, to: self.id, source: "link", state: source.state, recordedAt: source.updatedAt, origin: `field:${link.collection}.${link.field}` },
					});
				}
			}
		}

		// Polymorphic subject links (identifiers, work items, exceptions, evidence → an entity).
		for (const link of SUBJECT_LINKS.filter((l) => l.collection === entity.collection)) {
			const subject = parseSubject(entity.data[link.field]);
			if (!subject) continue;
			const target = await this.reader.resolve(subject.collection, subject.key, this.access.view);
			if (!target) continue;
			const d = DERIVED_EDGES[link.edge]!;
			const node = this.contentNode(target, false);
			out.push({ direction: "out", node, edge: { id: edgeId(self.id, link.edge, node.id), type: link.edge, label: d.label, from: self.id, to: node.id, source: "link", state: entity.state, recordedAt: entity.updatedAt, origin: `field:${entity.collection}.${link.field}` } });
		}
		if (entity.key && isEntityCollection(entity.collection)) {
			for (const link of SUBJECT_LINKS) {
				const sources = await this.reader.byField(link.collection, link.field, [formatSubject(entity.collection, entity.key)], this.access.view, 100);
				const d = DERIVED_EDGES[link.edge]!;
				for (const source of sources) {
					const node = this.contentNode(source, false);
					out.push({ direction: "in", node, edge: { id: edgeId(node.id, link.edge, self.id), type: link.edge, label: d.inverse, from: node.id, to: self.id, source: "link", state: source.state, recordedAt: source.updatedAt, origin: `field:${link.collection}.${link.field}` } });
				}
			}
		}

		// Resolve relation/staged targets in one query per collection.
		for (const [collection, groups] of want) {
			if (!nodeTypeOfCollection(collection)) continue;
			const entities = await this.reader.byGroups(collection, [...groups], this.access.view);
			const byGroup = new Map(entities.map((e) => [e.group, e]));
			for (const p of pending.filter((x) => x.collection === collection)) {
				const target = byGroup.get(p.group);
				if (target) out.push(p.make(this.contentNode(target, false)));
			}
		}

		if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
		cache.set(versionKey, { version, value: out });
		return out.filter((n) => this.visible(n.node));
	}

	private async storageNeighboursOfContent(entity: Entity, self: NodeView): Promise<Neighbour[]> {
		if (!canSeeType(this.access, "job")) return [];
		let jobs: Job[] = [];
		if (entity.collection === "assets" && entity.key) jobs = await listJobs(this.ctx, { assetTag: entity.key.toUpperCase() }, 100);
		else if (entity.collection === "recovery_operations") jobs = await listJobs(this.ctx, { opId: entity.id }, 50);
		else if (entity.collection === "evidence" && typeof entity.data.job_id === "string") {
			const j = await jobsOf(this.ctx).get(entity.data.job_id);
			if (j) jobs = [j];
		}
		const type = entity.collection === "assets" ? "acts_on" : entity.collection === "recovery_operations" ? "executes" : "produced";
		const d = DERIVED_EDGES[type]!;
		return jobs.map((job) => {
			const node = this.jobNode(job, false);
			return { direction: "in" as const, node, edge: { id: edgeId(node.id, type, self.id), type, label: d.inverse, from: node.id, to: self.id, source: "storage" as const, state: "published" as const, recordedAt: job.updatedAt, origin: "storage:jobs" } };
		});
	}

	private async jobNeighbours(job: Job): Promise<Neighbour[]> {
		const self = this.jobNode(job, false);
		const out: Neighbour[] = [];
		const link = (type: string, node: NodeView, direction: "out" | "in" = "out", source: EdgeView["source"] = "storage", recordedAt: string | null = job.updatedAt) => {
			const d = DERIVED_EDGES[type]!;
			out.push({
				direction,
				node,
				edge: {
					id: direction === "out" ? edgeId(self.id, type, node.id) : edgeId(node.id, type, self.id),
					type,
					label: direction === "out" ? d.label : d.inverse,
					from: direction === "out" ? self.id : node.id,
					to: direction === "out" ? node.id : self.id,
					source,
					state: source === "journal" ? "historical" : "published",
					recordedAt,
					origin: "storage:jobs",
				},
			});
		};
		const op = await this.reader.resolve("recovery_operations", job.opId, this.access.view);
		if (op && canSeeType(this.access, "operation")) link("executes", this.contentNode(op, false));
		const asset = await this.reader.resolve("assets", job.assetTag, "published");
		if (asset) link("acts_on", this.contentNode(asset, false));
		if (job.claimedBy) {
			const bridge = await this.storage("bridges").get(job.claimedBy);
			link("claimed_by", bridge ? this.bridgeNode(job.claimedBy, bridge as Record<string, unknown>) : { id: `bridge:${job.claimedBy}`, type: "bridge", domain: "operations", key: job.claimedBy, title: `Bridge ${job.claimedBy}`, status: "unknown", state: "record", updatedAt: null });
			if (job.leaseId) link("holds_lease", this.leaseNode(job));
		}
		if (job.evidence.length > 0 && canSeeType(this.access, "evidence")) {
			const ev = await this.reader.byField("evidence", "job_id", [job.id], "draft", 50);
			for (const e of ev) link("produced", this.contentNode(e, false));
		}
		for (const entry of await entriesFor(this.ctx, { jobId: job.id }, 50)) link("recorded", this.journalNode(entry), "out", "journal", entry.at);
		const recs = await this.storage("reconciliations").query({ where: { opId: job.opId }, limit: 20 });
		for (const r of recs.items) {
			const rec = r.data as Record<string, unknown>;
			if (rec.jobId === job.id) link("reconciles", this.reconciliationNode(r.id, rec), "in");
		}
		return out;
	}

	async neighbours(
		nodeId: string,
		options: { direction?: "out" | "in" | "both"; edgeTypes?: string[]; nodeTypes?: string[]; states?: string[]; limit?: number; cursor?: string } = {},
	): Promise<{ node: NodeView; neighbours: Neighbour[]; total: number; cursor?: string } | null> {
		const node = await this.getNode(nodeId);
		if (!node) return null;
		const parsed = parseNodeId(nodeId)!;
		let all: Neighbour[] = [];
		const collection = collectionOfNodeType(parsed.type);
		if (collection) {
			const [entity] = await this.reader.byGroups(collection, [parsed.id], this.access.view);
			if (entity) all = [...(await this.contentNeighbours(entity)), ...(await this.storageNeighboursOfContent(entity, node))];
		} else if (parsed.type === "job") {
			const job = await jobsOf(this.ctx).get(parsed.id);
			if (job) all = await this.jobNeighbours(job);
		} else if (parsed.type === "lease") {
			const job = await jobsOf(this.ctx).get(parsed.id);
			if (job) all = [{ direction: "in", node: this.jobNode(job, false), edge: { id: edgeId(`job:${job.id}`, "holds_lease", nodeId), type: "holds_lease", label: "lease of", from: `job:${job.id}`, to: nodeId, source: "storage", state: "published", recordedAt: job.claimedAt, origin: "storage:jobs" } }];
		} else if (parsed.type === "bridge") {
			const jobs = (await listJobs(this.ctx, {}, 200)).filter((j) => j.claimedBy === parsed.id).slice(0, 50);
			all = jobs.map((j) => ({ direction: "in" as const, node: this.jobNode(j, false), edge: { id: edgeId(`job:${j.id}`, "claimed_by", nodeId), type: "claimed_by", label: "claimed", from: `job:${j.id}`, to: nodeId, source: "storage" as const, state: "published" as const, recordedAt: j.claimedAt, origin: "storage:jobs" } }));
		} else if (parsed.type === "journal_event") {
			const page = await this.storage("journal").query({ where: { eventId: parsed.id }, limit: 1 });
			const entry = page.items[0]?.data as JournalEntry | undefined;
			if (entry?.jobId) {
				const job = await jobsOf(this.ctx).get(entry.jobId);
				if (job) all.push({ direction: "in", node: this.jobNode(job, false), edge: { id: edgeId(`job:${job.id}`, "recorded", nodeId), type: "recorded", label: "recorded by", from: `job:${job.id}`, to: nodeId, source: "journal", state: "historical", recordedAt: entry.at, origin: "storage:journal" } });
			}
		}

		const filtered = all
			.filter((n) => this.visible(n.node))
			.filter((n) => !options.direction || options.direction === "both" || n.direction === options.direction)
			.filter((n) => !options.edgeTypes?.length || options.edgeTypes.includes(n.edge.type))
			.filter((n) => !options.nodeTypes?.length || options.nodeTypes.includes(n.node.type))
			.filter((n) => !options.states?.length || options.states.includes(n.edge.state))
			.sort((a, b) => a.edge.type.localeCompare(b.edge.type) || a.node.id.localeCompare(b.node.id));
		const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
		const offset = options.cursor ? decodeCursor(options.cursor) : 0;
		const page = filtered.slice(offset, offset + limit);
		return { node, neighbours: page, total: filtered.length, cursor: offset + limit < filtered.length ? encodeCursor(offset + limit) : undefined };
	}

	/** Bounded breadth-first traversal. */
	async trace(startId: string, options: { depth?: number; direction?: "out" | "in" | "both"; edgeTypes?: string[]; nodeTypes?: string[]; maxNodes?: number } = {}) {
		const depth = Math.min(Math.max(options.depth ?? 2, 1), 4);
		const maxNodes = Math.min(Math.max(options.maxNodes ?? 100, 1), 300);
		const start = await this.getNode(startId);
		if (!start) return null;
		const seen = new Map<string, { node: NodeView; depth: number }>([[startId, { node: start, depth: 0 }]]);
		const edges = new Map<string, EdgeView>();
		let frontier = [startId];
		let truncated = false;
		for (let d = 1; d <= depth && frontier.length > 0; d++) {
			const next: string[] = [];
			for (const id of frontier) {
				// oxlint-disable-next-line no-await-in-loop -- bounded traversal
				const result = await this.neighbours(id, { direction: options.direction, edgeTypes: options.edgeTypes, limit: 200 });
				for (const n of result?.neighbours ?? []) {
					if (options.nodeTypes?.length && !options.nodeTypes.includes(n.node.type)) continue;
					edges.set(n.edge.id, n.edge);
					if (seen.has(n.node.id)) continue;
					if (seen.size >= maxNodes) {
						truncated = true;
						continue;
					}
					seen.set(n.node.id, { node: n.node, depth: d });
					next.push(n.node.id);
				}
			}
			frontier = next;
		}
		const nodeIds = new Set(seen.keys());
		return {
			start: startId,
			nodes: [...seen.values()].map((s) => ({ ...s.node, depth: s.depth })),
			edges: [...edges.values()].filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to)),
			truncated,
		};
	}

	/** Find entities: exact business keys first, then EmDash's full-text index (published content). */
	async search(query: string, options: { types?: string[]; limit?: number } = {}): Promise<Array<NodeView & { snippet?: string }>> {
		const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
		const q = query.trim();
		if (!q) return [];
		const types = (options.types?.length ? options.types : Object.keys(NODE_TYPES)).filter((t) => canSeeType(this.access, t));
		const collections = types.map(collectionOfNodeType).filter((c): c is CollectionSlug => !!c);
		const results: Array<NodeView & { snippet?: string }> = [];
		const seen = new Set<string>();
		for (const collection of collections) {
			const keyField = COLLECTIONS[collection].key;
			if (!keyField) continue;
			// oxlint-disable-next-line no-await-in-loop -- one indexed lookup per keyed collection
			for (const e of await this.reader.byField(collection, keyField, [q, q.toUpperCase()], this.access.view, 5)) {
				const node = this.contentNode(e, false);
				if (seen.has(node.id) || !this.visible(node)) continue;
				seen.add(node.id);
				results.push(node);
			}
		}
		if (this.searchFn && results.length < limit) {
			const hits = await this.searchFn(q, { collections, limit: limit * 2 }).catch(() => ({ items: [] }));
			const byCollection = new Map<CollectionSlug, string[]>();
			for (const hit of hits.items) {
				if (!isPowerfarmCollection(hit.collection)) continue;
				if (!byCollection.has(hit.collection)) byCollection.set(hit.collection, []);
				byCollection.get(hit.collection)!.push(hit.id);
			}
			const snippets = new Map(hits.items.map((h) => [h.id, h.snippet]));
			for (const [collection, ids] of byCollection) {
				// oxlint-disable-next-line no-await-in-loop
				const rows = await this.reader.readPort.rows(collection, { ids, statuses: this.access.view === "published" ? ["published"] : undefined, limit: ids.length });
				const groups = [...new Set(rows.map((r) => r.translation_group ?? r.id))];
				// oxlint-disable-next-line no-await-in-loop
				for (const e of await this.reader.byGroups(collection, groups, this.access.view)) {
					const node = this.contentNode(e, false);
					if (seen.has(node.id) || !this.visible(node)) continue;
					seen.add(node.id);
					results.push({ ...node, snippet: snippets.get(e.id) ?? rows.map((r) => snippets.get(r.id)).find(Boolean) });
				}
			}
		}
		return results.slice(0, limit);
	}

	/** The journal history of an asset, operation or job (newest first). */
	async history(nodeId: string, limit = 100): Promise<{ node: NodeView; entries: Array<Pick<JournalEntry, "eventId" | "stream" | "seq" | "type" | "at" | "actor" | "source" | "title" | "jobId" | "opCode" | "hash">> } | null> {
		const node = await this.getNode(nodeId);
		if (!node || !canSeeType(this.access, "journal_event")) return node ? { node, entries: [] } : null;
		let entries: JournalEntry[] = [];
		if (node.type === "asset" && node.key) entries = (await streamEntries(this.ctx, streamForAsset(node.key), limit)).entries;
		else if (node.type === "operation" && node.key) entries = await entriesFor(this.ctx, { opCode: node.key }, limit);
		else if (node.type === "job") entries = await entriesFor(this.ctx, { jobId: parseNodeId(nodeId)!.id }, limit);
		return {
			node,
			entries: entries.map((e) => ({ eventId: e.eventId, stream: e.stream, seq: e.seq, type: e.type, at: e.at, actor: e.actor, source: e.source, title: e.title, jobId: e.jobId, opCode: e.opCode, hash: e.hash })),
		};
	}

	/** Where a node's data came from: EmDash revisions, author, journal and evidence. */
	async provenance(nodeId: string) {
		const node = await this.getNode(nodeId);
		if (!node) return null;
		const parsed = parseNodeId(nodeId)!;
		const collection = collectionOfNodeType(parsed.type);
		if (!collection) return { node, revisions: [], evidence: [], history: (await this.history(nodeId, 50))?.entries ?? [] };
		const [entity] = await this.reader.byGroups(collection, [parsed.id], this.access.view);
		const revisions =
			entity && this.ctx.content?.listRevisions && this.access.role >= 40
				? await this.ctx.content.listRevisions(collection, entity.id, { limit: 50 }).catch(() => [])
				: [];
		let evidence: NodeView[] = [];
		if (entity?.key && canSeeType(this.access, "evidence") && (collection === "assets" || collection === "recovery_operations")) {
			const field = collection === "assets" ? "asset_tag" : "op_code";
			evidence = (await this.reader.byField("evidence", field, [entity.key.toUpperCase()], "draft", 100)).map((e) => this.contentNode(e));
		} else if (entity?.key && canSeeType(this.access, "evidence") && isEntityCollection(collection)) {
			evidence = (await this.reader.byField("evidence", "subject", [formatSubject(collection, entity.key)], "draft", 100)).map((e) => this.contentNode(e));
		}
		return {
			node,
			author: entity?.authorId ?? null,
			createdAt: entity?.createdAt ?? null,
			publishedAt: entity?.publishedAt ?? null,
			liveRevision: entity?.liveRevisionId ?? null,
			pendingDraft: entity?.hasPendingDraft ?? false,
			revisions,
			evidence,
			history: (await this.history(nodeId, 50))?.entries ?? [],
		};
	}

	/**
	 * Graph-backed retrieval: search, resolve, expand one hop, and return a compact
	 * context package with source links. Intended for MCP clients.
	 */
	async context(query: string, options: { types?: string[]; limit?: number; expand?: number } = {}) {
		const hits = await this.search(query, { types: options.types, limit: options.limit ?? 8 });
		const expand = Math.min(options.expand ?? 12, 30);
		const items = [];
		for (const hit of hits) {
			// oxlint-disable-next-line no-await-in-loop -- bounded
			const around = await this.neighbours(hit.id, { limit: expand });
			// oxlint-disable-next-line no-await-in-loop
			const full = await this.getNode(hit.id);
			items.push({
				node: full,
				matched: hit.snippet ?? null,
				related: (around?.neighbours ?? []).map((n) => ({ relation: n.edge.label, state: n.edge.state, node: { id: n.node.id, type: n.node.type, key: n.node.key, title: n.node.title, status: n.node.status } })),
				source: full?.adminUrl ?? null,
			});
		}
		return {
			query,
			view: this.access.view,
			generatedAt: new Date().toISOString(),
			identifiersRedacted: !this.access.revealIdentifiers,
			items,
			note: "Built from EmDash content and Powerfarm records the caller may read. Drafts are excluded unless requested by an editor.",
		};
	}
}

function encodeCursor(offset: number): string {
	return btoa(JSON.stringify({ o: offset }));
}

function decodeCursor(cursor: string): number {
	try {
		const v = JSON.parse(atob(cursor)) as { o?: number };
		return Number.isInteger(v.o) && v.o! >= 0 ? v.o! : 0;
	} catch {
		return 0;
	}
}
