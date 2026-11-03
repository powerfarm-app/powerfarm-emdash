/**
 * Private plugin routes. EmDash authenticates every call and checks the declared
 * permission before a handler runs; the handlers then apply Powerfarm's own
 * access rules (access.ts). Routes that change recovery state are session-only:
 * they refuse API-token and MCP callers.
 */

import type { z } from "astro/zod";
import type { PluginRoute, RouteContext } from "emdash";
import { PluginRouteError } from "emdash";

import { accessFor, canSeeClassification } from "./access.js";
import { blocking, controlReport, loadEntityState } from "./controls.js";
import { CONTROL_ATTESTATIONS, CONTROLS, ENTITY_TYPES, type EntityCollection, formatSubject, isClassification, isEntityCollection } from "./entities.js";
import { entityPanel, entitySummary, listRuns, openWorkItems, registrationCheck, registrationOptions, runSummary, serviceCatalogue } from "./entity-services.js";
import { schemaStatus } from "./entity-tasks.js";
import { formatIdentifier, lookup, parseIdentifiers } from "./identity.js";
import { previewRun, runMeta, viewRun } from "./onboarding.js";
import { GraphService, type SearchFn } from "./graph.js";
import { acknowledgeDegraded } from "./journal.js";
import { listJobs, resolveInspection } from "./jobs.js";
import { completeManual, ManualRefusal, startManual } from "./manual.js";
import { ACTIVE_JOB_STATUSES, DEFAULTS, operationSpec, SETTINGS } from "./model.js";
import { getReader } from "./runtime.js";
import { S } from "./schemas.js";
import { assetDetail, columns, dashboard, evidencePanel, fleet, listCollection, operationPanel, procedurePanel, status } from "./services.js";

const emdashSearch: SearchFn = async (query, options) => {
	const emdash = (await import("emdash")) as unknown as { search: SearchFn };
	return emdash.search(query, options);
};

export function userOf(ctx: RouteContext): { id: string; role: number } | null {
	return ctx.user ? { id: ctx.user.id, role: ctx.user.role } : null;
}

/** Bearer-token callers (API tokens, MCP) are capped at the `tokenMaxClassification` setting. */
async function access(ctx: RouteContext, input: { includeDrafts?: boolean; revealIdentifiers?: boolean } = {}) {
	const token = !!ctx.request.headers.get("authorization");
	const cap = token ? ((await ctx.settings?.get<string>(SETTINGS.tokenMaxClassification)) ?? DEFAULTS.tokenMaxClassification) : undefined;
	return accessFor(userOf(ctx), input, { token, tokenMaxClassification: isClassification(cap) ? cap : "internal" });
}

async function graph(ctx: RouteContext, input: { includeDrafts?: boolean; revealIdentifiers?: boolean } = {}) {
	return new GraphService(ctx, await getReader(), await access(ctx, input), emdashSearch);
}

async function nodeId(g: GraphService, input: { node: string; type?: string }): Promise<string> {
	const id = input.type ? await g.resolve(input.type, input.node) : input.node.includes(":") ? input.node : null;
	if (!id) throw new PluginRouteError("NOT_FOUND", `No visible node matches "${input.node}". Give a node id, or a key with its type.`, 404);
	return id;
}

function need<T>(value: T | null | undefined, message: string): T {
	if (value === null || value === undefined) throw new PluginRouteError("NOT_FOUND", message, 404);
	return value;
}

/** Recovery-changing actions must come from a person's browser session, never a token or MCP. */
export function sessionUser(ctx: RouteContext): { id: string; role: number } {
	const user = userOf(ctx);
	if (!user) throw new PluginRouteError("UNAUTHORIZED", "Sign in to the EmDash admin.", 401);
	if (ctx.request.headers.get("authorization")) throw new PluginRouteError("SESSION_REQUIRED", "This action is only available in the EmDash admin, not to API tokens or AI clients.", 403);
	return user;
}

function read<T extends z.ZodType>(schema: T, handler: (ctx: RouteContext, input: z.infer<T>) => Promise<unknown>): PluginRoute {
	return { permission: "content:read", input: schema, handler: (ctx) => handler(ctx, ctx.input as z.infer<T>) };
}

