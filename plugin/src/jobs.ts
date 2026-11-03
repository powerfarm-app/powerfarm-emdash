/**
 * Recovery jobs in EmDash plugin storage.
 *
 * - One job per approved revision: the job id is `${opId}:${liveRevisionId}` and
 *   is created with compare-and-set, so a retried hook or the reconciliation task
 *   can never create a second one. A missing revision creates no job (fail closed).
 * - One active job per asset: a per-asset lock in EmDash KV, taken at claim and
 *   released when the job ends. A job that ends in `needs_inspection` keeps the
 *   lock until a person records what happened.
 * - Every transition is a guarded `updateIf` and is written to the journal. If the
 *   journal write fails, the transition stands, the job is flagged `auditGap`,
 *   and the platform is marked audit-degraded.
 */

import type { PluginContext, StorageCollection } from "emdash";

import { appendJournal, JOURNAL_STORAGE, JournalError, markDegraded, record, streamForAsset } from "./journal.js";
import {
	DEFAULTS,
	type Job,
	JOB_TRANSITIONS,
	type JobStatus,
	type OperationName,
	operationSpec,
	ROLE,
	SETTINGS,
	ACTIVE_JOB_STATUSES,
	type DataDecision,
} from "./model.js";

export const STORAGE = {
	jobs: {
		indexes: ["status", "assetTag", "opId", "opCode", "updatedAt", "operation", ["assetTag", "status"], ["status", "updatedAt"]],
	},
	bridges: { indexes: ["lastSeenAt", "status"] },
	reconciliations: { indexes: ["kind", "at", "status", "opId"] },
	...JOURNAL_STORAGE,
};

export type Ctx = Pick<PluginContext, "storage" | "kv" | "content" | "log" | "settings">;

export function jobsOf(ctx: Pick<PluginContext, "storage">): StorageCollection<Job> {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- declared in STORAGE
	return (ctx.storage as Record<string, StorageCollection<Job>>).jobs!;
}

type JobWhere = NonNullable<NonNullable<Parameters<StorageCollection<Job>["query"]>[0]>["where"]>;

export async function listJobs(ctx: Pick<PluginContext, "storage">, where: JobWhere = {}, limit = 200): Promise<Job[]> {
	const jobs: Job[] = [];
	let cursor: string | undefined;
	do {
		// oxlint-disable-next-line no-await-in-loop -- cursor pagination
		const page = await jobsOf(ctx).query({ where, orderBy: { updatedAt: "desc" }, limit: Math.min(limit - jobs.length, 100), cursor });
		for (const item of page.items) jobs.push(item.data);
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor && jobs.length < limit);
	return jobs;
}

