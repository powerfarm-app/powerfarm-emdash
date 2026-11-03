// End-to-end Mission 001 workflow through the real policy, job, bridge-service,
// evidence and reconciliation code, over a SQLite database built from the seed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";

import { BridgeRefusal, check, claim, report, uploadArtifact } from "../src/bridge-service.ts";
import { clearGraphCache } from "../src/graph.ts";
import { auditState } from "../src/journal.ts";
import { jobIdFor } from "../src/jobs.ts";
import { afterPublish, afterUnpublish, beforeDelete, beforePublish, beforeSave } from "../src/policy.ts";
import { expireLeases, reconcileApprovals } from "../src/reconcile.ts";
import { setReadPortFactory } from "../src/runtime.ts";
import { fakeCtx, type FakeCtx } from "./fake-ctx.ts";
import { TestDb } from "./sqlite-port.ts";

const ADMIN = { id: "admin-1", role: 50, source: "api" as const };
const BRIDGE = "lab-512-bridge";
const REAL = { devices: [{ ecid: "0x1A2B3C4D5E6F", deviceType: "iPhone14,5" }], mode: "real" as const, validatedOperations: ["inventory", "verify", "backup", "restore"] };
const observed = { ecid: "0x1a2b3c4d5e6f", serialNumber: "F2LXK0ABCD12", osVersion: "18.2" };

let db: TestDb;
let ctx: FakeCtx;

beforeEach(() => {
	clearGraphCache();
	db = new TestDb();
	setReadPortFactory(async () => db.port());
	ctx = fakeCtx();
	const mission = db.insert("missions", { title: "Mission 001", code: "M001" });
	const iphone = db.insert("assets", { title: "iPhone 13 RED", asset_tag: "IPHONE-13-RED", device_class: "iphone", role: "fleet", serial_number: "F2LXK0ABCD12", ecid: "0x1A2B3C4D5E6F", os_policy: ">=18.0" });
	db.insert("assets", { title: "LAB 512", asset_tag: "LAB-512", device_class: "mac_apple_silicon", role: "trusted_host" });
	db.link("missions_assets", mission.group, iphone.group);
	for (const [code, operation] of [["P-INVENTORY", "inventory"], ["P-IOS-BACKUP", "backup"], ["P-IOS-RESTORE", "restore"], ["P-VERIFY", "verify"]] as const) {
		db.insert("procedures", { title: code, code, operation, device_classes: ["iphone", "ipad"] });
	}
});

