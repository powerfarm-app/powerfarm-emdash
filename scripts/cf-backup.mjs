#!/usr/bin/env node
// Back up Powerfarm on Cloudflare to a machine outside Cloudflare (a lab Mac).
//
//   node scripts/cf-backup.mjs --out /Volumes/Offsite/powerfarm \
//     [--database powerfarm] [--bucket powerfarm-media] [--config site/wrangler.jsonc]
//
// Writes the same backup format as backup.mjs, so restore.mjs checks it:
//   d1/                    the D1 dump in EmDash's documented four files
//                          (schema, media folders, data, indexes; FTS5 search tables
//                          are left out and rebuilt by EmDash), plus the Time Travel
//                          bookmark taken first
//   database/emdash.db     a local SQLite built from that dump: integrity, row counts
//                          and the Powerfarm journal chains are verified on it
//   uploads/               a copy of the R2 media bucket (evidence included)
//   manifest.json          SHA-256 of every file, counts, the D1 bookmark
//
// Needs, on this machine: Node 22.16+, wrangler logged in to the account
// (`npx wrangler login`), and for media either the AWS CLI with R2 S3 credentials
// (R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: a read-only R2 token)
// or --media-from <dir> with a copy made another way. Without media the backup is
// refused, unless --no-media says you know it is incomplete.
//
// --from-dump <dir> uses an existing dump instead of calling wrangler (for a dump
// made elsewhere, and for tests).
//
// EMDASH_ENCRYPTION_KEY is never in the backup: keep it separately.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { backup } from "./backup.mjs";

const DUMP_FILES = ["backup-schema.sql", "backup-folders.sql", "backup-data.sql", "backup-indexes.sql"];
const D1_MAX_STATEMENT = 100_000;

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
}

function wrangler(args, { cwd }) {
	return execFileSync("npx", ["--no-install", "wrangler", ...args], { cwd, encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "inherit"] });
}

function queryJson(database, sql, cwd) {
	const out = JSON.parse(wrangler(["d1", "execute", database, "--remote", "--json", "--command", sql], { cwd }));
	return out?.[0]?.results ?? [];
}

/** EmDash's documented D1 dump (docs/guides/backups: "Create an offsite D1 dump"), without jq. */
export function dumpD1({ database, dir, cwd }) {
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "time-travel.txt"), wrangler(["d1", "time-travel", "info", database], { cwd }));
	const tables = queryJson(database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_emdash_fts_*' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name != 'media_folders'", cwd).map((r) => `--table=${r.name}`);
	if (tables.length === 0) throw new Error(`D1 database ${database} has no tables. Wrong database name?`);
	wrangler(["d1", "export", database, "--remote", "--no-data", `--output=${path.join(dir, "backup-schema.sql")}`, "--table=media_folders", ...tables], { cwd });
	wrangler(["d1", "export", database, "--remote", "--no-schema", `--output=${path.join(dir, "backup-folders.sql")}`, "--table=media_folders"], { cwd });
	wrangler(["d1", "export", database, "--remote", "--no-schema", `--output=${path.join(dir, "backup-data.sql")}`, ...tables], { cwd });
	const indexes = queryJson(database, "SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL AND name NOT GLOB '_emdash_fts_*' AND tbl_name NOT GLOB '_emdash_fts_*' AND tbl_name NOT GLOB '_cf_*'", cwd);
	writeFileSync(path.join(dir, "backup-indexes.sql"), indexes.map((r) => `${r.sql};`).join("\n") + "\n");
}

/** Lines D1 cannot import (one INSERT of 100 kB or more): the dump is still a full copy for sqlite3, but not for D1. */
export function tooLongForD1(dir) {
	const out = [];
	for (const f of DUMP_FILES) {
		const file = path.join(dir, f);
		if (!existsSync(file)) continue;
		readFileSync(file, "utf8").split("\n").forEach((line, i) => {
			if (Buffer.byteLength(line) >= D1_MAX_STATEMENT) out.push(`${f}:${i + 1}`);
		});
	}
	return out;
}

/** Rebuild a local SQLite database from the four dump files, in EmDash's documented order. */
export async function sqliteFromDump(dir, file) {
	const { DatabaseSync } = await import("node:sqlite");
	for (const f of DUMP_FILES) if (!existsSync(path.join(dir, f))) throw new Error(`The dump is missing ${f}`);
	const db = new DatabaseSync(file);
	try {
		db.exec("PRAGMA foreign_keys = OFF");
		for (const f of DUMP_FILES) db.exec(readFileSync(path.join(dir, f), "utf8"));
	} finally {
		db.close();
	}
}

