/**
 * EmDash content hooks: the approval boundary and record integrity.
 *
 * Approval is publication. A recovery operation is a draft (written by a person,
 * or by an AI client over MCP) until a person publishes it in the EmDash admin.
 * `content:beforePublish` runs inside EmDash's publish pipeline, so it applies to
 * the admin, the REST API and MCP alike. The rules themselves are in recovery.ts.
 *
 * Integrity rules:
 * - events are written only by this plugin, from the journal, and never edited;
 * - evidence is never edited or deleted; files attached to evidence are hashed
 *   on the server from the stored media bytes; AI clients cannot record evidence;
 * - attestations record who signed them; a trust sign-off needs an administrator
 *   and a device that is currently `verified`;
 * - AI clients cannot change an asset's identity fields;
 * - operational link fields must point at existing entries.
 */

import type { ContentDeleteEvent, ContentHookEvent, ContentPolicyDecision, ContentPolicyEvent, PluginContext } from "emdash";
import { ContentSaveRejectedError } from "emdash";

import { assetFactsOf, evidenceFactsOf, loadEvidence, missionScope, operationFactsOf } from "./facts.js";
import { auditState, record } from "./journal.js";
import { buildJob, createJobOnce, listJobs, readSettings, transitionJob, type Ctx } from "./jobs.js";
import { isPowerfarmCollection, LINK_FIELDS, operationSpec, PLUGIN_ID, ROLE } from "./model.js";
import { CONTROL_ATTESTATIONS, isEntityCollection } from "./entities.js";
import { afterPublishEntity, afterSaveEntity, beforeDeleteEntity, beforePublishEntity, beforeSaveEntity, isEntityOrSupport, prepareSubjectEvidence } from "./entity-policy.js";
import { approvalViolations, assetProgress, deriveStatus } from "./recovery.js";
import { getReader } from "./runtime.js";
import { markPending, seal, SEALED_COLLECTIONS } from "./seals.js";
import { refusal as authorityRefusal } from "./authority.js";
import { releasePublishRefusal } from "./release.js";
import { afterUnpublishMdm, beforeDeleteMdm, beforePublishMdm, beforeSaveMdm, MDM_COLLECTIONS } from "./mdm/policy.js";

const IMMUTABLE = new Set(["events", "evidence"]);
const ASSET_IDENTITY_FIELDS = ["asset_tag", "serial_number", "ecid", "device_class", "role"];
const ATTESTATION_KINDS = new Set(["account_security", "activation_lock", "management_enrollment", "setup_review", "host_bootstrap", "trust_signoff", ...Object.keys(CONTROL_ATTESTATIONS)]);
export const MAX_EVIDENCE_HASH_BYTES = 16 * 1024 * 1024;

function reject(reason: string): never {
	throw new ContentSaveRejectedError(reason.slice(0, 500));
}

function cancel(reason: string): ContentPolicyDecision {
	return { cancel: true, reason: reason.slice(0, 500) };
}

