/**
 * What the Apple Hardware Bridge may do, independent of HTTP wiring.
 *
 * The bridge pulls work; nothing is pushed to it. It can claim an approved job
 * for a connected device, start it, report progress and the outcome, upload
 * evidence, and report its own health. Every call after the claim must present
 * the lease id issued at the claim and the exact approved revision.
 */

import type { PluginContext } from "emdash";

import { ArtifactRejected, missingEvidence, storeArtifact, type ArtifactInput } from "./evidence.js";
import { record } from "./journal.js";
import { acquireAssetLock, jobsOf, readSettings, releaseAssetLock, transitionJob, type Ctx } from "./jobs.js";
import { type ExecutionMode, type Job, operationSpec } from "./model.js";
import { normalizeEcid, verifyIdentity } from "./recovery.js";
import { getReader } from "./runtime.js";

export type BridgeCtx = Ctx & Pick<PluginContext, "media">;

export class BridgeRefusal extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 409) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

export interface Device {
	ecid?: string;
	serialNumber?: string;
	deviceType?: string;
}

/** Is the operation still published at exactly the revision this job was created for? Missing data fails closed. */
export async function stillApproved(job: Job): Promise<{ ok: boolean; reason?: string }> {
	if (!job.opRevision) return { ok: false, reason: "The job has no approved revision." };
	const reader = await getReader();
	const op = await reader.resolve("recovery_operations", job.opId, "published");
	if (!op) return { ok: false, reason: "The operation is no longer published (approved)." };
	if (!op.liveRevisionId) return { ok: false, reason: "The published operation has no revision id." };
	if (op.liveRevisionId !== job.opRevision) return { ok: false, reason: "The operation was changed after this job was approved." };
	return { ok: true };
}

function deviceTypeClass(deviceType: string | undefined): string | null {
	if (!deviceType) return null;
	if (/^iPhone/i.test(deviceType)) return "iphone";
	if (/^iPad/i.test(deviceType)) return "ipad";
	if (/^(Mac|iMac|MacBook)/i.test(deviceType)) return "mac";
	return null;
}

export interface ClaimInput {
	devices: Device[];
	mode: "real" | "simulated";
	validatedOperations: string[];
	bridgeVersion?: string;
}

