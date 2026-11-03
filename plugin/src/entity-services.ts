/**
 * Read models for 1.2 entities: the entity panel, registration checks, the
 * service catalogue and the automation views. Everything is filtered by the
 * caller's access (type, classification, token cap) before it is returned.
 */

import type { PluginContext } from "emdash";

import { type Access, canSeeClassification, canSeeType, filterFields } from "./access.js";
import type { ContentReader, Entity } from "./content.js";
import { controlReport, identifierReport, loadEntityState } from "./controls.js";
import { ENTITY_COLLECTIONS, ENTITY_TYPES, type EntityCollection, formatSubject, isEntityCollection } from "./entities.js";
import { conflicts, formatIdentifier, parseIdentifiers } from "./identity.js";
import { ROLE } from "./model.js";
import { allRuns, type RunView, runsForSubject, viewRun } from "./onboarding.js";
import { schemaStatus } from "./entity-tasks.js";

type Ctx = Pick<PluginContext, "storage" | "kv" | "content" | "log">;

function visibleEntity(access: Access, entity: Entity): boolean {
	const type = isEntityCollection(entity.collection) ? ENTITY_TYPES[entity.collection].nodeType : entity.collection;
	return canSeeType(access, type) && canSeeClassification(access, entity.data.classification);
}

function adminUrl(collection: string, id: string): string {
	return `/_emdash/admin/content/${collection}/${id}`;
}

export function runSummary(run: RunView) {
	return {
		id: run.key,
		blueprint: run.blueprintCode,
		templateRevision: run.templateRevision,
		trigger: run.trigger,
		subject: formatSubject(run.subjectCollection, run.subjectKey),
		status: run.status,
		initiatedBy: run.initiatedBy,
		createdAt: run.createdAt,
		closedAt: run.closedAt,
		steps: run.steps,
	};
}

/** Everything the entity editor panel and `get_entity` show. */
export async function entityPanel(ctx: Ctx, reader: ContentReader, access: Access, collection: string, ref: string) {
	if (!isEntityCollection(collection)) return null;
	const state = await loadEntityState(ctx, reader, collection, ref, access.view);
	if (!state || !visibleEntity(access, state.entity)) return null;
	const type = ENTITY_TYPES[collection].nodeType;
	const operational = access.role >= ROLE.EDITOR;
	const content = ctx.content as { listRevisions?: (c: string, id: string, o?: { limit?: number }) => Promise<Array<{ id: string; createdAt: string }>> } | undefined;
	const [runs, revisions, openWork] = await Promise.all([
		operational ? runsForSubject(ctx, reader, state.entity.group) : Promise.resolve([]),
		operational && content?.listRevisions ? content.listRevisions(collection, state.entity.id, { limit: 20 }).catch(() => []) : Promise.resolve([]),
		operational ? reader.byField("work_items", "subject", [state.subject], "draft", 100) : Promise.resolve([]),
	]);
	const report = controlReport(state);
	return {
		subject: state.subject,
		id: state.entity.id,
		title: state.entity.title,
		status: state.entity.status,
		lifecycle: state.facts.lifecycle,
		classification: state.facts.classification,
		mergedInto: typeof state.entity.data.merged_into === "string" && state.entity.data.merged_into ? state.entity.data.merged_into : null,
		data: filterFields(access, type, state.entity.data),
		references: Object.fromEntries(Object.entries(state.facts.references).map(([k, v]) => [k, v.length])),
		identifiers: operational ? identifierReport(state) : state.identifiers.map((i) => ({ identifier: formatIdentifier(i), status: "reported" as const })),
		controls: report,
		exceptions: state.exceptions,
		evidence: operational ? state.evidence.map((e) => ({ id: e.id, attests: e.attests, identifier: e.identifier, digestVerified: e.digestVerified, createdAt: e.createdAt })) : [],
		dependants: state.dependants,
		runs: runs.map(runSummary),
		workItems: openWork.map((w) => ({ id: w.id, code: w.key, title: w.title, kind: w.data.work_kind, pillar: w.data.pillar, status: w.data.work_status, dueAt: w.data.due_at ?? null, requiredRole: w.data.required_role ?? null, adminUrl: adminUrl("work_items", w.id) })),
		// History is EmDash's: revisions here; who did what is in the audit log.
		revisions: revisions.map((r) => ({ id: r.id, at: r.createdAt })),
	};
}

/**
 * Duplicate detection before registration: identifiers already claimed, the same
 * code, and records with the same name. Read-only.
 */
