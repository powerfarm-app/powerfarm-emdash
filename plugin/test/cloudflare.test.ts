// The Cloudflare deployment pack: the Worker configuration keeps the site
// private, the edge check tells Access apart from EmDash, and a D1 dump becomes
// a backup that restore.mjs verifies.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { cfBackup, namesFromWrangler, sqliteFromDump, tooLongForD1 } from "../../scripts/cf-backup.mjs";
import { classify, edgeCheck } from "../../scripts/edge-check.mjs";
import { restore } from "../../scripts/restore.mjs";
import { appendJournal } from "../src/journal.ts";
import { fakeCtx } from "./fake-ctx.ts";

const site = path.join(import.meta.dirname, "..", "..", "site");
const jsonc = (file: string) => JSON.parse(readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));

test("the Worker has one way in (the Access-protected domain), private media, the cron, and no sandbox", () => {
	const w = jsonc(path.join(site, "wrangler.jsonc"));
	assert.equal(w.workers_dev, false, "workers.dev would bypass Access");
	assert.equal(w.preview_urls, false, "preview URLs would bypass Access");
	assert.ok(w.routes.every((r: { custom_domain?: boolean }) => r.custom_domain));
	assert.deepEqual(w.triggers.crons, ["* * * * *"], "plugin tasks run from the cron");
	assert.equal(w.vars.EMDASH_PRIVATE_MEDIA, "1");
	assert.ok(!w.worker_loaders, "no Worker Loader: nothing can be installed at runtime");
	assert.ok(!JSON.stringify(w).includes("ENCRYPTION_KEY\":"), "secrets are never in wrangler.jsonc");
	assert.deepEqual(namesFromWrangler(path.join(site, "wrangler.jsonc")), { database: "powerfarm", bucket: "powerfarm-media" });

	const config = readFileSync(path.join(site, "astro.config.mjs"), "utf8").replace(/^\s*\/\/.*$/gm, "");
	assert.match(config, /d1\(\{ binding: "DB"/);
	assert.match(config, /r2\(\{ binding: "MEDIA" \}\)/, "no publicUrl: media goes through EmDash's authenticated route");
	assert.ok(!/sandboxRunner|marketplace|publicUrl/.test(config));
	assert.match(config, /plugins: \[powerfarm\(\), auditLog\]/);
	assert.match(readFileSync(path.join(site, "src", "worker.ts"), "utf8"), /scheduled: createScheduledHandler\(\)/);
});

function response(status: number, body = "", headers: Record<string, string> = {}) {
	return new Response(body, { status, headers });
}

test("the edge check tells Cloudflare Access apart from EmDash", () => {
	assert.equal(classify(302, new Headers({ location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/x" }), ""), "edge");
	assert.equal(classify(403, new Headers(), "<html>Forbidden</html>"), "edge");
	assert.equal(classify(401, new Headers(), '{"error":{"code":"UNAUTHORIZED"}}'), "emdash");
	assert.equal(classify(200, new Headers(), "<html>admin</html>"), "open");
});

test("the edge check passes behind Access and fails loudly when a path or workers.dev is open", async () => {
	const behindAccess = async (url: string, init?: RequestInit) => {
		const h = (init?.headers ?? {}) as Record<string, string>;
		if (url.includes("workers.dev")) return response(404, "There is nothing here yet");
		if (h["cf-access-client-id"] === "bridge.access" && h["cf-access-client-secret"] === "s3cret") {
			return url.includes("/bridge/") ? response(401, '{"error":{"code":"MISSING_SIGNATURE"}}') : response(403, "<html>Forbidden</html>");
		}
		return response(302, "", { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/powerfarm" });
	};
	const ok = await edgeCheck({ url: "https://powerfarm.example.com", workersDev: "https://powerfarm.acct.workers.dev", access: { clientId: "bridge.access", clientSecret: "s3cret" }, fetchImpl: behindAccess as typeof fetch });
	assert.deepEqual(ok.filter(([s]) => s === "FAIL"), []);

	const leaky = async (url: string, init?: RequestInit) => (url.includes("/api/health") || url.includes("workers.dev") ? response(200, '{"status":"ok"}') : behindAccess(url, init));
	const bad = await edgeCheck({ url: "https://powerfarm.example.com", workersDev: "https://powerfarm.acct.workers.dev", fetchImpl: leaky as typeof fetch });
	const failed = bad.filter(([s]) => s === "FAIL").map(([, name]) => name);
	assert.ok(failed.some((n) => n.includes("/_emdash/api/health")));
	assert.ok(failed.some((n) => n.includes("workers.dev")));
});

/** A dump shaped like `wrangler d1 export` output, from a database with real journal entries. */
async function d1Dump() {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pf-d1dump-"));
	const ctx = fakeCtx();
	for (let i = 0; i < 3; i++) await appendJournal(ctx as never, { type: "t", stream: "asset:LAB-8GB", actor: "a", source: "system", title: `e${i}` });
	const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
	writeFileSync(path.join(dir, "backup-schema.sql"), [
		"CREATE TABLE media_folders (id TEXT PRIMARY KEY, name TEXT);",
		"CREATE TABLE ec_assets (id TEXT PRIMARY KEY, asset_tag TEXT);",
		"CREATE TABLE revisions (id TEXT PRIMARY KEY, data TEXT);",
		"CREATE TABLE _plugin_storage (plugin_id TEXT, collection TEXT, id TEXT, data TEXT, created_at TEXT, updated_at TEXT);",
	].join("\n"));
	writeFileSync(path.join(dir, "backup-folders.sql"), "INSERT INTO media_folders VALUES('f1','evidence');\n");
	writeFileSync(path.join(dir, "backup-data.sql"), [
		"INSERT INTO ec_assets VALUES('a1','LAB-8GB');",
		"INSERT INTO ec_assets VALUES('a2','IPHONE-13-RED');",
		`INSERT INTO revisions VALUES('r1',${q(JSON.stringify({ body: "x".repeat(120_000) }))});`,
		...[...ctx.storage.journal.rows].map(([id, row]) => `INSERT INTO _plugin_storage VALUES('powerfarm','journal',${q(id)},${q(JSON.stringify(row.value))},'','');`),
	].join("\n"));
	writeFileSync(path.join(dir, "backup-indexes.sql"), "CREATE INDEX idx_assets_tag ON ec_assets(asset_tag);\n");
	writeFileSync(path.join(dir, "time-travel.txt"), "🚧 The current bookmark is '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683'\n");
	return dir;
}

test("a D1 dump becomes a backup restore.mjs verifies: digests, integrity, counts, journal; the bookmark is recorded", async () => {
	const dump = await d1Dump();
	const media = mkdtempSync(path.join(os.tmpdir(), "pf-r2-"));
	mkdirSync(path.join(media, "evidence"));
	writeFileSync(path.join(media, "evidence", "OP-0001-inventory.json"), '{"observed":true}');
	const out = mkdtempSync(path.join(os.tmpdir(), "pf-cfb-"));
	const { target, manifest, longLines } = await cfBackup({ out, database: "powerfarm", bucket: "powerfarm-media", cwd: site, fromDump: dump, mediaFrom: media });
	assert.equal(manifest.source.kind, "cloudflare-d1");
	assert.equal(manifest.source.timeTravelBookmark, "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683");
	assert.equal(manifest.counts.ec_assets, 2);
	assert.equal(manifest.source.d1ImportableAsIs, false, "a 120 kB revision cannot be imported into D1 as is");
	assert.deepEqual(longLines, ["backup-data.sql:3"]);
	assert.ok(manifest.files["d1/backup-data.sql"], "the dump itself is kept");

	const to = path.join(mkdtempSync(path.join(os.tmpdir(), "pf-cfr-")), "data");
	const restored = await restore({ from: target, to });
	assert.equal(restored.journal.entries, 3);
	assert.equal(readFileSync(path.join(to, "uploads", "evidence", "OP-0001-inventory.json"), "utf8"), '{"observed":true}');
	const db = new DatabaseSync(path.join(to, "emdash.db"));
	assert.ok(db.prepare("select name from sqlite_master where name = 'idx_assets_tag'").get(), "indexes restored last");
	db.close();
});

test("a backup without media is refused unless asked for knowingly; an incomplete dump is refused", async () => {
	const dump = await d1Dump();
	const out = mkdtempSync(path.join(os.tmpdir(), "pf-cfb-"));
	await assert.rejects(cfBackup({ out, database: "powerfarm", bucket: "b", cwd: site, fromDump: dump, env: {} }), /Media is part of the backup/);
	const { manifest } = await cfBackup({ out, database: "powerfarm", bucket: "b", cwd: site, fromDump: dump, noMedia: true, env: {} });
	assert.equal(manifest.source.mediaIncluded, false);
	const broken = mkdtempSync(path.join(os.tmpdir(), "pf-broken-"));
	await assert.rejects(sqliteFromDump(broken, path.join(broken, "x.db")), /missing backup-schema.sql/);
	assert.deepEqual(tooLongForD1(broken), []);
});

test("with MDM on, the edge check wants the device path open to devices (but signed) and the posture path closed", async () => {
	const fetchImpl = async (url: string) => {
		if (url.includes("/mdm/checkin")) return response(401, "UNSIGNED", { "content-type": "text/plain" });
		return response(302, "", { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/powerfarm" });
	};
	const ok = await edgeCheck({ url: "https://powerfarm.example.com", mdm: true, fetchImpl: fetchImpl as typeof fetch });
	assert.deepEqual(ok.filter(([s]) => s === "FAIL"), []);
	const blocked = async () => response(302, "", { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/powerfarm" });
	const bad = await edgeCheck({ url: "https://powerfarm.example.com", mdm: true, fetchImpl: blocked as typeof fetch });
	assert.ok(bad.some(([s, name]) => s === "FAIL" && name.includes("MDM device path")), "devices cannot reach Powerfarm through Access");
});
