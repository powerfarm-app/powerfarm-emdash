/**
 * Read models for the admin (dashboard widgets, editor panels, list columns,
 * workspace pages) and the MCP tools. Every value comes from EmDash content,
 * Powerfarm jobs and the journal; nothing here is decorative or hardcoded.
 */

import type { PluginContext, StorageCollection } from "emdash";

import { type Access, filterFields, mask } from "./access.js";
import type { ContentReader, Entity } from "./content.js";
import { missingEvidence } from "./evidence.js";
import { assetFactsOf, evidenceFactsOf, loadAssets, loadEvidence, missionScope, operationFactsOf } from "./facts.js";
import { auditState, type JournalEntry } from "./journal.js";
import { listJobs, readSettings, type Ctx } from "./jobs.js";
import { type Job, MISSION_001, OPERATIONS, operationSpec, PLUGIN_VERSION, ROLE } from "./model.js";
import { acceptanceChecklist, approvalViolations, type AssetFacts, assetProgress, deriveStatus, type EvidenceFacts, nextAction } from "./recovery.js";
import { taskHealth } from "./reconcile.js";

export const EMDASH_REVISION = "981c78d5d347428e77afd27b7582924607754503";

type ServiceCtx = Ctx & Pick<PluginContext, "storage">;

function jobSummary(job: Job, access: Access) {
	return {
		id: job.id,
		opId: job.opId,
		opCode: job.opCode,
		opRevision: job.opRevision,
		assetTag: job.assetTag,
		operation: job.operation,
		status: job.status,
		executionMode: job.executionMode,
		dryRun: job.dryRun,
		destructive: job.destructive,
		claimedBy: job.claimedBy,
		leaseExpiresAt: job.leaseExpiresAt,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		updatedAt: job.updatedAt,
		lastMessage: job.lastMessage,
		evidence: job.evidence.map((e) => ({ kind: e.kind, evidenceId: e.evidenceId, sha256: e.sha256 })),
		missingEvidence: missingEvidence(job),
		identity: (job.result?.identity as unknown) ?? null,
		inspection: job.inspection,
		auditGap: job.auditGap,
		ecid: job.ecid ? (access.revealIdentifiers ? job.ecid : mask(job.ecid)) : null,
	};
}

export interface AssetView {
	assetTag: string;
	title: string;
	id: string;
	deviceClass: string | null;
	role: string | null;
	inMission: boolean;
	status: string;
	reasons: string[];
	lastVerifiedAt: string | null;
	missing: string[];
	blocker: string | null;
	next: ReturnType<typeof nextAction>;
	activeJobs: ReturnType<typeof jobSummary>[];
}

async function fleetFacts(ctx: ServiceCtx, reader: ContentReader) {
	const [{ facts, entities }, jobs, audit, settings] = await Promise.all([loadAssets(reader), listJobs(ctx, {}, 2000), auditState(ctx), readSettings(ctx)]);
	const evidence = await loadEvidence(reader, facts.map((f) => f.assetTag));
	return { facts, entities, jobs, evidence, audit, settings };
}

function viewOf(asset: AssetFacts, entity: Entity, jobs: Job[], evidence: EvidenceFacts[], auditDegraded: boolean, hostTag: string, access: Access): AssetView & { checklist: ReturnType<typeof acceptanceChecklist> } {
	const progress = assetProgress(asset, jobs, evidence);
	const status = deriveStatus(asset, progress, auditDegraded);
	const next = nextAction(asset, status, progress, hostTag);
	const checklist = acceptanceChecklist(asset, progress, status, auditDegraded);
	return {
		assetTag: asset.assetTag,
		title: asset.title,
		id: entity.id,
		deviceClass: asset.deviceClass,
		role: asset.role,
		inMission: asset.inMission,
		status: status.status,
		reasons: status.reasons,
		lastVerifiedAt: status.lastVerifiedAt,
		missing: asset.role === "comms_terminal" ? [] : checklist.checks.filter((c) => !c.pass).map((c) => c.check),
		blocker: next.blocking,
		next,
		activeJobs: progress.active.map((j) => jobSummary(j, access)),
		checklist,
	};
}

