// Backup and restore scripts: snapshot, digests, integrity, journal verification,
// and hash parity between the restore checker and the plugin's journal.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { backup, redactEnv } from "../../scripts/backup.mjs";
import { journalHash, restore, verifyJournalRows } from "../../scripts/restore.mjs";
import { appendJournal } from "../src/journal.ts";
import { fakeCtx } from "./fake-ctx.ts";

async function installation() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pf-data-"));
	mkdirSync(path.join(dir, "uploads"));
	writeFileSync(path.join(dir, "uploads", "evidence-1.json"), '{"observed":true}');
	const db = new DatabaseSync(path.join(dir, "emdash.db"));
	db.exec("create table ec_assets (id text primary key, asset_tag text)");
	db.exec("insert into ec_assets values ('a1', 'LAB-8GB'), ('a2', 'IPHONE-13-RED')");
	db.exec("create table _plugin_storage (plugin_id text, collection text, id text, data text, created_at text, updated_at text)");
	// Real journal entries produced by the plugin's own code.
	const ctx = fakeCtx();
	for (let i = 0; i < 3; i++) await appendJournal(ctx as never, { type: "t", stream: "asset:LAB-8GB", actor: "a", source: "system", title: `e${i}` });
	for (const [id, row] of ctx.storage.journal.rows) db.prepare("insert into _plugin_storage values ('powerfarm', 'journal', ?, ?, '', '')").run(id, JSON.stringify(row.value));
	db.close();
	return { dir, entries: [...ctx.storage.journal.rows.values()].map((r) => r.value) };
}

test("the restore checker computes the same journal hash as the plugin", async () => {
	const { entries } = await installation();
	for (const e of entries) assert.equal(journalHash(e), (e as { hash: string }).hash);
	assert.deepEqual(verifyJournalRows(entries).problems, []);
});

test("backup → restore round trip verifies digests, integrity, counts and the journal; the key is never included", async () => {
	const { dir } = await installation();
	const out = mkdtempSync(path.join(os.tmpdir(), "pf-backup-"));
	const envText = "POWERFARM_DATA_DIR=x\nEMDASH_ENCRYPTION_KEY=supersecret\nHOST=192.168.64.2\n";
	const { target, manifest } = await backup({ out, env: { POWERFARM_DATA_DIR: dir, __envText: envText }, emdashDir: undefined });
	assert.equal(manifest.encryptionKeyIncluded, false);
	assert.equal(manifest.counts.ec_assets, 2);
	const redacted = readFileSync(path.join(target, "config", "env.redacted"), "utf8");
	assert.ok(!redacted.includes("supersecret"));
	assert.ok(redacted.includes("HOST=192.168.64.2"));

	const to = path.join(mkdtempSync(path.join(os.tmpdir(), "pf-restore-")), "data");
	const result = await restore({ from: target, to });
	assert.equal(result.journal.entries, 3);
	assert.equal(readFileSync(path.join(to, "uploads", "evidence-1.json"), "utf8"), '{"observed":true}');

	await assert.rejects(restore({ from: target, to }), /not empty/, "never overwrites");
});

test("a tampered backup is refused", async () => {
	const { dir } = await installation();
	const { target } = await backup({ out: mkdtempSync(path.join(os.tmpdir(), "pf-backup-")), env: { POWERFARM_DATA_DIR: dir }, emdashDir: undefined });
	writeFileSync(path.join(target, "uploads", "evidence-1.json"), '{"observed":false}');
	await assert.rejects(restore({ from: target, to: path.join(mkdtempSync(path.join(os.tmpdir(), "pf-r-")), "d") }), /do not match the manifest/);
});

test("a rewritten journal entry is refused even when digests are recomputed", async () => {
	const { dir } = await installation();
	const db = new DatabaseSync(path.join(dir, "emdash.db"));
	const row = db.prepare("select id, data from _plugin_storage limit 1").get() as { id: string; data: string };
	const data = JSON.parse(row.data);
	data.title = "rewritten";
	db.prepare("update _plugin_storage set data = ? where id = ?").run(JSON.stringify(data), row.id);
	db.close();
	const { target } = await backup({ out: mkdtempSync(path.join(os.tmpdir(), "pf-backup-")), env: { POWERFARM_DATA_DIR: dir }, emdashDir: undefined });
	await assert.rejects(restore({ from: target, to: path.join(mkdtempSync(path.join(os.tmpdir(), "pf-r-")), "d") }), /Journal does not verify/);
});

test("secret-looking settings are redacted from the configuration copy", () => {
	assert.equal(redactEnv("A=1\nEMDASH_ENCRYPTION_KEY=k\nPOWERFARM_BRIDGE_SECRET=s\nDATABASE_URL=postgres://u:p@h/d"), "A=1\nEMDASH_ENCRYPTION_KEY=<redacted>\nPOWERFARM_BRIDGE_SECRET=<redacted>\nDATABASE_URL=<redacted>");
});
