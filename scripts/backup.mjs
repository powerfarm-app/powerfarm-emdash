#!/usr/bin/env node
// Powerfarm operational backup.
//
//   node scripts/backup.mjs --out /Volumes/Offsite/powerfarm [--emdash ~/powerfarm-emdash] [--env site/.env]
//
// Writes one directory per backup:
//   database/emdash.db     consistent SQLite snapshot (VACUUM INTO), includes content,
//                          revisions, relations, plugin storage (jobs, journal), settings
//                          (secrets stay encrypted with EMDASH_ENCRYPTION_KEY)
//   uploads/               media files, including evidence
//   source/                Powerfarm source, the EmDash patch, the pinned EmDash revision
//   config/env.redacted    configuration with secret values removed
//   manifest.json          SHA-256 of every file, versions, counts
//
// EMDASH_ENCRYPTION_KEY is deliberately NOT included. Keep it separately (password
// manager or offline). The backup is not considered good until restore.mjs has
// restored it on another machine or directory and its checks passed.
//
// Requires Node 22.16+ (node:sqlite). PostgreSQL installations: back up with pg_dump
// instead of the database/ step (the script refuses rather than produce a partial backup).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
}

export function parseEnv(text) {
	const out = {};
	for (const line of text.split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
	}
	return out;
}

export function redactEnv(text) {
	return text
		.split(/\r?\n/)
		.map((line) => (/^\s*([A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD|DATABASE_URL)[A-Z0-9_]*)\s*=/.test(line) ? line.replace(/=.*/, "=<redacted>") : line))
		.join("\n");
}

function walk(dir, base = dir, out = []) {
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const full = path.join(dir, name);
		if (statSync(full).isDirectory()) walk(full, base, out);
		else out.push(path.relative(base, full));
	}
	return out;
}

function sha256File(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * `paths` overrides where the database and media are read from (cf-backup.mjs
 * passes a local SQLite rebuilt from a D1 dump and a copy of the R2 bucket);
 * `source` is recorded in the manifest; `extraDirs` are copied in as-is.
 */
export async function backup({ out, env, emdashDir, now = new Date(), paths: override = null, source = null, extraDirs = {} }) {
	const { DatabaseSync } = await import("node:sqlite");
	const { powerfarmPaths } = await import(path.join(root, "site", "powerfarm.paths.mjs"));
	const paths = override ?? powerfarmPaths(env);
	if (paths.databaseUrl) throw new Error("This installation uses PostgreSQL. Use pg_dump for the database, then copy uploads/ and source/ yourself.");
	if (!existsSync(paths.database)) throw new Error(`No database at ${paths.database}`);

	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const target = path.join(out, `powerfarm-backup-${stamp}`);
	if (existsSync(target)) throw new Error(`${target} exists`);
	mkdirSync(path.join(target, "database"), { recursive: true });

	// Consistent snapshot even while EmDash is running.
	const live = new DatabaseSync(paths.database, { readOnly: true });
	live.exec(`VACUUM INTO '${path.join(target, "database", "emdash.db").replace(/'/g, "''")}'`);
	live.close();
	// Counts and journal heads come from the snapshot itself, so writes after it cannot make them disagree.
	const db = new DatabaseSync(path.join(target, "database", "emdash.db"), { readOnly: true });
	const counts = {};
	let journalHeads = null;
	if (db.prepare("select name from sqlite_master where type='table' and name='_plugin_storage'").get()) {
		const { journalHeads: heads } = await import("./restore.mjs");
		journalHeads = heads(db.prepare("select data from _plugin_storage where plugin_id = 'powerfarm' and collection = 'journal'").all().map((r) => JSON.parse(r.data)));
	}
	for (const { name } of db.prepare("select name from sqlite_master where type='table' and (name like 'ec\\_%' escape '\\' or name in ('revisions','_emdash_content_references','_plugin_storage','media'))").all()) {
		counts[name] = db.prepare(`select count(*) as n from "${name.replace(/"/g, '""')}"`).get().n;
	}
	db.close();

	if (paths.uploads && existsSync(paths.uploads)) cpSync(paths.uploads, path.join(target, "uploads"), { recursive: true });
	for (const [name, dir] of Object.entries(extraDirs)) cpSync(dir, path.join(target, name), { recursive: true });
	mkdirSync(path.join(target, "source"), { recursive: true });
	for (const part of ["site", "plugin", "bridge", "docs", "patches", "scripts", "README.md"]) {
		const src = path.join(root, part);
		if (!existsSync(src)) continue;
		cpSync(src, path.join(target, "source", part), { recursive: true, filter: (p) => !/node_modules|[/\\]data[/\\]|\.env$/.test(p) });
	}
	let emdashRevision = null;
	if (emdashDir && existsSync(path.join(emdashDir, ".git"))) {
		emdashRevision = execFileSync("git", ["-C", emdashDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
	}
	mkdirSync(path.join(target, "config"), { recursive: true });
	if (env.__envText) writeFileSync(path.join(target, "config", "env.redacted"), redactEnv(env.__envText));

	const files = walk(target).filter((f) => f !== "manifest.json");
	const manifest = {
		format: "powerfarm-backup/1",
		createdAt: now.toISOString(),
		emdashRevision,
		expectedEmdashRevision: "981c78d5d347428e77afd27b7582924607754503",
		pluginVersion: JSON.parse(readFileSync(path.join(root, "plugin", "package.json"), "utf8")).version,
		dataDir: paths.dataDir,
		source: source ?? { kind: "sqlite" },
		counts,
		// Checkpoint of every journal stream's head: restore.mjs refuses a copy whose journal ends elsewhere.
		journalHeads,
		encryptionKeyIncluded: false,
		files: Object.fromEntries(files.map((f) => [f, sha256File(path.join(target, f))])),
	};
	writeFileSync(path.join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	return { target, manifest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const envFile = arg("env", path.join(root, "site", ".env"));
	const envText = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
	const env = { ...process.env, ...parseEnv(envText), __envText: envText };
	const out = arg("out");
	if (!out) {
		console.error("Usage: node scripts/backup.mjs --out <directory outside LAB 512> [--emdash <EmDash checkout>] [--env site/.env]");
		process.exit(2);
	}
	backup({ out, env, emdashDir: arg("emdash") })
		.then(({ target, manifest }) => {
			console.log(`Backup written to ${target} (${Object.keys(manifest.files).length} files).`);
			console.log("EMDASH_ENCRYPTION_KEY is not in the backup. Make sure a copy is stored separately.");
			console.log(`Now prove it: node scripts/restore.mjs --from ${target} --to <empty directory on another machine>`);
		})
		.catch((e) => {
			console.error(e.message);
			process.exit(1);
		});
}
