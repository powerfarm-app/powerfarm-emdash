/**
 * Media-backed evidence.
 *
 * The bridge uploads each artifact (inventory report, verification report,
 * backup manifest, restore log) as bytes. The server checks the size and type,
 * computes the SHA-256 itself and refuses the upload if it differs from what the
 * bridge declared, stores the bytes with EmDash's media API, and records an
 * Evidence entry bound to the asset, operation, approved revision and job.
 * A path on the bridge machine is never accepted as evidence.
 */

import type { PluginContext } from "emdash";

import { record, streamForAsset } from "./journal.js";
import { jobsOf, type Ctx } from "./jobs.js";
import type { Job } from "./model.js";

export const ARTIFACT_KINDS = ["inventory_report", "verification_report", "backup_manifest", "restore_log", "install_log", "log"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_TYPES: Readonly<Record<string, string>> = {
	"application/json": "json",
	"text/plain": "txt",
	"application/pdf": "pdf",
	"image/png": "png",
	"image/jpeg": "jpg",
};

const EVIDENCE_TYPE: Record<ArtifactKind, string> = {
	inventory_report: "report",
	verification_report: "report",
	backup_manifest: "manifest",
	restore_log: "log",
	install_log: "log",
	log: "log",
};

export class ArtifactRejected extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 422) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ArtifactInput {
	kind: string;
	filename: string;
	contentType: string;
	declaredSha256: string;
	bytes: Uint8Array;
}

export async function storeArtifact(
	ctx: Ctx & Pick<PluginContext, "media">,
	job: Job,
	bridgeId: string,
	input: ArtifactInput,
	maxBytes: number,
): Promise<{ evidenceId: string; mediaId: string; sha256: string }> {
	if (!(ARTIFACT_KINDS as readonly string[]).includes(input.kind)) throw new ArtifactRejected("BAD_KIND", `Unknown artifact kind ${input.kind}`);
	const mime = input.contentType.split(";")[0]!.trim().toLowerCase();
	const extension = ARTIFACT_TYPES[mime];
	if (!extension) throw new ArtifactRejected("BAD_TYPE", `Artifacts must be one of: ${Object.keys(ARTIFACT_TYPES).join(", ")}`, 415);
	if (input.bytes.byteLength === 0) throw new ArtifactRejected("EMPTY", "Empty artifact");
	if (input.bytes.byteLength > maxBytes) throw new ArtifactRejected("TOO_LARGE", `Artifact exceeds ${maxBytes} bytes`, 413);
	if (!/^[a-f0-9]{64}$/.test(input.declaredSha256.toLowerCase())) throw new ArtifactRejected("BAD_DIGEST", "Declared SHA-256 must be 64 hex characters");

	const sha256 = await sha256Hex(input.bytes);
	if (sha256 !== input.declaredSha256.toLowerCase()) {
		throw new ArtifactRejected("DIGEST_MISMATCH", `Declared SHA-256 does not match the uploaded bytes (server computed ${sha256})`);
	}
	if (!ctx.media?.upload) throw new ArtifactRejected("NO_MEDIA", "media:write is not granted", 500);
	if (!ctx.content?.create) throw new ArtifactRejected("NO_CONTENT", "content:write is not granted", 500);

	const safeName = `${job.opCode}-${input.kind}-${sha256.slice(0, 12)}.${extension}`;
	const ab = input.bytes.buffer.slice(input.bytes.byteOffset, input.bytes.byteOffset + input.bytes.byteLength) as ArrayBuffer;
	const uploaded = await ctx.media.upload(safeName, mime, ab);
	const created = await ctx.content.create("evidence", {
		title: `${job.opCode} ${input.kind.replace(/_/g, " ")}`,
		evidence_type: EVIDENCE_TYPE[input.kind as ArtifactKind],
		artifact_kind: input.kind,
		asset_tag: job.assetTag,
		op_code: job.opCode,
		job_id: job.id,
		op_revision: job.opRevision,
		captured_at: new Date().toISOString(),
		file: { id: uploaded.mediaId },
		media_id: uploaded.mediaId,
		sha256,
		size_bytes: input.bytes.byteLength,
		original_filename: input.filename.slice(0, 200),
		mime_type: mime,
		digest_status: "server_verified",
		execution_mode: job.executionMode,
		description: `Uploaded by bridge ${bridgeId}. SHA-256 computed by the server from the stored bytes.`,
	});
	if (ctx.content.getVersioned && ctx.content.publish) {
		const v = await ctx.content.getVersioned("evidence", created.id);
		if (v) await ctx.content.publish("evidence", created.id, { _rev: v._rev });
	}

	// Attach to the job. Guarded by the lease so a superseded bridge cannot attach.
	for (let attempt = 0; attempt < 5; attempt++) {
		// oxlint-disable-next-line no-await-in-loop -- bounded CAS retry
		const current = await jobsOf(ctx).getVersioned(job.id);
		if (!current) break;
		const next = { ...current.value, evidence: [...current.value.evidence, { kind: input.kind, evidenceId: created.id, mediaId: uploaded.mediaId, sha256 }] };
		// oxlint-disable-next-line no-await-in-loop
		if ((await jobsOf(ctx).compareAndSet(job.id, current.revision, next)).applied) break;
	}

	await record(ctx, {
		type: "evidence.recorded",
		stream: streamForAsset(job.assetTag),
		actor: `bridge:${bridgeId}`,
		source: "evidence",
		title: `${job.opCode} ${input.kind} recorded (${input.bytes.byteLength} bytes)`,
		assetTag: job.assetTag,
		opCode: job.opCode,
		jobId: job.id,
		payload: { kind: input.kind, sha256, mediaId: uploaded.mediaId, size: input.bytes.byteLength },
		evidenceIds: [created.id],
		idempotencyKey: `evidence:${job.id}:${sha256}`,
	});
	return { evidenceId: created.id, mediaId: uploaded.mediaId, sha256 };
}

/** Evidence kinds a job still lacks. Only real executions need evidence. */
export function missingEvidence(job: Job): string[] {
	if (job.executionMode !== "real") return [];
	const have = new Set(job.evidence.map((e) => e.kind));
	return job.requiredEvidence.filter((k) => k !== "attestation" && !have.has(k));
}