export async function registrationCheck(
	ctx: Ctx,
	reader: ContentReader,
	access: Access,
	input: { collection: string; title: string; code?: string; identifiers?: unknown; subject?: string },
) {
	if (!isEntityCollection(input.collection)) return { ok: false, problems: ["Unknown entity type."], duplicates: [], identifiers: [] };
	const schema = await schemaStatus(reader);
	if (!schema.ok) return { ok: false, problems: [`This installation is missing the 1.2 content model (${schema.missing.slice(0, 3).join(", ")}…). Run scripts/migrate-1.2.sh.`], duplicates: [], identifiers: [] };
	const parsed = parseIdentifiers(input.identifiers);
	const problems = [...parsed.errors];
	const duplicates: Array<{ reason: string; subject: string; title: string | null; adminUrl: string | null }> = [];
	for (const c of await conflicts(reader, input.subject ?? null, parsed.identifiers)) {
		const at = c.holder.subject.indexOf(":");
		const hc = c.holder.subject.slice(0, at);
		const holder = isEntityCollection(hc) ? await reader.resolve(hc, c.holder.subject.slice(at + 1), "draft") : null;
		const visible = holder ? visibleEntity(access, holder) : false;
		duplicates.push({ reason: `${formatIdentifier(c.identifier)} is already registered`, subject: c.holder.subject, title: visible ? holder!.title : null, adminUrl: visible && holder ? adminUrl(holder.collection, holder.id) : null });
	}
	if (input.code) {
		const same = await reader.resolve(input.collection, input.code.trim().toUpperCase(), "draft");
		if (same && formatSubject(input.collection, same.key ?? same.id) !== input.subject) duplicates.push({ reason: `Code ${input.code.toUpperCase()} is taken`, subject: formatSubject(input.collection, same.key ?? same.id), title: visibleEntity(access, same) ? same.title : null, adminUrl: visibleEntity(access, same) ? adminUrl(same.collection, same.id) : null });
	}
	const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
	const wanted = norm(input.title);
	if (wanted) {
		for (const e of await reader.list(input.collection, "draft", 500)) {
			if (norm(e.title) === wanted && formatSubject(input.collection, e.key ?? e.id) !== input.subject) duplicates.push({ reason: "Same name", subject: formatSubject(input.collection, e.key ?? e.id), title: visibleEntity(access, e) ? e.title : null, adminUrl: visibleEntity(access, e) ? adminUrl(e.collection, e.id) : null });
		}
	}
	return { ok: problems.length === 0 && duplicates.length === 0, problems, duplicates, identifiers: parsed.identifiers.map(formatIdentifier) };
}

/** Records a registration form may link to (owner, products, services …), filtered for the caller. */
export async function registrationOptions(reader: ContentReader, access: Access) {
	const list = async (collection: "people" | "products" | "services" | "projects" | "clients" | "assets" | "software") =>
		(await reader.list(collection, "published", 300)).filter((e) => !isEntityCollection(e.collection) || visibleEntity(access, e)).map((e) => ({ id: e.id, key: e.key, title: e.title, lifecycle: (e.data.lifecycle as string | undefined) ?? null }));
	const [people, products, services, projects, clients, assets, software, blueprints] = await Promise.all([
		list("people"),
		list("products"),
		list("services"),
		list("projects"),
		list("clients"),
		access.role >= ROLE.EDITOR ? list("assets") : Promise.resolve([]),
		list("software"),
		access.role >= ROLE.EDITOR ? reader.list("blueprints", "draft", 100) : Promise.resolve([]),
	]);
	return {
		people,
		products,
		services,
		projects,
		clients,
		assets,
		software,
		blueprints: blueprints.map((b) => ({ code: b.key, title: b.title, target: b.data.target_collection ?? null, trigger: b.data.trigger ?? null, published: b.status === "published", hasDraft: b.hasPendingDraft || b.status !== "published" })),
		types: ENTITY_COLLECTIONS.map((c) => ({ collection: c, codePrefix: ENTITY_TYPES[c].codePrefix, defaultClassification: ENTITY_TYPES[c].defaultClassification })),
	};
}

