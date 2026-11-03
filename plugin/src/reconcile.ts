/**
 * Coordination tasks run by EmDash's plugin scheduler (`ctx.cron`).
 *
 * None of them executes hardware operations. Each is idempotent, and each
 * records its last run, outcome and error in KV (`cron:last:<task>`) so the
 * dashboard can show whether coordination is healthy. Anything that needs a
 * person's attention is written to `reconciliations` storage and the journal.
 */

import { vigilanceTask } from "./mdm/vigilance.js";
import { reconcileSeals } from "./seals.js";
import { accessLogsTask } from "./cloudflare.js";
import type { PluginContext, StorageCollection } from "emdash";

import { blueprintTask, identityTask } from "./entity-tasks.js";
import { drainOutbox, knownStreams, markDegraded, record, verifyChain } from "./journal.js";
import { listJobs, readSettings, transitionJob, type Ctx } from "./jobs.js";
import { operationSpec } from "./model.js";
import { ensureJobForPublishedOperation } from "./policy.js";
import { getReader } from "./runtime.js";
import { stillApproved } from "./bridge-service.js";

export const TASKS = {
	reconcile: "*/5 * * * *",
	outbox: "* * * * *",
	leases: "* * * * *",
	integrity: "17 * * * *",
	housekeeping: "41 3 * * *",
	// 1.2
	blueprints: "* * * * *",
	identity: "*/15 * * * *",
	// 1.3
	vigilance: "*/15 * * * *",
	// 1.4
	seals: "*/5 * * * *",
	"access-logs": "23 * * * *",
} as const;
export type TaskName = keyof typeof TASKS;

export interface Reconciliation {
	id: string;
	kind: "created_missing_job" | "missing_revision" | "job_creation_failed" | "revoked_stale_approval" | "lease_expired" | "chain_broken" | "bridge_offline";
	at: string;
	status: "resolved" | "flagged";
	opId: string | null;
	jobId: string | null;
	detail: string;
}

function reconciliationsOf(ctx: Pick<PluginContext, "storage">): StorageCollection<Reconciliation> {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- declared in STORAGE
	return (ctx.storage as Record<string, StorageCollection<Reconciliation>>).reconciliations!;
}

async function note(ctx: Ctx, rec: Omit<Reconciliation, "at">) {
	const created = await reconciliationsOf(ctx).compareAndSet(rec.id, null, { ...rec, at: new Date().toISOString() });
	if (!created.applied) return; // already recorded
	await record(ctx, {
		type: `reconcile.${rec.kind}`,
		stream: "system",
		actor: "powerfarm",
		source: "reconcile",
		title: rec.detail.slice(0, 200),
		jobId: rec.jobId,
		payload: { opId: rec.opId, status: rec.status },
		idempotencyKey: `reconcile:${rec.id}`,
	});
}