export async function fleet(ctx: ServiceCtx, reader: ContentReader, access: Access) {
	const f = await fleetFacts(ctx, reader);
	const assets = f.facts.map((a, i) => viewOf(a, f.entities[i]!, f.jobs, f.evidence, f.audit.degraded, f.settings.hostAssetTag, access));
	const targets = assets.filter((a) => a.inMission && a.role !== "comms_terminal");
	return {
		mission: MISSION_001,
		auditDegraded: f.audit.degraded,
		targets: targets.length,
		trusted: targets.filter((a) => a.status === "trusted").length,
		complete: targets.length === 6 && targets.every((a) => a.checklist.passed),
		assets: assets.map(({ checklist, ...rest }) => ({ ...rest, activeJobs: access.role >= ROLE.EDITOR ? rest.activeJobs : [], acceptancePassed: checklist.passed })),
	};
}

export async function assetDetail(ctx: ServiceCtx, reader: ContentReader, access: Access, ref: string) {
	const entity = await reader.resolve("assets", ref, "published");
	if (!entity) return null;
	const scope = await missionScope(reader);
	const facts = assetFactsOf(entity, scope.assetGroups);
	const [jobs, evidence, audit, settings] = await Promise.all([listJobs(ctx, { assetTag: facts.assetTag }, 500), loadEvidence(reader, [facts.assetTag]), auditState(ctx), readSettings(ctx)]);
	const view = viewOf(facts, entity, jobs, evidence, audit.degraded, settings.hostAssetTag, access);
	const operations = (await reader.byField("recovery_operations", "asset_tag", [facts.assetTag], access.view, 100)).map((op) => ({
		id: op.id,
		opCode: op.key,
		title: op.title,
		status: op.status,
		state: op.state,
		operation: op.data.operation,
		dryRun: op.data.dry_run,
	}));
	const operational = access.role >= ROLE.EDITOR;
	return {
		asset: { id: entity.id, title: entity.title, assetTag: facts.assetTag, ...filterFields(access, "asset", { model: entity.data.model, model_year: entity.data.model_year, color: entity.data.color, chip: entity.data.chip, device_class: facts.deviceClass, role: facts.role, os_at_intake: entity.data.os_at_intake, os_policy: facts.osPolicy, serial_number: facts.serialNumber, ecid: facts.ecid }) },
		...view,
		// Operational records are for editors and administrators only.
		activeJobs: operational ? view.activeJobs : [],
		operations: operational ? operations : [],
		jobs: operational ? jobs.slice(0, 50).map((j) => jobSummary(j, access)) : [],
		evidence: operational ? evidence.slice(0, 50).map((e) => ({ id: e.id, type: e.evidenceType, attests: e.attests, opCode: e.opCode, createdAt: e.createdAt, digestVerified: e.digestVerified })) : [],
	};
}