export async function readSettings(ctx: Pick<PluginContext, "settings">) {
	const get = async <T>(key: string, fallback: T): Promise<T> => (await ctx.settings.get<T>(key)) ?? fallback;
	const role = Number(await get<string | number>(SETTINGS.destructiveMinRole, DEFAULTS.destructiveMinRole));
	return {
		bridgeId: await get<string | null>(SETTINGS.bridgeId, null),
		bridgeEnabled: await get<boolean>(SETTINGS.bridgeEnabled, DEFAULTS.bridgeEnabled),
		hostAssetTag: (await get<string>(SETTINGS.hostAssetTag, DEFAULTS.hostAssetTag)).toUpperCase(),
		requireSecondPerson: await get<boolean>(SETTINGS.requireSecondPerson, DEFAULTS.requireSecondPerson),
		destructiveMinRole: role === ROLE.EDITOR ? ROLE.EDITOR : ROLE.ADMIN,
		claimLeaseMinutes: Math.min(240, Math.max(5, Number(await get<number>(SETTINGS.claimLeaseMinutes, DEFAULTS.claimLeaseMinutes)) || DEFAULTS.claimLeaseMinutes)),
		maxArtifactBytes: Math.min(8, Math.max(1, Number(await get<number>(SETTINGS.maxArtifactMegabytes, DEFAULTS.maxArtifactMegabytes)) || 8)) * 1024 * 1024,
	};
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export interface ApprovedOperation {
	opId: string;
	liveRevisionId: string | null;
	authorId: string | null;
	data: Record<string, unknown>;
}

export interface JobContext {
	asset: { assetTag: string; deviceClass: string | null; ecid: string | null; serialNumber: string | null };
	approvedBy: string;
	approvedAt: string;
}

export function jobIdFor(opId: string, revision: string): string {
	return `${opId}:${revision}`;
}

export function buildJob(op: ApprovedOperation, context: JobContext): Job | { error: string } {
	if (!op.liveRevisionId) return { error: "The published operation has no revision id; no job is created." };
	const spec = operationSpec(op.data.operation);
	if (!spec) return { error: `Unknown operation ${String(op.data.operation)}` };
	const now = new Date().toISOString();
	const dryRun = op.data.dry_run !== false;
	return {
		id: jobIdFor(op.opId, op.liveRevisionId),
		opId: op.opId,
		opCode: String(op.data.op_code ?? op.opId),
		opRevision: op.liveRevisionId,
		missionCode: typeof op.data.mission_code === "string" ? op.data.mission_code : null,
		assetTag: context.asset.assetTag,
		deviceClass: context.asset.deviceClass ?? "",
		ecid: context.asset.ecid,
		serialNumber: context.asset.serialNumber,
		procedureCode: String(op.data.procedure_code ?? ""),
		operation: op.data.operation as OperationName,
		operationClass: spec.class,
		destructive: spec.destructive && !dryRun,
		parameters: op.data.parameters && typeof op.data.parameters === "object" ? (op.data.parameters as Record<string, unknown>) : {},
		dryRun,
		dataDecision: (op.data.data_decision as DataDecision | null) ?? null,
		requiredEvidence: [...spec.requiredEvidence],
		status: "approved",
		authorId: op.authorId,
		approvedBy: context.approvedBy,
		approvedAt: context.approvedAt,
		claimedBy: null,
		claimedAt: null,
		leaseId: null,
		leaseExpiresAt: null,
		// A dry run of anything that is not read-only can only ever be a dry run.
		executionMode: dryRun ? "dry_run" : null,
		startedAt: null,
		finishedAt: null,
		updatedAt: now,
		lastMessage: null,
		result: null,
		evidence: [],
		auditGap: false,
		inspection: null,
	};
}

/** Create the job if it does not exist yet. Returns whether this call created it. */
export async function createJobOnce(ctx: Ctx, job: Job, source: "policy" | "reconcile"): Promise<{ created: boolean; job: Job }> {
	const stored = await jobsOf(ctx).compareAndSet(job.id, null, job);
	if (!stored.applied) return { created: false, job: (await jobsOf(ctx).get(job.id)) ?? job };
	await journalOrFlag(ctx, job, {
		type: "job.created",
		title: `${job.opCode} approved: ${job.operation} on ${job.assetTag}${job.dryRun ? " (dry run)" : ""}`,
		actor: job.approvedBy,
		source,
		payload: { revision: job.opRevision, operation: job.operation, dryRun: job.dryRun, dataDecision: job.dataDecision },
		idempotencyKey: `job:${job.id}:created`,
	});
	return { created: true, job };
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

async function journalOrFlag(
	ctx: Ctx,
	job: Job,
	entry: { type: string; title: string; actor: string; source: "policy" | "bridge" | "reconcile" | "admin"; payload?: Record<string, unknown>; idempotencyKey: string; evidenceIds?: string[] },
): Promise<void> {
	try {
		await record(ctx, {
			...entry,
			stream: streamForAsset(job.assetTag),
			assetTag: job.assetTag,
			opCode: job.opCode,
			jobId: job.id,
		});
	} catch (error) {
		if (!(error instanceof JournalError)) throw error;
		await jobsOf(ctx).updateIf(job.id, { where: {}, set: { auditGap: true } });
		ctx.log.error("Journal write failed; job flagged auditGap", { jobId: job.id, type: entry.type });
	}
}

export interface TransitionOptions {
	actor: string;
	source: "policy" | "bridge" | "reconcile" | "admin";
	title?: string;
	payload?: Record<string, unknown>;
	/** Extra guard fields (for example the lease id) that must match for the transition to apply. */
	guard?: Partial<Pick<Job, "leaseId" | "claimedBy">>;
	idempotencyKey?: string;
	evidenceIds?: string[];
}

/**
 * Move a job from `from` to `to` if, and only if, it is still in `from` (and the
 * guard matches) and the transition is allowed. Returns the updated job, or null.
 */
export async function transitionJob(ctx: Ctx, job: Job, from: JobStatus, to: JobStatus, patch: Partial<Job>, options: TransitionOptions): Promise<Job | null> {
	if (!JOB_TRANSITIONS[from].includes(to)) return null;
	const now = new Date().toISOString();
	const result = await jobsOf(ctx).updateIf(job.id, {
		where: { status: from, ...(options.guard ?? {}) },
		set: { ...patch, status: to, updatedAt: now },
	});
	if (!result.applied) return null;
	const next = result.data as Job;
	if (from !== to) {
		if (!(ACTIVE_JOB_STATUSES as readonly string[]).includes(to) && to !== "needs_inspection") await releaseAssetLock(ctx, next.assetTag, next.id);
		await journalOrFlag(ctx, next, {
			type: `job.${to}`,
			title: options.title ?? `${next.opCode} ${to}: ${next.operation} on ${next.assetTag}`,
			actor: options.actor,
			source: options.source,
			payload: { from, to, ...(options.payload ?? {}) },
			idempotencyKey: options.idempotencyKey ?? `job:${next.id}:${from}->${to}`,
			evidenceIds: options.evidenceIds,
		});
	}
	return next;
}

// ---------------------------------------------------------------------------
// Per-asset lock
// ---------------------------------------------------------------------------

function lockKey(assetTag: string): string {
	return `lock:asset:${assetTag.toUpperCase()}`;
}

export async function acquireAssetLock(ctx: Pick<PluginContext, "kv">, assetTag: string, jobId: string): Promise<boolean> {
	const key = lockKey(assetTag);
	const current = await ctx.kv.getVersioned<{ jobId: string; at: string }>(key);
	if (current && current.value.jobId !== jobId) return false;
	if (current) return true;
	return (await ctx.kv.compareAndSet(key, null, { jobId, at: new Date().toISOString() })).applied;
}

export async function releaseAssetLock(ctx: Pick<PluginContext, "kv">, assetTag: string, jobId: string): Promise<void> {
	const key = lockKey(assetTag);
	const current = await ctx.kv.getVersioned<{ jobId: string }>(key);
	if (current && current.value.jobId === jobId) await ctx.kv.compareAndDelete(key, current.revision);
}

export async function assetLockHolder(ctx: Pick<PluginContext, "kv">, assetTag: string): Promise<string | null> {
	return (await ctx.kv.get<{ jobId: string }>(lockKey(assetTag)))?.jobId ?? null;
}

// ---------------------------------------------------------------------------
// Inspection and manual completion (people only; routes enforce session auth)
// ---------------------------------------------------------------------------

export async function resolveInspection(
	ctx: Ctx,
	jobId: string,
	by: { id: string; role: number },
	finding: "not_executed" | "executed" | "unknown",
	note: string,
): Promise<Job | { error: string }> {
	if (by.role < ROLE.ADMIN) return { error: "Only an administrator can resolve an inspection." };
	if (note.trim().length < 10) return { error: "Describe what you found on the device (at least 10 characters)." };
	const job = await jobsOf(ctx).get(jobId);
	if (!job || job.status !== "needs_inspection") return { error: "No job awaiting inspection." };
	if (job.inspection) return { error: "Already resolved." };
	const inspection = { resolvedBy: by.id, resolvedAt: new Date().toISOString(), finding, note: note.slice(0, 2000) };
	const updated = await jobsOf(ctx).updateIf(jobId, { where: { status: "needs_inspection" }, set: { inspection } });
	if (!updated.applied) return { error: "The job changed; reload and try again." };
	await releaseAssetLock(ctx, job.assetTag, job.id);
	await journalOrFlag(ctx, job, {
		type: "job.inspection_resolved",
		title: `${job.opCode} inspected: ${finding}`,
		actor: `user:${by.id}`,
		source: "admin",
		payload: { finding, note: inspection.note },
		idempotencyKey: `job:${job.id}:inspection`,
	});
	return updated.data as Job;
}

export async function recordSystemEvent(ctx: Ctx, type: string, title: string, payload?: Record<string, unknown>, idempotencyKey?: string) {
	try {
		return await appendJournal(ctx, { type, title, stream: "system", actor: "powerfarm", source: "system", payload: payload ?? null, idempotencyKey });
	} catch (error) {
		await markDegraded(ctx, `Could not record ${type}`).catch(() => {});
		throw error;
	}
}