/** Publish an operation the way EmDash would: row becomes published, then the hooks run. */
async function approve(opCode: string, operation: string, procedure: string, extra: Record<string, unknown> = {}, actor = ADMIN, origin = "api") {
	const data = { title: opCode, op_code: opCode, asset_tag: "IPHONE-13-RED", procedure_code: procedure, mission_code: "M001", operation, dry_run: false, parameters: {}, ...extra };
	const row = db.insert("recovery_operations", data, { status: "draft", authorId: actor.id });
	const decision = await beforePublish({ collection: "recovery_operations", content: { id: row.id, authorId: actor.id, data }, origin: { source: origin }, actor } as never, ctx as never);
	if (decision) return { decision, id: row.id, revision: null };
	const revision = `rev_${opCode}_1`;
	db.db.prepare("update ec_recovery_operations set status='published', live_revision_id=?, draft_revision_id=? where id=?").run(revision, revision, row.id);
	await afterPublish({ collection: "recovery_operations", content: { id: row.id, liveRevisionId: revision, authorId: actor.id, data } }, ctx as never);
	return { decision: undefined, id: row.id, revision };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

async function runToSuccess(claimed: { id: string; leaseId: string; opRevision: string }, kind: string, withObserved = true) {
	await report(ctx as never, BRIDGE, { jobId: claimed.id, leaseId: claimed.leaseId, reportId: `r-start-${claimed.id}`, opRevision: claimed.opRevision, phase: "started" });
	const content = JSON.stringify({ kind, observed });
	await uploadArtifact(ctx as never, BRIDGE, { jobId: claimed.id, leaseId: claimed.leaseId }, { kind, filename: `${kind}.json`, contentType: "application/json", declaredSha256: sha(content), bytes: bytes(content) });
	return report(ctx as never, BRIDGE, { jobId: claimed.id, leaseId: claimed.leaseId, reportId: `r-done-${claimed.id}`, opRevision: claimed.opRevision, phase: "succeeded", observed: withObserved ? observed : undefined });
}

test("AI clients cannot approve; a person's approval produces exactly one job bound to the revision", async () => {
	const ai = await approve("OP-0001", "inventory", "P-INVENTORY", {}, { id: "ai-user", role: 40, source: "mcp" as never }, "mcp");
	assert.match(String((ai.decision as { reason: string }).reason), /person/);
	const ok = await approve("OP-0002", "inventory", "P-INVENTORY");
	assert.equal(ok.decision, undefined);
	const jobId = jobIdFor(ok.id, ok.revision!);
	assert.ok(await ctx.storage.jobs.get(jobId));
	// The hook firing twice, or reconciliation running, never creates a second job.
	await afterPublish({ collection: "recovery_operations", content: { id: ok.id, liveRevisionId: ok.revision, authorId: "admin-1", data: { op_code: "OP-0002", operation: "inventory", asset_tag: "IPHONE-13-RED", procedure_code: "P-INVENTORY", mission_code: "M001", dry_run: false } } }, ctx as never);
	await reconcileApprovals(ctx as never);
	assert.equal(ctx.storage.jobs.rows.size, 1);
});

test("reconciliation creates a missing job when the publish hook failed, and flags a missing revision", async () => {
	const data = { title: "x", op_code: "OP-0010", asset_tag: "IPHONE-13-RED", procedure_code: "P-INVENTORY", mission_code: "M001", operation: "inventory", dry_run: false };
	db.insert("recovery_operations", data, { status: "published" }); // published, but no afterPublish ran
	const noRev = db.insert("recovery_operations", { ...data, op_code: "OP-0011" }, { status: "published" });
	db.db.prepare("update ec_recovery_operations set live_revision_id=null where id=?").run(noRev.id);
	const result = await reconcileApprovals(ctx as never);
	assert.equal(result.created, 1);
	assert.equal(result.flagged, 1);
	assert.ok([...ctx.storage.reconciliations.rows.values()].some((r) => (r.value as { kind: string }).kind === "missing_revision"));
	assert.equal([...ctx.storage.jobs.rows.values()].length, 1, "no job without a revision");
});

test("a simulated bridge completes jobs that never count; only validated operations reach a real bridge", async () => {
	const { id, revision } = await approve("OP-0003", "inventory", "P-INVENTORY");
	const none = await claim(ctx as never, BRIDGE, { ...REAL, validatedOperations: [] });
	assert.equal(none.job, null, "real bridge without validated inventory gets nothing");
	const sim = await claim(ctx as never, BRIDGE, { ...REAL, mode: "simulated", validatedOperations: [] });
	assert.equal(sim.job!.executionMode, "simulated");
	await report(ctx as never, BRIDGE, { jobId: sim.job!.id, leaseId: sim.job!.leaseId!, reportId: "s1", opRevision: revision!, phase: "started" });
	const done = await report(ctx as never, BRIDGE, { jobId: sim.job!.id, leaseId: sim.job!.leaseId!, reportId: "s2", opRevision: revision!, phase: "succeeded", observed });
	assert.equal(done.status, "succeeded", "simulated success needs no evidence");
	const job = await ctx.storage.jobs.get(jobIdFor(id, revision!));
	assert.equal(job!.executionMode, "simulated");
	assert.equal((job!.result as { mode: string }).mode, "simulated");
});

test("real runs need server-verified evidence; wrong digests, wrong leases and replays are refused", async () => {
	const { revision } = await approve("OP-0004", "inventory", "P-INVENTORY");
	const { job } = await claim(ctx as never, BRIDGE, REAL);
	assert.equal(job!.executionMode, "real");
	const lease = job!.leaseId!;
	await assert.rejects(report(ctx as never, "other-bridge", { jobId: job!.id, leaseId: lease, reportId: "x", opRevision: revision!, phase: "started" }), /lease/);
	await assert.rejects(report(ctx as never, BRIDGE, { jobId: job!.id, leaseId: "lease_wrong", reportId: "x", opRevision: revision!, phase: "started" }), /lease/);
	await assert.rejects(report(ctx as never, BRIDGE, { jobId: job!.id, leaseId: lease, reportId: "x", opRevision: "rev_other", phase: "started" }), /revision/);
	const started = await report(ctx as never, BRIDGE, { jobId: job!.id, leaseId: lease, reportId: "r1", opRevision: revision!, phase: "started" });
	assert.equal(started.status, "running");
	assert.deepEqual(await report(ctx as never, BRIDGE, { jobId: job!.id, leaseId: lease, reportId: "r1", opRevision: revision!, phase: "started" }), started, "duplicate report replays its answer");

	await assert.rejects(report(ctx as never, BRIDGE, { jobId: job!.id, leaseId: lease, reportId: "r2", opRevision: revision!, phase: "succeeded", observed }), (e: BridgeRefusal) => e.code === "EVIDENCE_REQUIRED");
	const body = JSON.stringify({ observed });
	await assert.rejects(
		uploadArtifact(ctx as never, BRIDGE, { jobId: job!.id, leaseId: lease }, { kind: "inventory_report", filename: "i.json", contentType: "application/json", declaredSha256: sha("tampered"), bytes: bytes(body) }),
		(e: BridgeRefusal) => e.code === "DIGEST_MISMATCH",
	);
	await assert.rejects(
		uploadArtifact(ctx as never, BRIDGE, { jobId: job!.id, leaseId: lease }, { kind: "inventory_report", filename: "x.sh", contentType: "application/x-sh", declaredSha256: sha(body), bytes: bytes(body) }),
		(e: BridgeRefusal) => e.code === "BAD_TYPE",
	);
	const stored = await uploadArtifact(ctx as never, BRIDGE, { jobId: job!.id, leaseId: lease }, { kind: "inventory_report", filename: "i.json", contentType: "application/json", declaredSha256: sha(body), bytes: bytes(body) });
	assert.equal(stored.sha256, sha(body));
	const evidence = ctx.content.list_("evidence")[0]!;
	assert.equal(evidence.data.digest_status, "server_verified");
	assert.equal(evidence.data.asset_tag, "IPHONE-13-RED");
	assert.equal(evidence.data.op_revision, revision);
	assert.equal(evidence.data.job_id, job!.id);
	assert.equal(evidence.status, "published");
	assert.equal(ctx.media.items.size, 1);

	const done = await report(ctx as never, BRIDGE, { jobId: job!.id, leaseId: lease, reportId: "r3", opRevision: revision!, phase: "succeeded", observed });
	assert.equal(done.status, "succeeded");
	const final = await ctx.storage.jobs.get(job!.id);
	assert.equal((final!.result as { identity: { pass: boolean } }).identity.pass, true);
});

test("there is never a second active job on one asset", async () => {
	await approve("OP-0005", "inventory", "P-INVENTORY");
	const second = await approve("OP-0006", "inventory", "P-INVENTORY");
	assert.match(String((second.decision as { reason: string }).reason), /active job/);
});

test("changing an approved operation invalidates the old job; unpublished work cannot be claimed", async () => {
	const { id, revision } = await approve("OP-0007", "inventory", "P-INVENTORY");
	db.db.prepare("update ec_recovery_operations set live_revision_id='rev_changed' where id=?").run(id);
	assert.equal((await claim(ctx as never, BRIDGE, REAL)).job, null);
	assert.equal((await ctx.storage.jobs.get(jobIdFor(id, revision!)))!.status, "revoked");

	const b = await approve("OP-0008", "inventory", "P-INVENTORY");
	db.db.prepare("update ec_recovery_operations set status='draft' where id=?").run(b.id);
	await afterUnpublish({ collection: "recovery_operations", content: { id: b.id } }, ctx as never);
	assert.equal((await ctx.storage.jobs.get(jobIdFor(b.id, b.revision!)))!.status, "revoked");
	assert.equal((await claim(ctx as never, BRIDGE, REAL)).job, null);
});

test("an interrupted or silent destructive job needs inspection, keeps the device locked, and is never retried", async () => {
	// Real backup first, so the restore can be approved.
	const backup = await approve("OP-0020", "backup", "P-IOS-BACKUP");
	const b = await claim(ctx as never, BRIDGE, REAL);
	await runToSuccess({ id: b.job!.id, leaseId: b.job!.leaseId!, opRevision: backup.revision! }, "backup_manifest", false);

	const restore = await approve("OP-0021", "restore", "P-IOS-RESTORE", { data_decision: "backup_verified", backup_op_code: "OP-0020" });
	assert.equal(restore.decision, undefined, JSON.stringify(restore.decision));
	const r = await claim(ctx as never, BRIDGE, REAL);
	await report(ctx as never, BRIDGE, { jobId: r.job!.id, leaseId: r.job!.leaseId!, reportId: "go", opRevision: restore.revision!, phase: "started" });
	assert.equal((await check(ctx as never, BRIDGE, { jobId: r.job!.id, leaseId: r.job!.leaseId! })).proceed, true);

	// The bridge goes silent past its lease.
	const later = new Date(Date.now() + 3 * 60 * 60_000);
	const expired = await expireLeases(ctx as never, later);
	assert.equal(expired.inspection, 1);
	assert.equal((await ctx.storage.jobs.get(r.job!.id))!.status, "needs_inspection");

	// Nothing new can be approved or claimed for this device until a person inspects it.
	const retry = await approve("OP-0022", "restore", "P-IOS-RESTORE", { data_decision: "no_user_data", rationale: "Trying again straight away after the hang." });
	assert.ok(retry.decision, "retry refused");
	assert.match(String((retry.decision as { reason: string }).reason), /unknown outcome|active job/);
});

test("the bridge reporting an interruption mid-restore records needs_inspection, not failure", async () => {
	const backup = await approve("OP-0030", "backup", "P-IOS-BACKUP");
	const b = await claim(ctx as never, BRIDGE, REAL);
	await runToSuccess({ id: b.job!.id, leaseId: b.job!.leaseId!, opRevision: backup.revision! }, "backup_manifest", false);
	const restore = await approve("OP-0031", "restore", "P-IOS-RESTORE", { data_decision: "backup_verified", backup_op_code: "OP-0030" });
	const r = await claim(ctx as never, BRIDGE, REAL);
	await report(ctx as never, BRIDGE, { jobId: r.job!.id, leaseId: r.job!.leaseId!, reportId: "1", opRevision: restore.revision!, phase: "started" });
	const res = await report(ctx as never, BRIDGE, { jobId: r.job!.id, leaseId: r.job!.leaseId!, reportId: "2", opRevision: restore.revision!, phase: "interrupted", message: "SIGTERM" });
	assert.equal(res.status, "needs_inspection");
});

test("the bridge never receives work for its own host", async () => {
	const host = await approve("OP-0040", "inventory", "P-INVENTORY", { asset_tag: "LAB-512" });
	assert.ok(host.decision);
});

test("evidence: files are hashed by the server, edits and AI writes are refused, history cannot be deleted", async () => {
	const file = await ctx.media.upload("shot.png", "image/png", bytes("pixels").buffer as ArrayBuffer);
	const content: Record<string, unknown> = { title: "Screenshot", evidence_type: "screenshot", asset_tag: "IPHONE-13-RED", file: { id: file.mediaId } };
	await beforeSave({ collection: "evidence", content, isNew: true, actor: ADMIN } as never, ctx as never);
	assert.equal(content.sha256, sha("pixels"));
	assert.equal(content.digest_status, "server_verified");
	const wrong = { ...content, sha256: sha("other") };
	await assert.rejects(beforeSave({ collection: "evidence", content: wrong, isNew: true, actor: ADMIN } as never, ctx as never), /does not match/);
	await assert.rejects(beforeSave({ collection: "evidence", content: { title: "x", evidence_type: "log" }, isNew: true, actor: { id: "ai", role: 40, source: "mcp" } } as never, ctx as never), /AI/);
	await assert.rejects(beforeSave({ collection: "evidence", content: { title: "x" }, isNew: false, actor: ADMIN } as never, ctx as never), /append-only/);
	await assert.rejects(beforeSave({ collection: "events", content: { title: "x" }, isNew: true, actor: ADMIN } as never, ctx as never), /journal/);
	assert.equal(await beforeDelete({ collection: "evidence", id: "e1", permanent: false } as never, ctx as never), false);
	assert.equal(await beforeDelete({ collection: "events", id: "e1", permanent: true } as never, ctx as never), false);
});

test("trust sign-off needs an administrator and a device that is currently verified", async () => {
	const signoff = (actor: { id: string; role: number; source?: string }) =>
		beforeSave({ collection: "evidence", content: { title: "Sign-off", evidence_type: "attestation", attests: "trust_signoff", asset_tag: "IPHONE-13-RED" }, isNew: true, actor } as never, ctx as never);
	await assert.rejects(signoff({ id: "e", role: 40, source: "api" }), /administrator/);
	await assert.rejects(signoff(ADMIN), /not "verified"/);
});

test("AI clients cannot publish procedures, assets, missions or evidence either", async () => {
	for (const collection of ["procedures", "assets", "missions", "evidence"]) {
		const d = await beforePublish({ collection, content: { id: "x", data: {} }, origin: { source: "mcp" }, actor: { id: "ai", role: 50, source: "mcp" } } as never, ctx as never);
		assert.ok(d && (d as { cancel: boolean }).cancel, collection);
	}
	assert.equal(await beforePublish({ collection: "procedures", content: { id: "x", data: {} }, origin: { source: "api" }, actor: ADMIN } as never, ctx as never), undefined);
});

test("AI clients cannot change a device's identity", async () => {
	const [row] = db.db.prepare("select id from ec_assets where asset_tag='IPHONE-13-RED'").all() as Array<{ id: string }>;
	await assert.rejects(
		beforeSave({ collection: "assets", id: row!.id, content: { serial_number: "AAAAAAAAAAAA" }, isNew: false, actor: { id: "ai", role: 40, source: "mcp" } } as never, ctx as never),
		/identity/,
	);
	assert.equal((await auditState(ctx as never)).degraded, false);
});