export async function cfBackup({ out, database, bucket, cwd, fromDump = null, mediaFrom = null, noMedia = false, env = process.env, now = new Date() }) {
	mkdirSync(out, { recursive: true });
	const staging = mkdtempSync(path.join(out, ".cf-backup-"));
	try {
		const d1Dir = path.join(staging, "d1");
		if (fromDump) cpSync(fromDump, d1Dir, { recursive: true });
		else dumpD1({ database, dir: d1Dir, cwd });

		let mediaDir = null;
		if (mediaFrom) mediaDir = mediaFrom;
		else if (!noMedia) {
			if (!env.R2_ACCOUNT_ID || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
				throw new Error("Media is part of the backup. Set R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (a read-only R2 API token), or pass --media-from <dir>, or --no-media to make an incomplete backup knowingly.");
			}
			mediaDir = path.join(staging, "r2");
			execFileSync("aws", ["s3", "sync", `s3://${bucket}`, mediaDir, "--endpoint-url", `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, "--only-show-errors"], { stdio: "inherit", env });
		}

		const dbFile = path.join(staging, "emdash.db");
		await sqliteFromDump(d1Dir, dbFile);
		const longLines = tooLongForD1(d1Dir);
		const bookmark = existsSync(path.join(d1Dir, "time-travel.txt")) ? readFileSync(path.join(d1Dir, "time-travel.txt"), "utf8").match(/[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}/)?.[0] ?? null : null;
		const result = await backup({
			out,
			env: {},
			now,
			paths: { dataDir: `cloudflare-d1:${database}`, database: dbFile, uploads: mediaDir },
			source: { kind: "cloudflare-d1", database, bucket, timeTravelBookmark: bookmark, mediaIncluded: !!mediaDir, d1ImportableAsIs: longLines.length === 0, tooLongForD1: longLines.slice(0, 20) },
			extraDirs: { d1: d1Dir },
		});
		return { ...result, longLines, mediaIncluded: !!mediaDir };
	} finally {
		rmSync(staging, { recursive: true, force: true });
	}
}

/** Read the D1 and R2 names from wrangler.jsonc (comments allowed). */
export function namesFromWrangler(file) {
	if (!existsSync(file)) return {};
	const text = readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
	const config = JSON.parse(text);
	return { database: config.d1_databases?.find((d) => d.binding === "DB")?.database_name, bucket: config.r2_buckets?.find((b) => b.binding === "MEDIA")?.bucket_name };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
	const config = arg("config", path.join(root, "site", "wrangler.jsonc"));
	const names = namesFromWrangler(config);
	const out = arg("out");
	if (!out) {
		console.error("Usage: node scripts/cf-backup.mjs --out <folder outside Cloudflare> [--database <d1 name>] [--bucket <r2 bucket>] [--media-from <dir> | --no-media] [--from-dump <dir>]");
		process.exit(2);
	}
	cfBackup({
		out,
		database: arg("database", names.database ?? "powerfarm"),
		bucket: arg("bucket", names.bucket ?? "powerfarm-media"),
		cwd: path.dirname(config),
		fromDump: arg("from-dump"),
		mediaFrom: arg("media-from"),
		noMedia: process.argv.includes("--no-media"),
	})
		.then(({ target, manifest, longLines, mediaIncluded }) => {
			console.log(`Backup written to ${target} (${Object.keys(manifest.files).length} files).`);
			if (manifest.source.timeTravelBookmark) console.log(`D1 Time Travel bookmark at backup time: ${manifest.source.timeTravelBookmark}`);
			if (longLines.length) console.log(`Note: ${longLines.length} statement(s) are too long for D1 to import; the dump restores into SQLite, and D1 recovery uses Time Travel (see docs/DEPLOYMENT-CLOUDFLARE.md).`);
			if (!mediaIncluded) console.log("WARNING: media (evidence files) is NOT in this backup.");
			console.log("EMDASH_ENCRYPTION_KEY is not in the backup. Make sure a copy is stored separately.");
			console.log(`Now prove it: node scripts/restore.mjs --from ${target} --to <empty directory>`);
		})
		.catch((e) => {
			console.error(e.message);
			process.exit(1);
		});
}

export { DUMP_FILES };
