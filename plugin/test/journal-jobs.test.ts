// Journal integrity, outbox projection, job creation and transitions.
import assert from "node:assert/strict";
import { test } from "node:test";

import { acquireAssetLock, assetLockHolder, buildJob, createJobOnce, jobIdFor, resolveInspection, transitionJob } from "../src/jobs.ts";
import { acknowledgeDegraded, appendJournal, auditState, drainOutbox, JournalError, record, verifyChain } from "../src/journal.ts";
import { fakeCtx } from "./fake-ctx.ts";

const op = (over: Record<string, unknown> = {}, rev: string | null = "rev-1") => ({
	opId: "op-1",
	liveRevisionId: rev,
	authorId: "u1",
	data: { op_code: "OP-0001", operation: "inventory", asset_tag: "IPHONE-13-RED", procedure_code: "P-INVENTORY", mission_code: "M001", dry_run: false, ...over },
});
const context = { asset: { assetTag: "IPHONE-13-RED", deviceClass: "iphone", ecid: "0x1A2B", serialNumber: "F2LXK0ABCD12" }, approvedBy: "user:u1", approvedAt: new Date().toISOString() };

test("journal entries are sequenced per stream and hash-chained; tampering is detected", async () => {
	const ctx = fakeCtx();
	for (let i = 0; i < 3; i++) await appendJournal(ctx as never, { type: "t", stream: "asset:X", actor: "a", source: "system", title: `e${i}` });
	await appendJournal(ctx as never, { type: "t", stream: "system", actor: "a", source: "system", title: "other stream" });
	const seqs = [...ctx.storage.journal.rows.values()].filter((r) => (r.value as { stream: string }).stream === "asset:X").map((r) => (r.value as { seq: number }).seq);
	assert.deepEqual(seqs.sort(), [1, 2, 3]);
	assert.deepEqual(await verifyChain(ctx as never, "asset:X"), { ok: true, checked: 3 });

	const [key, row] = [...ctx.storage.journal.rows.entries()].find(([, r]) => (r.value as { seq: number; stream: string }).seq === 2 && (r.value as { stream: string }).stream === "asset:X")!;
	(row.value as { title: string }).title = "rewritten";
	assert.equal((await verifyChain(ctx as never, "asset:X")).ok, false, "modified entry");
	(row.value as { title: string }).title = "e1";
	ctx.storage.journal.rows.delete(key);
	assert.match((await verifyChain(ctx as never, "asset:X")).problem ?? "", /Missing or reordered/);
});

test("appends are idempotent on their key", async () => {
	const ctx = fakeCtx();
	const a = await appendJournal(ctx as never, { type: "t", stream: "s", actor: "a", source: "system", title: "x", idempotencyKey: "k1" });
	const b = await appendJournal(ctx as never, { type: "t", stream: "s", actor: "a", source: "system", title: "x", idempotencyKey: "k1" });
	assert.equal(a.seq, b.seq);
	assert.equal(ctx.storage.journal.rows.size, 1);
});

test("a failed append throws and degrades the audit; it is never swallowed", async () => {
	const ctx = fakeCtx();
	ctx.storage.journal.failNextPut = 1;
	await assert.rejects(appendJournal(ctx as never, { type: "t", stream: "s", actor: "a", source: "system", title: "x" }), JournalError);
	assert.equal((await auditState(ctx as never)).degraded, true);
});

test("projection failures are retried by the outbox and the content copy is created once", async () => {
	const ctx = fakeCtx();
	ctx.content.failCreates = 1;
	const entry = await record(ctx as never, { type: "job.claimed", stream: "asset:X", actor: "bridge", source: "bridge", title: "claimed" });
	assert.equal([...ctx.storage.journal.rows.values()][0]!.value.projectionStatus, "failed");
	assert.equal(ctx.content.list_("events").length, 0);
	const drained = await drainOutbox(ctx as never);
	assert.equal(drained.projected, 1);
	assert.equal(ctx.content.list_("events").length, 1);
	assert.equal(ctx.content.list_("events")[0]!.data.journal_id, entry.eventId);
	assert.equal(ctx.content.list_("events")[0]!.status, "published");
	await drainOutbox(ctx as never);
	assert.equal(ctx.content.list_("events").length, 1, "no duplicate projection");
});

test("degraded audit can only be cleared once chains verify and the outbox is empty", async () => {
	const ctx = fakeCtx();
	ctx.content.failCreates = 1;
	await record(ctx as never, { type: "t", stream: "asset:X", actor: "a", source: "system", title: "x" });
	ctx.storage.journal.failNextPut = 1;
	await assert.rejects(appendJournal(ctx as never, { type: "t", stream: "asset:Y", actor: "a", source: "system", title: "y" }));
	const first = await acknowledgeDegraded(ctx as never, "user:u1");
	assert.equal(first.cleared, false);
	assert.ok(first.problems.some((p) => /not yet projected/.test(p)));
	await drainOutbox(ctx as never);
	// The failed append advanced asset:Y's head without storing the entry: a visible gap.
	const second = await acknowledgeDegraded(ctx as never, "user:u1");
	assert.equal(second.cleared, false);
	assert.ok(second.problems.some((p) => /asset:Y/.test(p)));
});