export function apiRoutes(): Record<string, PluginRoute> {
	return {
		// ---- Institution and graph ------------------------------------------------------
		status: read(S.flags, async (ctx, i) => status(ctx, await getReader(), await access(ctx, i))),
		"graph/search": read(S.search, async (ctx, i) => ({ results: await (await graph(ctx, i)).search(i.query, { types: i.types, limit: i.limit }) })),
		"graph/node": read(S.nodeRef, async (ctx, i) => {
			const g = await graph(ctx, i);
			return need(await g.getNode(await nodeId(g, i)), "Not found");
		}),
		"graph/neighbours": read(S.neighbours, async (ctx, i) => {
			const g = await graph(ctx, i);
			return need(await g.neighbours(await nodeId(g, i), i), "Not found");
		}),
		"graph/trace": read(S.trace, async (ctx, i) => {
			const g = await graph(ctx, i);
			return need(await g.trace(await nodeId(g, i), i), "Not found");
		}),
		"graph/history": read(S.nodeRef, async (ctx, i) => {
			const g = await graph(ctx, i);
			return need(await g.history(await nodeId(g, i)), "Not found");
		}),
		"graph/provenance": read(S.nodeRef, async (ctx, i) => {
			const g = await graph(ctx, i);
			return need(await g.provenance(await nodeId(g, i)), "Not found");
		}),
		"knowledge/search": read(S.knowledge, async (ctx, i) => (await graph(ctx, i)).context(i.query, { types: i.types, limit: i.limit })),

		// ---- Mission 001 -------------------------------------------------------------
		fleet: read(S.flags, async (ctx, i) => fleet(ctx, await getReader(), await access(ctx, i))),
		asset: read(S.asset, async (ctx, i) => need(await assetDetail(ctx, await getReader(), await access(ctx, i), i.assetTag), `No asset ${i.assetTag}`)),
		"open-jobs": read(S.flags, async (ctx, i) => {
			const a = await access(ctx, i);
			if (a.role < 40) return { jobs: [] };
			const jobs = await listJobs(ctx, { status: { in: [...ACTIVE_JOB_STATUSES, "needs_inspection"] } }, 200);
			return { jobs: jobs.filter((j) => j.status !== "needs_inspection" || !j.inspection).map((j) => ({ id: j.id, opCode: j.opCode, assetTag: j.assetTag, operation: j.operation, status: j.status, executionMode: j.executionMode, claimedBy: j.claimedBy, updatedAt: j.updatedAt, lastMessage: j.lastMessage, adapter: operationSpec(j.operation)?.adapter })) };
		}),
		"next-action": read(S.asset, async (ctx, i) => need(await assetDetail(ctx, await getReader(), await access(ctx, i), i.assetTag), `No asset ${i.assetTag}`).next),
		procedure: read(S.procedure, async (ctx, i) => need(await procedurePanel(ctx, await getReader(), i.code), `No procedure ${i.code}`)),
		verification: read(S.asset, async (ctx, i) => {
			const d = need(await assetDetail(ctx, await getReader(), await access(ctx, i), i.assetTag), `No asset ${i.assetTag}`);
			return { assetTag: d.assetTag, status: d.status, reasons: d.reasons, lastVerifiedAt: d.lastVerifiedAt, checklist: d.checklist };
		}),
		evidence: read(S.evidence, async (ctx, i) => {
			const a = await access(ctx, i);
			if (a.role < 40) throw new PluginRouteError("FORBIDDEN", "Evidence is available to editors and administrators.", 403);
			const reader = await getReader();
			if (i.evidenceId) return need(await evidencePanel(ctx, reader, a, i.evidenceId), "No such evidence");
			const field = i.opCode ? "op_code" : "asset_tag";
			const value = (i.opCode ?? i.assetTag ?? "").toUpperCase();
			if (!value) throw new PluginRouteError("INVALID_INPUT", "Give assetTag, opCode or evidenceId.", 400);
			const items = await reader.byField("evidence", field, [value], "draft", 100);
			return { items: await Promise.all(items.map((e) => evidencePanel(ctx, reader, a, e.group))) };
		}),
		dashboard: read(S.flags, async (ctx, i) => dashboard(ctx, await getReader(), await access(ctx, i))),
		"panel/asset": read(S.panel, async (ctx, i) => need(await assetDetail(ctx, await getReader(), await access(ctx, i), i.id), "Not found")),
		"panel/operation": read(S.panel, async (ctx, i) => {
			if ((await access(ctx, i)).role < 40) throw new PluginRouteError("FORBIDDEN", "Editors only.", 403);
			return need(await operationPanel(ctx, await getReader(), await access(ctx, i), userOf(ctx), i.id), "Not found");
		}),
		"panel/procedure": read(S.panel, async (ctx, i) => need(await procedurePanel(ctx, await getReader(), i.id), "Not found")),
		"panel/evidence": read(S.panel, async (ctx, i) => {
			if ((await access(ctx, i)).role < 40) throw new PluginRouteError("FORBIDDEN", "Editors only.", 403);
			return need(await evidencePanel(ctx, await getReader(), await access(ctx, i), i.id), "Not found");
		}),
		columns: read(S.columns, async (ctx, i) => {
			if (i.collection !== "procedures" && (await access(ctx)).role < 40) return {};
			return columns(ctx, await getReader(), await access(ctx), i.collection, i.ids);
		}),

		// ---- Engineering ---------------------------------------------------------------
		"engineering/projects": read(S.list, async (ctx, i) => ({ items: await listCollection(await getReader(), await access(ctx, i), "projects", i.limit) })),
		"engineering/requirements": read(S.list, async (ctx, i) => ({ items: await listCollection(await getReader(), await access(ctx, i), "requirements", i.limit) })),
		"engineering/decisions": read(S.list, async (ctx, i) => ({ items: await listCollection(await getReader(), await access(ctx, i), "decisions", i.limit) })),
		"engineering/software": read(S.list, async (ctx, i) => ({ items: await listCollection(await getReader(), await access(ctx, i), "software", i.limit) })),
		"engineering/tests-releases": read(S.list, async (ctx, i) => {
			const reader = await getReader();
			const a = await access(ctx, i);
			return { tests: await listCollection(reader, a, "tests", i.limit), releases: await listCollection(reader, a, "releases", i.limit) };
		}),

		// ---- Drafts (people and AI clients; never approval) ------------------------------
		"drafts/recovery-operation": {
			permission: "content:create",
			input: S.prepare,
			handler: async (ctx) => {
				const i = ctx.input as z.infer<typeof S.prepare>;
				const reader = await getReader();
				const asset = need(await reader.resolve("assets", i.assetTag, "published"), `No asset ${i.assetTag}`);
				const procedure = need(await reader.resolve("procedures", i.procedureCode, "published"), `No procedure ${i.procedureCode}`);
				const spec = operationSpec(procedure.data.operation);
				if (!spec) throw new PluginRouteError("INVALID_INPUT", `${procedure.key} is guidance only and cannot be an operation.`, 400);
				if (!ctx.content?.create) throw new PluginRouteError("NOT_AVAILABLE", "content:write is not granted", 500);
				const created = await ctx.content.create("recovery_operations", {
					title: `${procedure.title} — ${asset.title}`,
					asset_tag: asset.key,
					procedure_code: procedure.key,
					mission_code: i.missionCode.toUpperCase(),
					operation: procedure.data.operation,
					parameters: i.parameters ?? {},
					dry_run: i.dryRun,
					data_decision: i.dataDecision ?? null,
					backup_op_code: i.backupOpCode ?? null,
					risk: spec.destructive ? "destructive" : spec.class === "read" ? "low" : "medium",
					rationale: i.rationale,
					physical_checklist: typeof procedure.data.physical_steps === "string" ? procedure.data.physical_steps : null,
					prepared_by_ai: true,
				});
				return { id: created.id, opCode: created.data.op_code ?? null, status: created.status, note: "Created as a draft. A person must review it and publish it in the EmDash admin to approve it." };
			},
		},
		"drafts/content": {
			permission: "content:create",
			input: S.propose,
			handler: async (ctx) => {
				const i = ctx.input as z.infer<typeof S.propose>;
				if (!ctx.content?.create) throw new PluginRouteError("NOT_AVAILABLE", "content:write is not granted", 500);
				const created = await ctx.content.create(i.collection, i.data);
				return { id: created.id, collection: i.collection, status: created.status, note: "Created as a draft for a person to review and publish." };
			},
		},

		// ---- Session-only recovery actions -------------------------------------------------
		"jobs/resolve-inspection": {
			permission: "content:publish_any",
			input: S.resolveInspection,
			handler: async (ctx) => {
				const i = ctx.input as z.infer<typeof S.resolveInspection>;
				const result = await resolveInspection(ctx, i.jobId, sessionUser(ctx), i.finding, i.note);
				if ("error" in result) throw new PluginRouteError("REFUSED", result.error, 409);
				return { status: result.status, inspection: result.inspection };
			},
		},
		"jobs/manual-start": {
			permission: "content:publish_any",
			input: S.manualStart,
			handler: async (ctx) => {
				try {
					const job = await startManual(ctx, sessionUser(ctx), (ctx.input as z.infer<typeof S.manualStart>).jobId);
					return { status: job.status };
				} catch (e) {
					if (e instanceof ManualRefusal) throw new PluginRouteError("REFUSED", e.message, e.status);
					throw e;
				}
			},
		},
		"jobs/manual-complete": {
			permission: "content:publish_any",
			input: S.manualComplete,
			handler: async (ctx) => {
				const i = ctx.input as z.infer<typeof S.manualComplete>;
				try {
					const job = await completeManual(ctx, await getReader(), sessionUser(ctx), i.jobId, i);
					return { status: job.status, identity: job.result?.identity ?? null };
				} catch (e) {
					if (e instanceof ManualRefusal) throw new PluginRouteError("REFUSED", e.message, e.status);
					throw e;
				}
			},
		},
		"audit/acknowledge": {
			permission: "plugins:manage",
			input: S.acknowledge,
			handler: async (ctx) => acknowledgeDegraded(ctx, `user:${sessionUser(ctx).id}`),
		},

		// ---- 1.2 entities ---------------------------------------------------------------
		"entities/panel": read(S.entity, async (ctx, i) => need(await entityPanel(ctx, await getReader(), await access(ctx, i), i.collection, i.ref), "Not found or not visible to you")),
		"entities/columns": read(S.entityColumns, async (ctx, i) => {
			const reader = await getReader();
			const a = await access(ctx);
			const out: Record<string, Record<string, unknown>> = {};
			for (const id of i.ids) {
				// oxlint-disable-next-line no-await-in-loop -- one visible page of a list
				const state = await loadEntityState(ctx, reader, i.collection, id, "draft");
				if (!state || !canSeeClassification(a, state.facts.classification)) continue;
				const report = controlReport(state);
				const gaps = blocking(state.facts.lifecycle === "active" ? report.operation : report.activation);
				out[id] = { lifecycle: state.facts.lifecycle, classification: state.facts.classification, readiness: gaps.length === 0 ? (state.facts.lifecycle === "active" ? "healthy" : "ready") : `${gaps.length} open` };
			}
			return out;
		}),
		"entities/check": read(S.registrationCheck, async (ctx, i) => registrationCheck(ctx, await getReader(), await access(ctx), i)),
		"entities/options": read(S.flags, async (ctx, i) => registrationOptions(await getReader(), await access(ctx, i))),
		"entities/summary": read(S.flags, async (ctx, i) => entitySummary(ctx, await getReader(), await access(ctx, i))),
		"entities/controls": read(S.none, async () => ({ controls: CONTROLS, attestations: CONTROL_ATTESTATIONS })),
		"entities/propose": {
			permission: "content:create",
			input: S.proposeEntity,
			handler: async (ctx) => {
				const i = ctx.input as z.infer<typeof S.proposeEntity>;
				if (!ctx.content?.create) throw new PluginRouteError("NOT_AVAILABLE", "content:write is not granted", 500);
				const schema = await schemaStatus(await getReader());
				if (!schema.ok) throw new PluginRouteError("SCHEMA_OUTDATED", "This installation does not have the 1.2 content model yet.", 409);
				const blocked = Object.keys(i.fields ?? {}).filter((k) => PROTECTED_FIELDS.has(k));
				if (blocked.length) throw new PluginRouteError("INVALID_INPUT", `These fields are set by people or by Powerfarm, not proposed: ${blocked.join(", ")}.`, 400);
				const created = await ctx.content.create(i.collection, {
					...(i.fields ?? {}),
					title: i.title,
					description: i.description ?? null,
					classification: i.classification ?? ENTITY_TYPES[i.collection as EntityCollection].defaultClassification,
					identifiers: i.identifiers ?? [],
					lifecycle: "intake",
					prepared_by_ai: true,
				});
				return { id: created.id, code: created.data.code ?? null, status: created.status, note: "Created as an unpublished draft. A person reviews it, sets the owner and relations, and publishes it to register it." };
			},
		},
		"services/catalogue": read(S.flags, async (ctx, i) => serviceCatalogue(ctx, await getReader(), await access(ctx, i))),

		// ---- 1.2 automation ---------------------------------------------------------------
		"automation/runs": read(S.runs, async (ctx, i) => listRuns(ctx, await getReader(), await access(ctx), i.status)),
		"automation/run": read(S.run, async (ctx, i) => {
			const a = await access(ctx);
			const meta = a.role >= 40 ? await runMeta(ctx, i.runId) : null;
			if (!meta) throw new PluginRouteError("NOT_FOUND", "No such run.", 404);
			const reader = await getReader();
			const [subject] = await reader.byGroups(meta.subjectCollection, [meta.subjectGroup], "draft");
			if (!subject || !canSeeClassification(a, subject.data.classification)) throw new PluginRouteError("NOT_FOUND", "No such run.", 404);
			const view = await viewRun(ctx, reader, i.runId);
			return { ...runSummary(view!), definition: view!.definition };
		}),
		"automation/work": read(S.flags, async (ctx, i) => openWorkItems(await getReader(), await access(ctx, i))),
		"automation/preview": read(S.preview, async (ctx, i) => {
			const a = await access(ctx);
			if (a.role < 40) throw new PluginRouteError("FORBIDDEN", "Editors only.", 403);
			const reader = await getReader();
			const blueprint = need(await reader.resolve("blueprints", i.blueprint, i.useDraft ? "draft" : "published"), `No ${i.useDraft ? "" : "published "}blueprint ${i.blueprint}`);
			const subject = await reader.resolve(i.collection as EntityCollection, i.subject, "draft");
			if (!subject || !canSeeClassification(a, subject.data.classification)) throw new PluginRouteError("NOT_FOUND", "Subject not found.", 404);
			return previewRun(reader, blueprint, i.collection, i.subject);
		}),
		// ---- 1.2 identity -----------------------------------------------------------------
		"identity/lookup": read(S.identityLookup, async (ctx, i) => {
			const a = await access(ctx);
			if (a.role < 40) throw new PluginRouteError("FORBIDDEN", "Editors only.", 403);
			const parsed = parseIdentifiers([i]);
			if (parsed.errors.length) throw new PluginRouteError("INVALID_INPUT", parsed.errors.join(" "), 400);
			const reader = await getReader();
			const claim = await lookup(reader, parsed.identifiers[0]!);
			if (!claim) return { identifier: formatIdentifier(parsed.identifiers[0]!), holder: null };
			const at = claim.subject.indexOf(":");
			const hc = claim.subject.slice(0, at);
			const holder = isEntityCollection(hc) ? await reader.resolve(hc, claim.subject.slice(at + 1), "draft") : null;
			const visible = !holder || canSeeClassification(a, holder.data.classification);
			return { identifier: formatIdentifier(parsed.identifiers[0]!), holder: visible ? claim.subject : "a record you cannot see", source: claim.source, entry: visible ? `/_emdash/admin/content/identifiers/${claim.id}` : null };
		}),
	};
}

