/**
 * Manual operations: things only a person can do (Finder DFU, macOS Recovery,
 * reading a serial number off a Mac, security setup). The approval is the same
 * publication as for bridge operations; the person then starts the job, does
 * the work, and completes it with the outcome, the observed identifiers where
 * relevant, and the Evidence entries that back it up.
 *
 * These routes are session-only: an API token or an MCP client cannot complete
 * a manual job.
 */

import { record, streamForAsset } from "./journal.js";
import { acquireAssetLock, jobsOf, releaseAssetLock, transitionJob, type Ctx } from "./jobs.js";
import { type Job, operationSpec, ROLE } from "./model.js";
import { normalizeEcid, verifyIdentity } from "./recovery.js";
import type { ContentReader } from "./content.js";

export class ManualRefusal extends Error {
	readonly status: number;
	constructor(message: string, status = 409) {
		super(message);
		this.status = status;
	}
}

export async function startManual(ctx: Ctx, user: { id: string; role: number }, jobId: string): Promise<Job> {
	if (user.role < ROLE.EDITOR) throw new ManualRefusal("Only editors and administrators can carry out recovery operations.", 403);
	const job = await jobsOf(ctx).get(jobId);
	if (!job) throw new ManualRefusal("No such job.", 404);
	const spec = operationSpec(job.operation);
	if (spec?.adapter !== "manual") throw new ManualRefusal("This operation is executed by the bridge.");
	if (job.status !== "approved") throw new ManualRefusal(`The job is ${job.status}.`);
	if (spec.destructive && !job.dryRun && user.role < ROLE.ADMIN) throw new ManualRefusal("Destructive manual operations are carried out by an administrator.", 403);
	if (!(await acquireAssetLock(ctx, job.assetTag, job.id))) throw new ManualRefusal("Another job is active on this device.");
	const now = new Date();
	const operator = `operator:${user.id}`;
	const claimed = await transitionJob(
		ctx,
		job,
		"approved",
		"claimed",
		{ claimedBy: operator, claimedAt: now.toISOString(), leaseId: `manual_${crypto.randomUUID()}`, leaseExpiresAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(), executionMode: job.dryRun ? "dry_run" : "real" },
		{ actor: operator, source: "admin" },
	);
	if (!claimed) {
		await releaseAssetLock(ctx, job.assetTag, job.id);
		throw new ManualRefusal("The job changed; reload.");
	}
	const running = await transitionJob(ctx, claimed, "claimed", "running", { startedAt: now.toISOString() }, { actor: operator, source: "admin" });
	if (!running) throw new ManualRefusal("Could not start the job.");
	return running;
}

export interface ManualCompletion {
	outcome: "succeeded" | "failed";
	note: string;
	evidenceIds: string[];
	observed?: { serialNumber?: string; ecid?: string; osVersion?: string; buildVersion?: string };
}

export async function completeManual(ctx: Ctx, reader: ContentReader, user: { id: string; role: number }, jobId: string, input: ManualCompletion): Promise<Job> {
	const job = await jobsOf(ctx).get(jobId);
	if (!job) throw new ManualRefusal("No such job.", 404);
	const operator = `operator:${user.id}`;
	if (job.status !== "running" || job.claimedBy !== operator) throw new ManualRefusal("Only the person who started this job can complete it.", 403);
	const spec = operationSpec(job.operation)!;
	const now = new Date().toISOString();

	if (input.outcome === "failed") {
		const failed = await transitionJob(ctx, job, "running", "failed", { lastMessage: input.note, finishedAt: now }, { actor: operator, source: "admin", payload: { note: input.note } });
		if (!failed) throw new ManualRefusal("The job changed; reload.");
		return failed;
	}

	// Success needs evidence recorded for this operation by a person or the bridge.
	const evidence = input.evidenceIds.length ? (await reader.byField("evidence", "op_code", [job.opCode], "draft", 200)).filter((e) => input.evidenceIds.includes(e.id)) : [];
	if (job.executionMode === "real") {
		if (evidence.length === 0) throw new ManualRefusal("Attach at least one Evidence entry recorded for this operation (same operation code).");
		const files = evidence.filter((e) => e.data.digest_status === "server_verified");
		const attestations = evidence.filter((e) => e.data.evidence_type === "attestation");
		if (spec.requiredEvidence.includes("attestation") ? attestations.length === 0 : files.length === 0) {
			throw new ManualRefusal(spec.requiredEvidence.includes("attestation") ? "Attach an attestation for this operation." : "Attach a file (screenshot or report) whose digest the server verified.");
		}
	}

	const result: Record<string, unknown> = { mode: job.executionMode, note: input.note };
	if (spec.readOnly) {
		if (!input.observed?.serialNumber) throw new ManualRefusal("Enter the serial number you read from the device.");
		const asset = await reader.resolve("assets", job.assetTag, "published");
		const observed = { ...input.observed, ecid: input.observed.ecid ? normalizeEcid(input.observed.ecid) ?? input.observed.ecid : undefined };
		result.observed = observed;
		const identity = verifyIdentity(
			{
				ecid: (asset?.data.ecid as string) ?? null,
				serialNumber: (asset?.data.serial_number as string) ?? null,
				osPolicy: (asset?.data.os_policy as string) ?? null,
				deviceClass: (asset?.data.device_class as string) ?? null,
			},
			observed,
		);
		result.identity = job.operation.includes("verify") ? identity : { pass: identity.checks.filter((c) => c.field !== "osVersion").every((c) => c.pass), checks: identity.checks.filter((c) => c.field !== "osVersion") };
	}
	const evidenceRefs = evidence.map((e) => ({ kind: e.data.evidence_type === "attestation" ? "attestation" : String(e.data.artifact_kind ?? spec.requiredEvidence.find((k) => k !== "attestation") ?? "log"), evidenceId: e.id, mediaId: (e.data.media_id as string) ?? null, sha256: String(e.data.sha256 ?? "") }));
	const done = await transitionJob(
		ctx,
		job,
		"running",
		"succeeded",
		{ lastMessage: input.note, finishedAt: now, result, evidence: [...job.evidence, ...evidenceRefs] },
		{ actor: operator, source: "admin", evidenceIds: evidence.map((e) => e.id) },
	);
	if (!done) throw new ManualRefusal("The job changed; reload.");
	if (job.parameters.recordOnly === true) {
		await record(ctx, {
			type: "operation.recorded_after_the_fact",
			stream: streamForAsset(job.assetTag),
			actor: operator,
			source: "admin",
			title: `${job.opCode} records a ${job.operation} performed outside the platform`,
			assetTag: job.assetTag,
			opCode: job.opCode,
			jobId: job.id,
			idempotencyKey: `job:${job.id}:record-only`,
		});
	}
	return done;
}