/** Published operations must each have a job for their live revision; stale approvals are revoked. */
export async function reconcileApprovals(ctx: Ctx) {
	const reader = await getReader();
	let created = 0;
	let flagged = 0;
	let revoked = 0;
	for (const op of await reader.list("recovery_operations", "published", 1000)) {
		if (!operationSpec(op.data.operation)) continue;
		if (!op.liveRevisionId) {
			flagged++;
			// oxlint-disable-next-line no-await-in-loop
			await note(ctx, { id: `missing_revision:${op.id}`, kind: "missing_revision", status: "flagged", opId: op.id, jobId: null, detail: `${op.key ?? op.id} is published without a revision id. No job can be created; republish it.` });
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop
		const result = await ensureJobForPublishedOperation(ctx, { id: op.id, liveRevisionId: op.liveRevisionId, authorId: op.authorId, data: op.data }, "reconcile");
		if (result.created) {
			created++;
			// oxlint-disable-next-line no-await-in-loop
			await note(ctx, { id: `created:${result.jobId}`, kind: "created_missing_job", status: "resolved", opId: op.id, jobId: result.jobId, detail: `Created the missing job for ${op.key ?? op.id} at revision ${op.liveRevisionId}.` });
		} else if (result.problem) {
			flagged++;
			// oxlint-disable-next-line no-await-in-loop
			await note(ctx, { id: `failed:${op.id}:${op.liveRevisionId}`, kind: "job_creation_failed", status: "flagged", opId: op.id, jobId: null, detail: `${op.key ?? op.id}: ${result.problem}` });
		}
	}
	for (const job of await listJobs(ctx, { status: "approved" }, 500)) {
		// oxlint-disable-next-line no-await-in-loop
		const ok = await stillApproved(job);
		if (ok.ok) continue;
		// oxlint-disable-next-line no-await-in-loop
		const done = await transitionJob(ctx, job, "approved", "revoked", { lastMessage: ok.reason ?? null }, { actor: "powerfarm", source: "reconcile" });
		if (done) {
			revoked++;
			// oxlint-disable-next-line no-await-in-loop
			await note(ctx, { id: `revoked:${job.id}`, kind: "revoked_stale_approval", status: "resolved", opId: job.opId, jobId: job.id, detail: `${job.opCode}: ${ok.reason}` });
		}
	}
	return { created, flagged, revoked };
}

/**
 * Expired leases. A claimed job that never started is `stalled`. A running job
 * that stopped reporting is `failed` if it was read-only, and `needs_inspection`
 * if it could have changed the device. Nothing is retried automatically.
 */
export async function expireLeases(ctx: Ctx, now = new Date()) {
	let stalled = 0;
	let inspection = 0;
	for (const status of ["claimed", "running"] as const) {
		for (const job of await listJobs(ctx, { status }, 500)) {
			if (!job.leaseExpiresAt || job.leaseExpiresAt > now.toISOString()) continue;
			const readOnly = operationSpec(job.operation)?.readOnly ?? false;
			const to = status === "claimed" ? "stalled" : readOnly ? "failed" : "needs_inspection";
			// oxlint-disable-next-line no-await-in-loop
			const done = await transitionJob(
				ctx,
				job,
				status,
				to,
				{ lastMessage: `Bridge lease expired while ${status}.`, finishedAt: now.toISOString() },
				{ actor: "powerfarm", source: "reconcile", guard: { leaseId: job.leaseId } },
			);
			if (!done) continue;
			if (to === "needs_inspection") inspection++;
			else stalled++;
			// oxlint-disable-next-line no-await-in-loop
			await note(ctx, { id: `lease:${job.id}`, kind: "lease_expired", status: to === "needs_inspection" ? "flagged" : "resolved", opId: job.opId, jobId: job.id, detail: `${job.opCode} lease expired while ${status}; now ${to}.` });
		}
	}
	return { stalled, inspection };
}

export async function checkIntegrity(ctx: Ctx) {
	const broken: string[] = [];
	for (const stream of await knownStreams(ctx)) {
		// oxlint-disable-next-line no-await-in-loop
		const result = await verifyChain(ctx, stream);
		if (!result.ok) broken.push(`${stream}: ${result.problem}`);
	}
	if (broken.length > 0) {
		await markDegraded(ctx, `Journal integrity check failed: ${broken.join("; ")}`);
		for (const b of broken) {
			// oxlint-disable-next-line no-await-in-loop
			await note(ctx, { id: `chain:${b}`, kind: "chain_broken", status: "flagged", opId: null, jobId: null, detail: b }).catch(() => {});
		}
	}
	// Bridges that have not reported health for 10 minutes are offline.
	const bridges = (ctx.storage as Record<string, StorageCollection<{ id: string; lastSeenAt: string; status: string }>>).bridges!;
	const cutoff = new Date(Date.now() - 10 * 60_000).toISOString();
	const page = await bridges.query({ where: { status: "online", lastSeenAt: { lt: cutoff } }, limit: 50 });
	for (const { id } of page.items) await bridges.updateIf(id, { where: { status: "online" }, set: { status: "offline" } });
	return { broken: broken.length, bridgesOffline: page.items.length };
}

export async function housekeeping(ctx: Ctx) {
	const cutoff = Math.floor(Date.now() / 1000) - 15 * 60;
	let removed = 0;
	for (const { key, value } of await ctx.kv.list("nonce:")) {
		if (typeof value !== "number" || value < cutoff) {
			// oxlint-disable-next-line no-await-in-loop
			await ctx.kv.delete(key);
			removed++;
		}
	}
	const settings = await readSettings(ctx);
	return { noncesRemoved: removed, bridgeEnabled: settings.bridgeEnabled };
}

export async function runTask(ctx: Ctx, name: string) {
	const started = new Date().toISOString();
	try {
		const summary =
			name === "reconcile"
				? await reconcileApprovals(ctx)
				: name === "outbox"
					? await drainOutbox(ctx)
					: name === "leases"
						? await expireLeases(ctx)
						: name === "integrity"
							? await checkIntegrity(ctx)
							: name === "housekeeping"
								? await housekeeping(ctx)
								: name === "blueprints"
									? await blueprintTask(ctx as unknown as PluginContext)
									: name === "identity"
										? await identityTask(ctx as unknown as PluginContext)
										: name === "vigilance"
											? await vigilanceTask(ctx as never, await getReader())
											: name === "seals"
												? await reconcileSeals(ctx as never, await getReader())
												: name === "access-logs"
													? await accessLogsTask(ctx as never)
													: null;
		if (summary === null) return;
		await ctx.kv.set(`cron:last:${name}`, { at: started, ok: true, summary, error: null });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		await ctx.kv.set(`cron:last:${name}`, { at: started, ok: false, summary: null, error: message.slice(0, 500) });
		ctx.log.error(`Powerfarm task ${name} failed`, { error: message });
	}
}

export async function taskHealth(ctx: Pick<PluginContext, "kv">) {
	const out: Record<string, unknown> = {};
	for (const name of Object.keys(TASKS)) {
		// oxlint-disable-next-line no-await-in-loop
		out[name] = (await ctx.kv.get(`cron:last:${name}`)) ?? null;
	}
	return out;
}