test("a published approval produces exactly one job, keyed by its revision; no revision, no job", async () => {
	const ctx = fakeCtx();
	const job = buildJob(op(), context);
	assert.ok(!("error" in job));
	const first = await createJobOnce(ctx as never, job as never, "policy");
	const second = await createJobOnce(ctx as never, buildJob(op(), context) as never, "reconcile");
	assert.equal(first.created, true);
	assert.equal(second.created, false);
	assert.equal(ctx.storage.jobs.rows.size, 1);
	assert.equal((job as { id: string }).id, jobIdFor("op-1", "rev-1"));
	assert.ok("error" in buildJob(op({}, null), context), "missing revision fails closed");
	const changed = buildJob(op({}, "rev-2"), context) as { id: string };
	assert.notEqual(changed.id, (job as { id: string }).id, "a new revision is a different job");
});

test("dry runs are recorded as dry runs from creation", () => {
	const dry = buildJob(op({ dry_run: true, operation: "restore" }), context) as { executionMode: string; destructive: boolean };
	assert.equal(dry.executionMode, "dry_run");
	assert.equal(dry.destructive, false);
});

test("transitions are guarded: wrong state, wrong lease or a disallowed edge do nothing", async () => {
	const ctx = fakeCtx();
	const { job } = await createJobOnce(ctx as never, buildJob(op(), context) as never, "policy");
	const opts = { actor: "bridge", source: "bridge" as const };
	assert.equal(await transitionJob(ctx as never, job, "approved", "running", {}, opts), null, "must be claimed first");
	const claimed = await transitionJob(ctx as never, job, "approved", "claimed", { leaseId: "L1", claimedBy: "b" }, opts);
	assert.ok(claimed);
	assert.equal(await transitionJob(ctx as never, claimed!, "approved", "claimed", { leaseId: "L2" }, opts), null, "already claimed");
	assert.equal(await transitionJob(ctx as never, claimed!, "claimed", "running", {}, { ...opts, guard: { leaseId: "WRONG" } }), null, "lease mismatch");
	const running = await transitionJob(ctx as never, claimed!, "claimed", "running", {}, { ...opts, guard: { leaseId: "L1" } });
	assert.equal(running?.status, "running");
	const journalTypes = [...ctx.storage.journal.rows.values()].map((r) => (r.value as { type: string }).type);
	assert.deepEqual(journalTypes, ["job.created", "job.claimed", "job.running"]);
});

test("asset locks admit one job; needs_inspection keeps the lock until a person resolves it", async () => {
	const ctx = fakeCtx();
	const { job } = await createJobOnce(ctx as never, buildJob(op({ operation: "restore" }), context) as never, "policy");
	assert.equal(await acquireAssetLock(ctx as never, "IPHONE-13-RED", job.id), true);
	assert.equal(await acquireAssetLock(ctx as never, "IPHONE-13-RED", "other-job"), false);
	const opts = { actor: "x", source: "bridge" as const };
	const claimed = (await transitionJob(ctx as never, job, "approved", "claimed", {}, opts))!;
	const running = (await transitionJob(ctx as never, claimed, "claimed", "running", {}, opts))!;
	await transitionJob(ctx as never, running, "running", "needs_inspection", {}, opts);
	assert.equal(await assetLockHolder(ctx as never, "IPHONE-13-RED"), job.id, "still locked");
	assert.ok("error" in (await resolveInspection(ctx as never, job.id, { id: "u1", role: 40 }, "unknown", "Device at setup screen")), "editors cannot resolve");
	const resolved = await resolveInspection(ctx as never, job.id, { id: "u1", role: 50 }, "unknown", "Device shows the setup assistant");
	assert.ok(!("error" in resolved));
	assert.equal(await assetLockHolder(ctx as never, "IPHONE-13-RED"), null);
});

test("a journal failure during a transition flags the job and degrades the audit without losing the transition", async () => {
	const ctx = fakeCtx();
	const { job } = await createJobOnce(ctx as never, buildJob(op(), context) as never, "policy");
	ctx.storage.journal.failNextPut = 1;
	const claimed = await transitionJob(ctx as never, job, "approved", "claimed", {}, { actor: "b", source: "bridge" });
	assert.equal(claimed?.status, "claimed");
	assert.equal((await ctx.storage.jobs.get(job.id))!.auditGap, true);
	assert.equal((await auditState(ctx as never)).degraded, true);
});