/** Fields an AI proposal may not set: they belong to people (approval) or to Powerfarm. */
const PROTECTED_FIELDS = new Set(["lifecycle", "origin", "prepared_by_ai", "code", "identifiers", "classification", "secret_refs", "document", "merged_into", "merge_rationale"]);

const RO = "Read-only.";

/** MCP tools. EmDash exposes them as `powerfarm__<name>`; a token needs `mcp:tools:powerfarm`. */
export function mcpTools() {
	const t = (description: string, route: string, input: z.ZodType, destructive = false) => ({ description, route, input, destructive });
	return {
		get_status: t(`Platform status: Mission 001 summary, audit integrity, bridge health, scheduled-task health. ${RO}`, "status", S.flags),
		graph_search: t(`Find Powerfarm Graph entities by key (LAB-8GB, OP-0007, P-VERIFY) or text. Published content only unless an editor asks for drafts. ${RO}`, "graph/search", S.search),
		graph_get_entity: t(`One graph entity with its permitted fields. Hardware identifiers are masked. ${RO}`, "graph/node", S.nodeRef),
		graph_get_neighbours: t(`An entity's relationships, paged, with direction, type and state (published, proposed, historical). ${RO}`, "graph/neighbours", S.neighbours),
		graph_trace_dependencies: t(`Walk relationships from an entity up to 4 hops, bounded. ${RO}`, "graph/trace", S.trace),
		graph_get_history: t(`The operational journal for an asset, operation or job, newest first. ${RO}`, "graph/history", S.nodeRef),
		graph_get_provenance: t(`Where an entity came from: EmDash revisions, author, evidence and journal. ${RO}`, "graph/provenance", S.nodeRef),
		search_knowledge: t(`Search EmDash content, follow graph relationships, and return a source-linked context package. ${RO}`, "knowledge/search", S.knowledge),
		get_fleet: t(`Every asset with its derived status, blockers and next action. ${RO}`, "fleet", S.flags),
		get_asset: t(`One asset's record, status, checklist, operations, jobs and evidence. ${RO}`, "asset", S.asset),
		get_open_recovery_jobs: t(`Approved, claimed, running and needs-inspection jobs. ${RO}`, "open-jobs", S.flags),
		get_next_physical_action: t(`What a person must physically do next for an asset, with precise instructions. ${RO}`, "next-action", S.asset),
		get_recovery_procedure: t(`A procedure's preconditions, tools, operator actions, expected results, evidence and failure handling. ${RO}`, "procedure", S.procedure),
		get_verification_status: t(`The Mission 001 acceptance checklist for an asset. ${RO}`, "verification", S.asset),
		get_evidence: t(`Evidence metadata and digests for an asset or operation (no file contents). ${RO}`, "evidence", S.evidence),
		get_projects: t(`Engineering projects. ${RO}`, "engineering/projects", S.list),
		get_requirements: t(`Requirements. ${RO}`, "engineering/requirements", S.list),
		get_architecture_decisions: t(`Architecture decision records. ${RO}`, "engineering/decisions", S.list),
		get_software_components: t(`Software, tools and components. ${RO}`, "engineering/software", S.list),
		get_tests_and_releases: t(`Tests with their last results, and releases. ${RO}`, "engineering/tests-releases", S.list),
		prepare_recovery_operation: t(
			"Draft a recovery operation for a person to review. It is created unpublished; only a person can approve it by publishing it in the EmDash admin.",
			"drafts/recovery-operation",
			S.prepare,
		),
		propose_draft: t("Draft research, a requirement, an architecture decision, a procedure or a test, for a person to review and publish.", "drafts/content", S.propose),
		// 1.2
		get_entity: t(`A client, product, service, service instance or contract: lifecycle, classification, identifiers and their status, controls per stage, open work, runs and history. Confidential and restricted records are hidden from AI clients by default. ${RO}`, "entities/panel", S.entity),
		check_registration: t(`Before proposing a new record: which identifiers, codes or names already exist. ${RO}`, "entities/check", S.registrationCheck),
		propose_entity: t(
			"Draft a new client, product, service, service instance or contract for a person to review. It is created unpublished, as intake, marked as prepared by AI. Only a person registers it by publishing; owners and relations are set by people.",
			"entities/propose",
			S.proposeEntity,
		),
		get_service_catalogue: t(`The canonical service catalogue: each service, its instances, and the projects and products that use it. ${RO}`, "services/catalogue", S.flags),
		get_open_work_items: t(`Open tasks, approvals and link requests created by blueprints or people. ${RO}`, "automation/work", S.flags),
		get_blueprint_runs: t(`Onboarding blueprint runs and their steps. ${RO}`, "automation/runs", S.runs),
		preview_blueprint: t(`Simulate a blueprint against a record: what each step would do. Writes nothing and never counts as a run. ${RO}`, "automation/preview", S.preview),
		get_control_catalogue: t(`The lifecycle controls and which attestations satisfy them. ${RO}`, "entities/controls", S.none),
	};
}