/** The canonical service catalogue with its instances and who uses each service. */
export async function serviceCatalogue(ctx: Ctx, reader: ContentReader, access: Access) {
	const services = (await reader.list("services", access.view, 300)).filter((s) => visibleEntity(access, s));
	const out = [];
	for (const service of services) {
		// oxlint-disable-next-line no-await-in-loop -- one state per service; the catalogue is small
		const state = await loadEntityState(ctx, reader, "services", service.group, access.view);
		if (!state) continue;
		const refs = state.facts.references;
		const [instances, projects, products] = await Promise.all([
			reader.byGroups("service_instances", refs.instances ?? [], access.view),
			reader.byGroups("projects", refs.projects ?? [], "published"),
			reader.byGroups("products", refs.products ?? [], access.view),
		]);
		const report = controlReport(state);
		out.push({
			subject: state.subject,
			id: service.id,
			title: service.title,
			kind: service.data.service_kind ?? null,
			lifecycle: state.facts.lifecycle,
			classification: state.facts.classification,
			activationReady: report.activation.every((c) => c.status === "met" || c.status === "waived"),
			reviewCurrent: report.operation.every((c) => c.status === "met" || c.status === "waived"),
			instances: instances.filter((i) => visibleEntity(access, i)).map((i) => ({ code: i.key, title: i.title, environment: i.data.environment ?? null, lifecycle: i.data.lifecycle ?? null, adminUrl: adminUrl("service_instances", i.id) })),
			usedByProjects: projects.map((p) => ({ code: p.key, title: p.title })),
			usedByProducts: products.filter((p) => visibleEntity(access, p)).map((p) => ({ code: p.key, title: p.title })),
			adminUrl: adminUrl("services", service.id),
		});
	}
	return { services: out };
}

/** Blueprint runs, newest first, only for subjects the caller may see. */
export async function listRuns(ctx: Ctx, reader: ContentReader, access: Access, status?: string) {
	if (access.role < ROLE.EDITOR) return { runs: [] };
	const runs = [];
	for (const meta of (await allRuns(ctx)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100)) {
		// oxlint-disable-next-line no-await-in-loop
		const [subject] = await reader.byGroups(meta.subjectCollection, [meta.subjectGroup], "draft");
		if (!subject || !visibleEntity(access, subject)) continue;
		// oxlint-disable-next-line no-await-in-loop
		const view = await viewRun(ctx, reader, meta.key);
		if (!view || (status && view.status !== status)) continue;
		runs.push({ ...runSummary(view), subjectTitle: subject.title });
	}
	return { runs };
}

export async function openWorkItems(reader: ContentReader, access: Access) {
	if (access.role < ROLE.EDITOR) return { items: [] };
	const items = await reader.byField("work_items", "work_status", ["open"], "draft", 300);
	const out = [];
	for (const w of items) {
		const subject = typeof w.data.subject === "string" ? w.data.subject : null;
		if (subject) {
			const at = subject.indexOf(":");
			const collection = subject.slice(0, at);
			if (isEntityCollection(collection)) {
				// oxlint-disable-next-line no-await-in-loop
				const s = await reader.resolve(collection as EntityCollection, subject.slice(at + 1), "draft");
				if (s && !visibleEntity(access, s)) continue;
			}
		}
		out.push({ id: w.id, code: w.key, title: w.title, kind: w.data.work_kind, pillar: w.data.pillar ?? null, subject, dueAt: w.data.due_at ?? null, requiredRole: w.data.required_role ?? null, runId: w.data.run_id ?? null, adminUrl: adminUrl("work_items", w.id) });
	}
	out.sort((a, b) => String(a.dueAt ?? "9").localeCompare(String(b.dueAt ?? "9")));
	return { items: out };
}

/** Counts for the dashboard widget. */
export async function entitySummary(ctx: Ctx, reader: ContentReader, access: Access) {
	const counts: Record<string, Record<string, number>> = {};
	for (const collection of ENTITY_COLLECTIONS) {
		counts[collection] = {};
		// oxlint-disable-next-line no-await-in-loop
		for (const e of await reader.list(collection, "draft", 500)) {
			if (!visibleEntity(access, e)) continue;
			const key = e.status === "published" ? String(e.data.lifecycle ?? "intake") : "draft";
			counts[collection]![key] = (counts[collection]![key] ?? 0) + 1;
		}
	}
	const attention = access.role >= ROLE.EDITOR ? (await reader.byField("work_items", "work_kind", ["attention"], "draft", 200)).filter((w) => w.data.work_status === "open").length : 0;
	const work = access.role >= ROLE.EDITOR ? (await reader.byField("work_items", "work_status", ["open"], "draft", 500)).length : 0;
	return { counts, runsNeedingAttention: attention, openWorkItems: work, openRuns: access.role >= ROLE.EDITOR ? (await allRuns(ctx)).filter((r) => !r.closedAt).length : 0, schema: await schemaStatus(reader) };
}