export async function operationPanel(ctx: ServiceCtx, reader: ContentReader, access: Access, user: { id: string; role: number } | null, ref: string) {
	const op = await reader.resolve("recovery_operations", ref, "draft");
	if (!op) return null;
	const data = op.data;
	const [asset, procedure, settings, audit] = await Promise.all([
		typeof data.asset_tag === "string" ? reader.resolve("assets", data.asset_tag, "published") : Promise.resolve(null),
		typeof data.procedure_code === "string" ? reader.resolve("procedures", data.procedure_code, "published") : Promise.resolve(null),
		readSettings(ctx),
		auditState(ctx),
	]);
	const scope = await missionScope(reader, typeof data.mission_code === "string" ? data.mission_code : undefined);
	const assetFacts = asset ? assetFactsOf(asset, scope.assetGroups) : null;
	const backup = typeof data.backup_op_code === "string" && data.backup_op_code ? await reader.resolve("recovery_operations", data.backup_op_code, "published") : null;
	const [jobsForAsset, evidenceForAsset, backupJobs, ownJobs] = await Promise.all([
		assetFacts ? listJobs(ctx, { assetTag: assetFacts.assetTag }, 500) : Promise.resolve([]),
		assetFacts ? loadEvidence(reader, [assetFacts.assetTag]) : Promise.resolve([]),
		backup ? listJobs(ctx, { opId: backup.id }, 50) : Promise.resolve([]),
		listJobs(ctx, { opId: op.id }, 50),
	]);
	// What would stop a publish by this user right now.
	const blockers = user
		? approvalViolations({
				origin: "api",
				actor: user,
				authorId: op.authorId,
				settings,
				op: data,
				asset: assetFacts,
				procedure: procedure ? { code: procedure.key ?? procedure.id, operation: String(procedure.data.operation ?? ""), deviceClasses: (procedure.data.device_classes as string[]) ?? [] } : null,
				missionExists: !!scope.mission,
				jobsForAsset,
				evidenceForAsset,
				backupOp: backup ? operationFactsOf(backup) : null,
				backupJobs,
				auditDegraded: audit.degraded,
			})
		: [];
	const spec = operationSpec(data.operation);
	const approval = await ctx.kv.get<{ actorId: string; at: string }>(`approval:${op.id}`);
	const evidence = typeof data.op_code === "string" ? (await reader.byField("evidence", "op_code", [data.op_code], "draft", 100)).map(evidenceFactsOf) : [];
	return {
		opCode: op.key,
		status: op.status,
		pendingDraft: op.hasPendingDraft,
		liveRevision: op.liveRevisionId,
		draftRevision: op.draftRevisionId,
		approval: op.status === "published" ? { approvedBy: approval?.actorId ?? null, approvedAt: approval?.at ?? null } : null,
		preparedByAi: data.prepared_by_ai === true,
		target: assetFacts ? { assetTag: assetFacts.assetTag, deviceClass: assetFacts.deviceClass, inMission: assetFacts.inMission } : null,
		procedure: procedure ? { code: procedure.key, title: procedure.title } : null,
		operation: data.operation,
		adapter: spec?.adapter ?? null,
		operationClass: spec?.class ?? null,
		destructive: !!spec?.destructive && data.dry_run !== true,
		dryRun: data.dry_run === true,
		dataDecision: data.data_decision ?? null,
		risk: data.risk ?? null,
		safeguards: spec ? [...(spec.destructive ? ["Administrator approval", "Data-preservation decision", "Typed confirmation at the bridge", "One active job per device"] : []), ...(spec.adapter === "bridge" ? ["Validated on the bridge host", "Device pinned by ECID"] : ["Performed by a person; outcome recorded"])] : [],
		requiredEvidence: spec ? [...spec.requiredEvidence] : [],
		blockers,
		jobs: ownJobs.map((j) => jobSummary(j, access)),
		evidence: evidence.map((e) => ({ id: e.id, type: e.evidenceType, attests: e.attests, digestVerified: e.digestVerified, sha256: e.sha256, createdAt: e.createdAt })),
	};
}

export async function procedurePanel(ctx: ServiceCtx, reader: ContentReader, ref: string) {
	const p = await reader.resolve("procedures", ref, "published");
	if (!p) return null;
	const spec = operationSpec(p.data.operation);
	const bridges = (ctx.storage as Record<string, StorageCollection<{ validatedOperations?: string[]; status?: string }>>).bridges!;
	const page = await bridges.query({ limit: 10 });
	const validatedOn = page.items.filter((b) => b.data.validatedOperations?.includes(String(p.data.operation))).map((b) => b.id);
	return {
		code: p.key,
		title: p.title,
		operation: p.data.operation,
		deviceClasses: p.data.device_classes ?? [],
		adapter: spec?.adapter ?? "guidance",
		destructive: spec?.destructive ?? false,
		validatedOn,
		adapterReady: spec?.adapter === "manual" ? true : validatedOn.length > 0,
		preconditions: p.data.preconditions ?? null,
		requiredTools: p.data.required_tools ?? null,
		physicalSteps: p.data.physical_steps ?? null,
		expectedResults: p.data.expected_results ?? null,
		requiredEvidence: p.data.required_evidence ?? spec?.requiredEvidence ?? [],
		failureInstructions: p.data.failure_instructions ?? null,
	};
}

