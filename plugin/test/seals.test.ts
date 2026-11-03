// Record seals: a hash of each published institutional record in the journal,
// made even when afterPublish fails, and a check that tells if it changed since.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { ContentReader } from "../src/content.ts";
import { markPending, reconcileSeals, sealStatus } from "../src/seals.ts";
import { journalHeads } from "../../scripts/restore.mjs";
import { ADMIN, EDITOR, makeWorld, type World } from "./entity-world.ts";

let w: World;
const reader = () => new ContentReader(w.db.port());
const journal = () => [...w.ctx.storage.journal.rows.values()].map((r) => r.value as { type: string; stream: string; seq: number; hash: string; payload?: Record<string, unknown> });

beforeEach(() => {
	w = makeWorld();
});

async function policy(title = "Device baseline") {
	const d = await w.draftAs(EDITOR, "policies", { title, owner_principal: "people:PE-0001", scope: "All company devices", body: "Every device runs the Powerfarm baseline profile." });
	assert.equal(await w.publishAs(ADMIN, "policies", d.id), undefined);
	return d.id;
}

test("publishing a policy seals it: revision and SHA-256 in the journal, nothing left pending", async () => {
	const id = await policy();
	const seals = journal().filter((e) => e.type === "record.sealed");
	assert.equal(seals.length, 1);
	assert.match(String(seals[0]!.payload!.sha256), /^[0-9a-f]{64}$/);
	assert.equal(seals[0]!.payload!.revision, w.row("policies", id)!.live_revision_id);
	assert.equal((await w.ctx.kv.list("seal:pending:")).length, 0);
	assert.equal((await sealStatus(w.ctx as never, reader(), "policies", id)).state, "intact");
});

test("a seal that afterPublish never wrote is made by the seals task; a publish that never happened is recorded as abandoned", async () => {
	const id = await policy();
	// Simulate the lost afterPublish: a marker left behind, older than the grace period, for a new revision.
	w.db.db.prepare("update ec_policies set live_revision_id = 'rev_lost' where id = ?").run(id);
	await markPending(w.ctx as never, "policies", id, ADMIN.id);
	const draft = await w.draftAs(EDITOR, "policies", { title: "Never published", owner_principal: "people:PE-0001", scope: "x", body: "A draft whose publish was cancelled." });
	await markPending(w.ctx as never, "policies", draft.id, ADMIN.id);
	const r = await reconcileSeals(w.ctx as never, reader(), Date.now() + 5 * 60_000);
	assert.deepEqual(r, { sealed: 1, abandoned: 1, failed: 0 });
	assert.ok(journal().some((e) => e.type === "record.sealed" && e.payload!.revision === "rev_lost"));
	assert.ok(journal().some((e) => e.type === "record.seal_abandoned"));
});

test("a published record changed behind EmDash's back no longer matches its seal", async () => {
	const id = await policy();
	w.db.db.prepare("update ec_policies set body = 'Anything goes.' where id = ?").run(id);
	const s = await sealStatus(w.ctx as never, reader(), "policies", id);
	assert.equal(s.state, "changed");
	assert.notEqual(s.sealed, s.current);
});

test("journal heads, the checkpoint each backup records, are the last seq and hash of every stream", async () => {
	await policy();
	const rows = journal();
	const heads = journalHeads(rows);
	const authority = rows.filter((r) => r.stream === "record:policies").sort((a, b) => b.seq - a.seq)[0]!;
	assert.deepEqual(heads["record:policies"], { seq: authority.seq, hash: authority.hash });
});