function dataOf(content: Record<string, unknown>): Record<string, unknown> {
	const data = content.data;
	return data && typeof data === "object" ? (data as Record<string, unknown>) : content;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function bumpGraphVersion(ctx: Pick<PluginContext, "kv">): Promise<void> {
	for (let i = 0; i < 3; i++) {
		// oxlint-disable-next-line no-await-in-loop -- bounded CAS retry
		const current = await ctx.kv.getVersioned<number>("graph:version");
		// oxlint-disable-next-line no-await-in-loop
		if ((await ctx.kv.compareAndSet("graph:version", current?.revision ?? null, (current?.value ?? 0) + 1)).applied) return;
	}
}

// ---------------------------------------------------------------------------
// Saves
// ---------------------------------------------------------------------------

export async function beforeSave(event: ContentHookEvent, ctx: PluginContext) {
	const { collection, content, isNew, actor } = event;
	if (!isPowerfarmCollection(collection)) return content;
	if (isEntityOrSupport(collection)) return beforeSaveEntity({ collection, content, isNew, id: event.id, actor: actor as never }, ctx);
	if (MDM_COLLECTIONS.has(collection)) {
		const current = !isNew && event.id ? ((await (await getReader()).resolve(collection as never, event.id, "draft"))?.data ?? null) : null;
		return beforeSaveMdm(collection, content, isNew, actor as never, current);
	}
	const fromAi = actor?.source === "mcp";

	if (IMMUTABLE.has(collection)) {
		if (!isNew) reject(`${collection} entries are append-only. Record a new entry instead of editing this one.`);
		if (collection === "events" && actor) reject("Events are written by the Powerfarm journal, not by hand or by an AI client.");
		if (collection === "evidence") {
			if (fromAi) reject("Evidence must be recorded by a person or by the bridge, not by an AI client.");
			await prepareEvidence(content, actor ?? null, ctx);
		}
	}

	if (collection === "assets" && fromAi && !isNew) {
		const changed = ASSET_IDENTITY_FIELDS.filter((f) => f in content);
		if (changed.length > 0) {
			const reader = await getReader();
			const current = event.id ? await reader.resolve("assets", event.id, "draft") : null;
			const really = changed.filter((f) => current && String(current.data[f] ?? "") !== String(content[f] ?? ""));
			if (really.length > 0) reject(`AI clients cannot change an asset's identity (${really.join(", ")}). Record it from a verified inventory.`);
		}
	}
	if (collection === "assets" && fromAi && isNew) reject("AI clients cannot create assets. Add devices in the admin.");

	const links = LINK_FIELDS.filter((l) => l.collection === collection);
	if (links.length > 0) {
		const reader = await getReader();
		for (const link of links) {
			const value = content[link.field];
			if (value === undefined || value === null || value === "") {
				if (link.required && isNew) reject(`${link.field} is required.`);
				continue;
			}
			if (typeof value !== "string") reject(`${link.field} must be a key such as LAB-8GB or OP-0001.`);
			// oxlint-disable-next-line no-await-in-loop -- at most four link fields
			const target = await reader.resolve(link.target, value, "draft");
			if (!target) reject(`${link.field} "${value}" does not match any entry in ${link.target}.`);
			content[link.field] = value.trim().toUpperCase();
		}
	}

	if (collection === "recovery_operations") {
		if (fromAi) content.prepared_by_ai = true;
		if (isNew && (typeof content.op_code !== "string" || !content.op_code)) content.op_code = await nextCode(ctx, "seq:op", "OP");
		if (content.operation !== undefined && !operationSpec(content.operation)) reject(`Unknown operation "${String(content.operation)}".`);
	}
	return content;
}

async function prepareEvidence(content: Record<string, unknown>, actor: { id: string; role: number } | null, ctx: PluginContext) {
	const attests = typeof content.attests === "string" && content.attests ? content.attests : null;
	if (content.evidence_type === "attestation") {
		if (!attests || !ATTESTATION_KINDS.has(attests)) reject("An attestation must say what it attests (for example account_security).");
		if (!actor) {
			// Attestations are a person's statement; the bridge never attests.
			reject("Attestations must be recorded by a signed-in person.");
		}
		content.signed_by = actor.id;
		await prepareSubjectEvidence(content, actor);
		if (attests === "trust_signoff") {
			if (actor.role < ROLE.ADMIN) reject("Only an administrator can sign off trust.");
			const tag = typeof content.asset_tag === "string" ? content.asset_tag : "";
			const reader = await getReader();
			const asset = await reader.resolve("assets", tag, "published");
			if (!asset) reject("Trust sign-off needs an asset.");
			const scope = await missionScope(reader);
			const facts = assetFactsOf(asset, scope.assetGroups);
			const [jobs, evidence, audit] = await Promise.all([
				listJobs(ctx, { assetTag: facts.assetTag }, 500),
				loadEvidence(reader, [facts.assetTag]),
				auditState(ctx),
			]);
			const status = deriveStatus(facts, assetProgress(facts, jobs, evidence), audit.degraded);
			if (status.status !== "verified") reject(`${facts.assetTag} is "${status.status}", not "verified". ${status.reasons[0] ?? ""}`);
		}
	}

	if (content.evidence_type !== "attestation" && content.subject && actor) await prepareSubjectEvidence(content, actor);

	// A file attached in the admin: hash the stored bytes on the server.
	const file = content.file as { id?: string } | null | undefined;
	if (file?.id && actor) {
		if (!ctx.media?.readBytes) reject("Evidence files cannot be verified: media:bytes:read is not granted.");
		const bytes = await ctx.media.readBytes(file.id, { maxBytes: MAX_EVIDENCE_HASH_BYTES }).catch(() => null);
		if (!bytes) reject(`The attached file could not be read for hashing (limit ${MAX_EVIDENCE_HASH_BYTES / 1024 / 1024} MiB).`);
		const digest = await sha256Hex(bytes.bytes);
		const claimed = typeof content.sha256 === "string" && content.sha256 ? content.sha256.toLowerCase() : null;
		if (claimed && claimed !== digest) reject(`The SHA-256 you entered does not match the file (server computed ${digest}).`);
		content.sha256 = digest;
		content.media_id = file.id;
		content.size_bytes = bytes.size;
		content.original_filename = bytes.filename;
		content.mime_type = bytes.mimeType;
		content.digest_status = "server_verified";
	} else if (actor) {
		content.digest_status = content.sha256 ? "unverified" : "none";
	}
	if (!content.captured_at) content.captured_at = new Date().toISOString();
}

async function nextCode(ctx: PluginContext, key: string, prefix: string): Promise<string> {
	for (let attempt = 0; attempt < 8; attempt++) {
		// oxlint-disable-next-line no-await-in-loop -- bounded CAS retry
		const current = await ctx.kv.getVersioned<number>(key);
		const next = (current?.value ?? 0) + 1;
		// oxlint-disable-next-line no-await-in-loop
		if ((await ctx.kv.compareAndSet(key, current?.revision ?? null, next)).applied) return `${prefix}-${String(next).padStart(4, "0")}`;
	}
	reject("Could not allocate an operation code; try again.");
}

export async function afterChange(event: { collection: string; content?: Record<string, unknown> }, ctx: PluginContext) {
	if (!isPowerfarmCollection(event.collection)) return;
	await bumpGraphVersion(ctx);
	if (event.content && (isEntityOrSupport(event.collection) || event.collection === "evidence")) {
		await afterSaveEntity({ collection: event.collection, content: event.content }, ctx).catch((error) => ctx.log.warn("Onboarding re-check deferred to the scheduled task", { error: String(error) }));
	}
}

export async function beforeDelete(event: ContentDeleteEvent, ctx: PluginContext): Promise<boolean> {
	if (IMMUTABLE.has(event.collection)) return false;
	if (isEntityOrSupport(event.collection)) return beforeDeleteEntity(event);
	if (MDM_COLLECTIONS.has(event.collection)) return beforeDeleteMdm(event.collection, event.id);
	if (event.collection === "recovery_operations") {
		// Keep any operation that ever produced a job: it is part of the history.
		const jobs = await listJobs(ctx, { opId: event.id }, 1);
		if (jobs.length > 0) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Publication = approval
// ---------------------------------------------------------------------------

export async function beforeSchedule(event: ContentPolicyEvent): Promise<ContentPolicyDecision> {
	if (event.collection === "recovery_operations") return cancel("Recovery operations cannot be scheduled. Approve them by publishing when you are ready.");
	if (IMMUTABLE.has(event.collection)) return cancel("History cannot be scheduled.");
	if (isEntityOrSupport(event.collection)) return cancel("Publishing is an approval; publish it when you are ready instead of scheduling it.");
}

export async function beforeUnpublish(event: ContentPolicyEvent, ctx?: PluginContext): Promise<ContentPolicyDecision> {
	if (IMMUTABLE.has(event.collection)) return cancel("Recorded history cannot be unpublished.");
	if (HUMAN_PUBLISHED.has(event.collection) && event.origin.source === "mcp") return cancel("Only a person can withdraw this.");
	if (isEntityOrSupport(event.collection) && event.origin.source === "mcp") return cancel("Only a person can withdraw this.");
	if (event.collection === "incidents") return cancel("Incidents stay as history; close them with a resolution instead.");
	if (event.collection === "mdm_profiles" && (event.actor?.role ?? 0) < ROLE.ADMIN) return cancel("Only an administrator withdraws a device profile.");
	const withdrawal = WITHDRAWAL_CAPABILITY[event.collection];
	if (withdrawal && ctx) {
		const id = typeof event.content.id === "string" ? event.content.id : "";
		const denied = await authorityRefusal(ctx as never, await getReader(), { actor: event.actor ? { id: event.actor.id, role: event.actor.role, source: event.origin.source } : null, capability: withdrawal, scope: `${event.collection}:${String(dataOf(event.content).code ?? dataOf(event.content).identifier ?? id)}`, what: `withdraw ${event.collection}` });
		if (denied) return cancel(denied);
	}
	if (isEntityCollection(event.collection)) {
		if ((event.actor?.role ?? 0) < ROLE.ADMIN) return cancel("Suspend or retire a registered record instead of unpublishing it.");
		// Only a registration made by mistake (still intake) can be withdrawn; active and suspended records retire, with their controls.
		const reader = await getReader();
		const id = typeof event.content.id === "string" ? event.content.id : null;
		const live = id ? await reader.resolve(event.collection, id, "published") : null;
		if (!live) return cancel("Record not found.");
		const lifecycle = live.data.lifecycle ?? "intake";
		if (lifecycle !== "intake") return cancel(`A ${String(lifecycle)} record is not unpublished: retire it, so its retirement controls apply.`);
	}
}

/** Withdrawing these is itself an exercise of authority (revoking a grant, a policy, a device profile). */
const WITHDRAWAL_CAPABILITY: Record<string, "authority.grant" | "policy.publish" | "approve.profile"> = { grants: "authority.grant", policies: "policy.publish", mdm_profiles: "approve.profile" };

/** Collections whose published state drives recovery decisions. AI clients may draft them, never publish them. */
const HUMAN_PUBLISHED = new Set(["recovery_operations", "procedures", "assets", "missions", "evidence"]);

/** Every allowed publish of a sealed collection leaves a seal-pending marker first (seals.ts). */
export async function beforePublish(event: ContentPolicyEvent, ctx: PluginContext): Promise<ContentPolicyDecision> {
	const decision = await decidePublish(event, ctx);
	if (!decision && SEALED_COLLECTIONS.has(event.collection) && typeof event.content.id === "string") {
		await markPending(ctx as never, event.collection, event.content.id, event.actor?.id ?? null);
	}
	return decision;
}

async function decidePublish(event: ContentPolicyEvent, ctx: PluginContext): Promise<ContentPolicyDecision> {
	if (HUMAN_PUBLISHED.has(event.collection) && event.origin.source === "mcp") {
		return cancel(`${event.collection} can only be published by a person in the EmDash admin. AI clients may prepare drafts.`);
	}
	if (event.collection === "events") {
		if (event.origin.source === "plugin" && event.origin.pluginId === PLUGIN_ID) return;
		return cancel("Events are recorded by the Powerfarm journal.");
	}
	if (isEntityOrSupport(event.collection)) return beforePublishEntity(event, ctx);
	if (MDM_COLLECTIONS.has(event.collection)) return beforePublishMdm(event, ctx);
	if (event.collection === "releases") {
		const denied = await releasePublishRefusal(ctx as never, await getReader(), event.actor ? { id: event.actor.id, role: event.actor.role, source: event.origin.source } : null, event.content, dataOf(event.content));
		return denied ? cancel(denied) : undefined;
	}
	if (event.collection !== "recovery_operations") return;

	const op = dataOf(event.content);
	const reader = await getReader();
	const settings = await readSettings(ctx);
	const assetEntity = typeof op.asset_tag === "string" ? await reader.resolve("assets", op.asset_tag, "published") : null;
	const procedureEntity = typeof op.procedure_code === "string" ? await reader.resolve("procedures", op.procedure_code, "published") : null;
	const scope = await missionScope(reader, typeof op.mission_code === "string" ? op.mission_code : undefined);
	const asset = assetEntity ? assetFactsOf(assetEntity, scope.assetGroups) : null;
	const backupEntity = typeof op.backup_op_code === "string" && op.backup_op_code ? await reader.resolve("recovery_operations", op.backup_op_code, "published") : null;
	const [jobsForAsset, evidenceForAsset, backupJobs, audit] = await Promise.all([
		asset ? listJobs(ctx, { assetTag: asset.assetTag }, 500) : Promise.resolve([]),
		asset ? loadEvidence(reader, [asset.assetTag]) : Promise.resolve([]),
		backupEntity ? listJobs(ctx, { opId: backupEntity.id }, 50) : Promise.resolve([]),
		auditState(ctx),
	]);

	const violations = approvalViolations({
		origin: event.origin.source,
		actor: event.actor ? { id: event.actor.id, role: event.actor.role } : null,
		authorId: typeof event.content.authorId === "string" ? event.content.authorId : null,
		settings,
		op,
		asset,
		procedure: procedureEntity
			? {
					code: procedureEntity.key ?? procedureEntity.id,
					operation: String(procedureEntity.data.operation ?? ""),
					deviceClasses: Array.isArray(procedureEntity.data.device_classes) ? (procedureEntity.data.device_classes as string[]) : [],
				}
			: null,
		missionExists: !!scope.mission,
		jobsForAsset,
		evidenceForAsset,
		backupOp: backupEntity ? operationFactsOf(backupEntity) : null,
		backupJobs,
		auditDegraded: audit.degraded,
	});
	if (violations.length > 0) return cancel(violations.join(" "));
	if (operationSpec(op.operation)?.destructive) {
		const denied = await authorityRefusal(ctx as never, reader, { actor: event.actor ? { id: event.actor.id, role: event.actor.role, source: event.origin.source } : null, capability: "approve.destructive", scope: `assets:${String(op.asset_tag ?? "")}`, what: `${String(op.op_code ?? "")} ${String(op.operation ?? "")}` });
		if (denied) return cancel(denied);
	}

	// Allowed. afterPublish does not receive the actor, so remember who approved.
	await ctx.kv.set(`approval:${String(event.content.id)}`, { actorId: event.actor!.id, role: event.actor!.role, at: new Date().toISOString() });
}

/** Turn a published operation into its job. Also used by reconciliation. */
export async function ensureJobForPublishedOperation(
	ctx: Ctx,
	content: { id: string; liveRevisionId: string | null; authorId: string | null; data: Record<string, unknown> },
	source: "policy" | "reconcile",
): Promise<{ created: boolean; jobId: string | null; problem?: string }> {
	const reader = await getReader();
	const asset = typeof content.data.asset_tag === "string" ? await reader.resolve("assets", content.data.asset_tag, "published") : null;
	if (!asset) return { created: false, jobId: null, problem: `Asset ${String(content.data.asset_tag)} not found` };
	const approval = await ctx.kv.get<{ actorId: string; at: string }>(`approval:${content.id}`);
	const job = buildJob(
		{ opId: content.id, liveRevisionId: content.liveRevisionId, authorId: content.authorId, data: content.data },
		{
			asset: {
				assetTag: (asset.key ?? asset.id).toUpperCase(),
				deviceClass: typeof asset.data.device_class === "string" ? asset.data.device_class : null,
				ecid: typeof asset.data.ecid === "string" ? asset.data.ecid : null,
				serialNumber: typeof asset.data.serial_number === "string" ? asset.data.serial_number : null,
			},
			approvedBy: approval ? `user:${approval.actorId}` : "unknown-approver",
			approvedAt: approval?.at ?? new Date().toISOString(),
		},
	);
	if ("error" in job) return { created: false, jobId: null, problem: job.error };

	// Supersede unclaimed jobs from earlier approvals of the same operation.
	for (const old of await listJobs(ctx, { opId: content.id, status: "approved" }, 20)) {
		if (old.id === job.id) continue;
		// oxlint-disable-next-line no-await-in-loop -- few jobs per operation
		await transitionJob(ctx, old, "approved", "revoked", { lastMessage: "Superseded by a newer approved revision" }, { actor: "powerfarm", source });
	}
	const result = await createJobOnce(ctx, job, source);
	return { created: result.created, jobId: job.id };
}

export async function afterPublish(event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) {
	await bumpGraphVersion(ctx);
	if (SEALED_COLLECTIONS.has(event.collection)) {
		await seal(ctx as never, await getReader(), event.collection, String(event.content.id)).catch((e: unknown) => ctx.log.warn("Seal deferred to the seals task", { collection: event.collection, error: String(e) }));
	}
	if (isEntityCollection(event.collection)) return afterPublishEntity(event, ctx);
	if (event.collection !== "recovery_operations") return;
	const c = event.content;
	const result = await ensureJobForPublishedOperation(
		ctx,
		{
			id: String(c.id),
			liveRevisionId: typeof c.liveRevisionId === "string" ? c.liveRevisionId : null,
			authorId: typeof c.authorId === "string" ? c.authorId : null,
			data: dataOf(c),
		},
		"policy",
	);
	if (result.problem) {
		// Leave it to reconciliation to flag; also say so in the journal now.
		await record(ctx, {
			type: "approval.job_not_created",
			stream: "system",
			actor: "powerfarm",
			source: "policy",
			title: `No job created for ${String(dataOf(c).op_code ?? c.id)}: ${result.problem}`,
			opCode: typeof dataOf(c).op_code === "string" ? (dataOf(c).op_code as string) : null,
			idempotencyKey: `approval:${String(c.id)}:${String(c.liveRevisionId)}:no-job`,
		}).catch(() => {});
	}
}

/**
 * Unpublishing withdraws the approval. Jobs that have not started are revoked.
 * A command already running on a device cannot be recalled; that is recorded.
 */
export async function afterUnpublish(event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext) {
	await bumpGraphVersion(ctx);
	if (MDM_COLLECTIONS.has(event.collection)) {
		await afterUnpublishMdm(event.collection, event.content, ctx as never);
		return;
	}
	if (event.collection !== "recovery_operations") return;
	const opId = String(event.content.id);
	for (const job of await listJobs(ctx, { opId }, 20)) {
		if (job.status === "approved" || job.status === "claimed") {
			// oxlint-disable-next-line no-await-in-loop -- few jobs per operation
			await transitionJob(ctx, job, job.status, "revoked", { lastMessage: "Approval withdrawn" }, { actor: "admin", source: "policy" });
		} else if (job.status === "running") {
			// oxlint-disable-next-line no-await-in-loop
			await record(ctx, {
				type: "approval.withdrawn_while_running",
				stream: `asset:${job.assetTag}`,
				actor: "admin",
				source: "policy",
				title: `${job.opCode} approval withdrawn while running. The command on the device is not interrupted.`,
				assetTag: job.assetTag,
				opCode: job.opCode,
				jobId: job.id,
				idempotencyKey: `job:${job.id}:withdrawn-running`,
			});
		}
	}
}

export { evidenceFactsOf };