export async function evidencePanel(ctx: ServiceCtx, reader: ContentReader, access: Access, ref: string) {
	const [e] = await reader.byGroups("evidence", [ref], "draft");
	const entity = e ?? (await reader.resolve("evidence", ref, "draft"));
	if (!entity) return null;
	const page = await (ctx.storage as Record<string, StorageCollection<JournalEntry>>).journal!.query({ where: { jobId: String(entity.data.job_id ?? "") }, limit: 20 });
	const provenance = page.items.map((i) => i.data).filter((j) => j.evidenceIds.includes(entity.id));
	return {
		title: entity.title,
		type: entity.data.evidence_type,
		attests: entity.data.attests ?? null,
		assetTag: entity.data.asset_tag ?? null,
		opCode: entity.data.op_code ?? null,
		jobId: entity.data.job_id ?? null,
		opRevision: entity.data.op_revision ?? null,
		originalFilename: entity.data.original_filename ?? null,
		mediaId: entity.data.media_id ? (access.revealIdentifiers ? entity.data.media_id : mask(String(entity.data.media_id))) : null,
		sha256: entity.data.sha256 ?? null,
		sizeBytes: entity.data.size_bytes ?? null,
		mimeType: entity.data.mime_type ?? null,
		createdAt: entity.createdAt,
		digestStatus: entity.data.digest_status ?? "none",
		executionMode: entity.data.execution_mode ?? null,
		signedBy: entity.data.signed_by ?? null,
		provenance: provenance.map((p) => ({ eventId: p.eventId, type: p.type, at: p.at, actor: p.actor, hash: p.hash })),
	};
}

/** Batched cells for EmDash content-list columns. */
export async function columns(ctx: ServiceCtx, reader: ContentReader, access: Access, collection: string, ids: string[]) {
	const out: Record<string, Record<string, unknown>> = {};
	if (collection === "assets") {
		const f = await fleetFacts(ctx, reader);
		f.facts.forEach((a, i) => {
			const entity = f.entities[i]!;
			if (!ids.includes(entity.id)) return;
			const v = viewOf(a, entity, f.jobs, f.evidence, f.audit.degraded, f.settings.hostAssetTag, access);
			out[entity.id] = { mission: a.inMission ? MISSION_001 : a.role === "comms_terminal" ? "comms terminal" : "—", readiness: v.status, lastVerified: v.lastVerifiedAt, missing: v.missing.length, blocker: v.blocker };
		});
		// Draft assets that are not yet published.
		for (const id of ids) out[id] ??= { readiness: "unpublished" };
	} else if (collection === "recovery_operations") {
		const rows = await reader.readPort.rows("recovery_operations", { ids, limit: ids.length });
		for (const row of rows) {
			const spec = operationSpec(row.operation);
			// oxlint-disable-next-line no-await-in-loop -- one page of rows
			const jobs = await listJobs(ctx, { opId: row.id }, 5);
			const latest = jobs[0];
			out[row.id] = {
				target: row.asset_tag,
				class: spec?.class ?? "guidance",
				risk: row.risk ?? (spec?.destructive ? "destructive" : null),
				approval: row.status === "published" ? "approved" : "draft",
				job: latest ? `${latest.status}${latest.executionMode && latest.executionMode !== "real" ? ` (${latest.executionMode})` : ""}` : "—",
				evidence: latest ? (missingEvidence(latest).length ? `missing ${missingEvidence(latest).join(", ")}` : latest.evidence.length ? "complete" : "—") : "—",
			};
		}
	} else if (collection === "procedures") {
		const rows = await reader.readPort.rows("procedures", { ids, limit: ids.length });
		for (const row of rows) {
			const spec = operationSpec(row.operation);
			let classes: unknown = row.device_classes;
			try {
				classes = typeof classes === "string" ? JSON.parse(classes) : classes;
			} catch {
				/* leave as is */
			}
			out[row.id] = { devices: Array.isArray(classes) ? classes.join(", ") : "—", adapter: spec?.adapter ?? "guidance", verification: spec ? spec.requiredEvidence.join(", ") : "—" };
		}
	}
	return out;
}