export async function claim(ctx: BridgeCtx, bridgeId: string, input: ClaimInput): Promise<{ job: Job | null; procedure?: unknown }> {
	const settings = await readSettings(ctx);
	if (!settings.bridgeEnabled) throw new BridgeRefusal("BRIDGE_DISABLED", "The bridge is disabled in Powerfarm settings.", 403);
	const connected = new Map(input.devices.map((d) => [normalizeEcid(d.ecid ?? ""), d]));
	const page = await jobsOf(ctx).query({ where: { status: "approved" }, orderBy: { updatedAt: "asc" }, limit: 50 });

	for (const { data: job } of page.items) {
		const spec = operationSpec(job.operation);
		if (!spec || spec.adapter !== "bridge") continue; // manual operations are done by people
		if (job.assetTag.toUpperCase() === settings.hostAssetTag) continue;
		// A real bridge only receives operations it has validated on its host.
		if (input.mode === "real" && !input.validatedOperations.includes(job.operation)) continue;

		let target: Device | undefined;
		if (job.ecid) target = connected.get(normalizeEcid(job.ecid));
		else if (job.operation === "inventory" && input.devices.length === 1 && deviceTypeClass(input.devices[0]!.deviceType) === job.deviceClass) target = input.devices[0];
		if (!target) continue;

		// oxlint-disable-next-line no-await-in-loop -- stop at the first claimable job
		const approval = await stillApproved(job);
		if (!approval.ok) {
			// oxlint-disable-next-line no-await-in-loop
			await transitionJob(ctx, job, "approved", "revoked", { lastMessage: approval.reason ?? null }, { actor: "powerfarm", source: "bridge" });
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop
		if (!(await acquireAssetLock(ctx, job.assetTag, job.id))) continue;

		const now = new Date();
		const mode: ExecutionMode = job.dryRun ? "dry_run" : input.mode;
		// oxlint-disable-next-line no-await-in-loop
		const claimed = await transitionJob(
			ctx,
			job,
			"approved",
			"claimed",
			{
				claimedBy: bridgeId,
				claimedAt: now.toISOString(),
				leaseId: `lease_${crypto.randomUUID()}`,
				leaseExpiresAt: new Date(now.getTime() + settings.claimLeaseMinutes * 60_000).toISOString(),
				executionMode: mode,
			},
			{ actor: `bridge:${bridgeId}`, source: "bridge", payload: { mode, bridgeVersion: input.bridgeVersion ?? null, devices: input.devices.length } },
		);
		if (!claimed) {
			// oxlint-disable-next-line no-await-in-loop
			await releaseAssetLock(ctx, job.assetTag, job.id);
			continue;
		}
		// oxlint-disable-next-line no-await-in-loop
		const reader = await getReader();
		// oxlint-disable-next-line no-await-in-loop
		const procedure = await reader.resolve("procedures", job.procedureCode, "published");
		return {
			job: claimed,
			procedure: procedure
				? {
						code: procedure.key,
						title: procedure.title,
						physicalSteps: procedure.data.physical_steps ?? null,
						expectedResults: procedure.data.expected_results ?? null,
						failureInstructions: procedure.data.failure_instructions ?? null,
					}
				: null,
		};
	}
	return { job: null };
}

async function ownedJob(ctx: BridgeCtx, bridgeId: string, jobId: string, leaseId: string): Promise<Job> {
	const job = await jobsOf(ctx).get(jobId);
	if (!job || job.claimedBy !== bridgeId || !job.leaseId || job.leaseId !== leaseId) {
		throw new BridgeRefusal("NOT_YOUR_JOB", "This bridge does not hold the lease for that job.", 403);
	}
	return job;
}

export async function check(ctx: BridgeCtx, bridgeId: string, input: { jobId: string; leaseId: string }) {
	const job = await ownedJob(ctx, bridgeId, input.jobId, input.leaseId);
	if (job.status !== "claimed" && job.status !== "running") return { proceed: false, status: job.status, reason: job.lastMessage ?? `Job is ${job.status}.` };
	const approval = await stillApproved(job);
	if (!approval.ok) {
		if (job.status === "claimed") {
			await transitionJob(ctx, job, "claimed", "revoked", { lastMessage: approval.reason ?? null }, { actor: "powerfarm", source: "bridge" });
			return { proceed: false, status: "revoked", reason: approval.reason };
		}
		return { proceed: false, status: job.status, reason: approval.reason };
	}
	return { proceed: true, status: job.status };
}

export interface ReportInput {
	jobId: string;
	leaseId: string;
	reportId: string;
	opRevision: string;
	phase: "started" | "progress" | "succeeded" | "failed" | "interrupted";
	message?: string;
	observed?: Record<string, unknown>;
	result?: Record<string, unknown>;
}

export async function report(ctx: BridgeCtx, bridgeId: string, input: ReportInput) {
	// A retried report returns the original answer instead of applying twice.
	const dedupeKey = `report:${input.jobId}:${input.reportId}`;
	const seen = await ctx.kv.get<Record<string, unknown>>(dedupeKey);
	if (seen) return seen;

	const job = await ownedJob(ctx, bridgeId, input.jobId, input.leaseId);
	if (input.opRevision !== job.opRevision) throw new BridgeRefusal("REVISION_MISMATCH", "Report is for a different approved revision.", 409);
	const settings = await readSettings(ctx);
	const lease = new Date(Date.now() + settings.claimLeaseMinutes * 60_000).toISOString();
	const message = input.message?.slice(0, 2000) ?? null;
	const opts = { actor: `bridge:${bridgeId}`, source: "bridge" as const, guard: { leaseId: input.leaseId } };
	const spec = operationSpec(job.operation)!;
	let next: Job | null = null;
	let refusal: string | null = null;

	switch (input.phase) {
		case "started": {
			const approval = await stillApproved(job);
			if (!approval.ok) {
				await transitionJob(ctx, job, "claimed", "revoked", { lastMessage: approval.reason ?? null }, opts);
				refusal = approval.reason ?? "Not approved";
				break;
			}
			next = await transitionJob(ctx, job, "claimed", "running", { lastMessage: message, leaseExpiresAt: lease, startedAt: new Date().toISOString() }, opts);
			break;
		}
		case "progress":
			next = await transitionJob(ctx, job, "running", "running", { lastMessage: message, leaseExpiresAt: lease }, opts);
			break;
		case "succeeded": {
			const missing = missingEvidence(job);
			if (missing.length > 0) throw new BridgeRefusal("EVIDENCE_REQUIRED", `Upload the required evidence first: ${missing.join(", ")}.`, 409);
			const result: Record<string, unknown> = { ...(input.result ?? {}), mode: job.executionMode };
			if (spec.readOnly && input.observed) {
				result.observed = input.observed;
				const reader = await getReader();
				const asset = await reader.resolve("assets", job.assetTag, "published");
				const identity = verifyIdentity(
					{
						ecid: (asset?.data.ecid as string) ?? null,
						serialNumber: (asset?.data.serial_number as string) ?? null,
						osPolicy: job.operation === "verify" ? ((asset?.data.os_policy as string) ?? null) : null,
						deviceClass: (asset?.data.device_class as string) ?? null,
					},
					input.observed,
				);
				// Inventory confirms identity; the OS acceptance policy applies to verification only.
				result.identity =
					job.operation === "verify" ? identity : { pass: identity.checks.filter((c) => c.field !== "osVersion").every((c) => c.pass), checks: identity.checks.filter((c) => c.field !== "osVersion") };
			}
			next = await transitionJob(ctx, job, "running", "succeeded", { lastMessage: message, result, leaseExpiresAt: null, finishedAt: new Date().toISOString() }, opts);
			break;
		}
		case "failed":
			next =
				(await transitionJob(ctx, job, "running", "failed", { lastMessage: message, result: input.result ?? null, leaseExpiresAt: null, finishedAt: new Date().toISOString() }, opts)) ??
				(await transitionJob(ctx, job, "claimed", "failed", { lastMessage: message, leaseExpiresAt: null, finishedAt: new Date().toISOString() }, opts));
			break;
		case "interrupted":
			// The bridge stopped mid-operation. For anything that changes a device the outcome is unknown.
			next = await transitionJob(
				ctx,
				job,
				"running",
				spec.readOnly ? "failed" : "needs_inspection",
				{ lastMessage: message ?? "Interrupted", leaseExpiresAt: null, finishedAt: new Date().toISOString() },
				opts,
			);
			break;
	}

	const current = next ?? (await jobsOf(ctx).get(job.id));
	const response = refusal
		? { proceed: false, status: "revoked", reason: refusal }
		: next
			? { proceed: next.status === "claimed" || next.status === "running", status: next.status }
			: { proceed: false, status: current?.status ?? "missing", reason: current?.lastMessage ?? "Transition not allowed." };
	await ctx.kv.compareAndSet(dedupeKey, null, response);
	return response;
}

export async function uploadArtifact(ctx: BridgeCtx, bridgeId: string, meta: { jobId: string; leaseId: string }, artifact: ArtifactInput) {
	const job = await ownedJob(ctx, bridgeId, meta.jobId, meta.leaseId);
	if (job.status !== "running") throw new BridgeRefusal("NOT_RUNNING", `Evidence can only be uploaded while the job is running (it is ${job.status}).`);
	const settings = await readSettings(ctx);
	try {
		return await storeArtifact(ctx, job, bridgeId, artifact, settings.maxArtifactBytes);
	} catch (error) {
		if (error instanceof ArtifactRejected) throw new BridgeRefusal(error.code, error.message, error.status);
		throw error;
	}
}

export interface HealthInput {
	bridgeVersion: string;
	macosVersion: string | null;
	cfgutilPath: string | null;
	cfgutilVersion: string | null;
	mode: "real" | "simulated";
	adapters: Array<{ id: string; deviceClasses: string[]; operations: Array<{ name: string; validated: boolean; reason?: string }> }>;
	devices: number;
}

export async function health(ctx: BridgeCtx, bridgeId: string, input: HealthInput) {
	const store = (ctx.storage as Record<string, { get(id: string): Promise<unknown>; put(id: string, v: unknown): Promise<void> }>).bridges!;
	const previous = (await store.get(bridgeId)) as { validatedOperations?: string[]; bridgeVersion?: string } | null;
	const validated = input.adapters.flatMap((a) => a.operations.filter((o) => o.validated).map((o) => o.name)).sort();
	const unsupported = input.adapters.flatMap((a) => a.operations.filter((o) => !o.validated).map((o) => `${o.name}${o.reason ? `: ${o.reason}` : ""}`));
	const now = new Date().toISOString();
	await store.put(bridgeId, { id: bridgeId, ...input, validatedOperations: validated, unsupportedOperations: unsupported, lastSeenAt: now, status: "online" });
	if (!previous || previous.bridgeVersion !== input.bridgeVersion || JSON.stringify(previous.validatedOperations ?? []) !== JSON.stringify(validated)) {
		await record(ctx, {
			type: "bridge.capabilities",
			stream: "system",
			actor: `bridge:${bridgeId}`,
			source: "bridge",
			title: `Bridge ${bridgeId} ${input.bridgeVersion} (${input.mode}): ${validated.length ? validated.join(", ") : "no validated operations"}`,
			payload: { macosVersion: input.macosVersion, cfgutilVersion: input.cfgutilVersion, validated, unsupported },
			idempotencyKey: `bridge:${bridgeId}:caps:${input.bridgeVersion}:${validated.join(",")}:${input.mode}`,
		});
	}
	return { recorded: true, validatedOperations: validated };
}