export async function dashboard(ctx: ServiceCtx, reader: ContentReader, access: Access) {
	const f = await fleet(ctx, reader, access);
	const jobs = await listJobs(ctx, {}, 500);
	const bridges = (ctx.storage as Record<string, StorageCollection<Record<string, unknown>>>).bridges!;
	const journal = (ctx.storage as Record<string, StorageCollection<JournalEntry>>).journal!;
	const [bridgePage, recent, backlog, drafts, audit, tasks] = await Promise.all([
		bridges.query({ limit: 10 }),
		journal.query({ orderBy: { at: "desc" }, limit: 12 }),
		journal.count({ projectionStatus: { in: ["pending", "failed"] } }),
		reader.list("recovery_operations", "draft", 200),
		auditState(ctx),
		taskHealth(ctx),
	]);
	const targets = f.assets.filter((a) => a.inMission && a.role !== "comms_terminal");
	const statusCounts: Record<string, number> = {};
	for (const a of targets) statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
	return {
		mission: { code: MISSION_001, targets: targets.length, trusted: f.trusted, complete: f.complete, statusCounts },
		readiness: f.assets.map((a) => ({ assetTag: a.assetTag, title: a.title, status: a.status, inMission: a.inMission, role: a.role })),
		physicalActions: f.assets.filter((a) => a.next.operator && !a.next.complete).map((a) => ({ assetTag: a.assetTag, action: a.next.action, procedureCode: a.next.procedureCode })),
		needsInspection: jobs.filter((j) => j.status === "needs_inspection" && !j.inspection).map((j) => jobSummary(j, access)),
		failed: [
			...jobs.filter((j) => (j.status === "failed" || j.status === "stalled") && j.executionMode !== "simulated").slice(0, 10).map((j) => ({ kind: "job", ref: j.opCode, detail: `${j.operation} on ${j.assetTag}: ${j.status}${j.lastMessage ? ` — ${j.lastMessage}` : ""}` })),
			...f.assets.filter((a) => a.status === "blocked" || a.status === "failed").map((a) => ({ kind: "asset", ref: a.assetTag, detail: a.reasons[0] ?? a.status })),
		],
		pendingApprovals: drafts.filter((d) => d.status !== "published").map((d) => ({ id: d.id, opCode: d.key, title: d.title, assetTag: d.data.asset_tag, preparedByAi: d.data.prepared_by_ai === true })),
		bridges: bridgePage.items.map((b) => ({ id: b.id, status: b.data.status, lastSeenAt: b.data.lastSeenAt, version: b.data.bridgeVersion, mode: b.data.mode, validated: b.data.validatedOperations ?? [] })),
		missingEvidence: [
			...jobs.filter((j) => j.status === "succeeded" && missingEvidence(j).length > 0).map((j) => ({ ref: j.opCode, detail: `missing ${missingEvidence(j).join(", ")}` })),
			...f.assets.filter((a) => a.status === "restored_unverified" && a.reasons[0]?.includes("attestations")).map((a) => ({ ref: a.assetTag, detail: a.reasons[0]! })),
		],
		recent: recent.items.map((i) => ({ at: i.data.at, type: i.data.type, title: i.data.title, stream: i.data.stream })),
		audit: { ...audit, projectionBacklog: backlog, jobsWithAuditGaps: jobs.filter((j) => j.auditGap).length },
		tasks,
	};
}

export async function status(ctx: ServiceCtx, reader: ContentReader, access: Access) {
	const [d, settings] = await Promise.all([dashboard(ctx, reader, access), readSettings(ctx)]);
	return {
		platform: "Powerfarm EmDash Platform",
		pluginVersion: PLUGIN_VERSION,
		emdashRevision: EMDASH_REVISION,
		mission: d.mission,
		audit: d.audit,
		bridges: d.bridges,
		bridgeEnabled: settings.bridgeEnabled,
		needsInspection: d.needsInspection.length,
		pendingApprovals: d.pendingApprovals.length,
		tasks: d.tasks,
		operations: Object.entries(OPERATIONS).map(([name, spec]) => ({ name, adapter: spec.adapter, class: spec.class, deviceClasses: spec.deviceClasses })),
		roleNote: access.role >= ROLE.EDITOR ? undefined : "Operational detail is limited to editors and administrators.",
	};
}

export async function listCollection(reader: ContentReader, access: Access, collection: "projects" | "requirements" | "decisions" | "software" | "tests" | "releases", limit = 100) {
	const entities = await reader.list(collection, access.view, limit);
	return entities.map((e) => ({ id: e.id, key: e.key, title: e.title, status: e.status, state: e.state, updatedAt: e.updatedAt, data: filterFields(access, collection, e.data) }));
}
