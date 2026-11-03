#!/usr/bin/env node
// Restore and check a Powerfarm backup into an EMPTY data directory.
//
//   node scripts/restore.mjs --from <backup dir> --to <empty data dir>
//
// Checks, in order, and refuses to continue on any failure:
//   1. every file's SHA-256 matches manifest.json
//   2. the database passes SQLite's integrity_check
//   3. row counts match the manifest
//   4. the Powerfarm journal hash chains in plugin storage verify
//
// Then start EmDash with POWERFARM_DATA_DIR=<to> and the original
// EMDASH_ENCRYPTION_KEY, sign in, open Audit and health, and confirm the journal
// shows intact and the bridge secret is readable (Plugins → Powerfarm settings).
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

function arg(name) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

const GENESIS = "0".repeat(64);

function canonical(value) {
	if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

/** Same hash as plugin/src/journal.ts `entryHash`. */
export function journalHash(e) {
	const fields = { eventId: e.eventId, stream: e.stream, seq: e.seq, type: e.type, at: e.at, actor: e.actor, source: e.source, title: e.title, assetTag: e.assetTag, opCode: e.opCode, jobId: e.jobId, payload: e.payload, evidenceIds: e.evidenceIds, prevHash: e.prevHash };
	return createHash("sha256").update(canonical(fields)).digest("hex");
}

export function verifyJournalRows(rows) {
	const streams = new Map();
	for (const r of rows) {
		if (!streams.has(r.stream)) streams.set(r.stream, []);
		streams.get(r.stream).push(r);
	}
	const problems = [];
	for (const [stream, entries] of streams) {
		entries.sort((a, b) => a.seq - b.seq);
		let prev = GENESIS;
		entries.forEach((e, i) => {
			if (e.seq !== i + 1) problems.push(`${stream}: expected seq ${i + 1}, found ${e.seq}`);
			if (e.prevHash !== prev) problems.push(`${stream}: chain broken at seq ${e.seq}`);
			if (journalHash(e) !== e.hash) problems.push(`${stream}: entry ${e.seq} modified`);
			prev = e.hash;
		});
	}
	return { streams: streams.size, entries: rows.length, problems };
}

/** Last seq and hash per journal stream: the checkpoint a backup records, so a later copy cannot silently lose its tail. */
export function journalHeads(rows) {
	const heads = {};
	for (const r of rows) if (!heads[r.stream] || r.seq > heads[r.stream].seq) heads[r.stream] = { seq: r.seq, hash: r.hash };
	return heads;
}

export async function restore({ from, to }) {
	const { DatabaseSync } = await import("node:sqlite");
	const manifest = JSON.parse(readFileSync(path.join(from, "manifest.json"), "utf8"));
	if (manifest.format !== "powerfarm-backup/1") throw new Error("Not a Powerfarm backup");
	const bad = Object.entries(manifest.files).filter(([f, h]) => createHash("sha256").update(readFileSync(path.join(from, f))).digest("hex") !== h);
	if (bad.length) throw new Error(`Files do not match the manifest: ${bad.map(([f]) => f).join(", ")}`);
	if (existsSync(to) && readdirSync(to).length > 0) throw new Error(`${to} is not empty; restore only into an empty directory`);
	mkdirSync(to, { recursive: true });
	cpSync(path.join(from, "database", "emdash.db"), path.join(to, "emdash.db"));
	if (existsSync(path.join(from, "uploads"))) cpSync(path.join(from, "uploads"), path.join(to, "uploads"), { recursive: true });

	const db = new DatabaseSync(path.join(to, "emdash.db"));
	const integrity = db.prepare("pragma integrity_check").get();
	if (Object.values(integrity)[0] !== "ok") throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity)}`);
	const mismatched = Object.entries(manifest.counts).filter(([t, n]) => db.prepare(`select count(*) as n from "${t.replace(/"/g, '""')}"`).get().n !== n);
	if (mismatched.length) throw new Error(`Row counts differ: ${mismatched.map(([t]) => t).join(", ")}`);
	let journal = { streams: 0, entries: 0, problems: [] };
	const hasStorage = db.prepare("select name from sqlite_master where type='table' and name='_plugin_storage'").get();
	if (hasStorage) {
		const rows = db
			.prepare("select data from _plugin_storage where plugin_id = 'powerfarm' and collection = 'journal'")
			.all()
			.map((r) => JSON.parse(r.data));
		journal = verifyJournalRows(rows);
		if (journal.problems.length) throw new Error(`Journal does not verify: ${journal.problems.slice(0, 5).join("; ")}`);
		if (manifest.journalHeads) {
			const now = journalHeads(rows);
			const lost = Object.entries(manifest.journalHeads).filter(([s, h]) => !now[s] || now[s].seq !== h.seq || now[s].hash !== h.hash);
			if (lost.length) throw new Error(`Journal heads differ from the backup's checkpoint: ${lost.map(([s]) => s).slice(0, 5).join(", ")}`);
		}
	}
	db.close();
	return { manifest, journal };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const from = arg("from");
	const to = arg("to");
	if (!from || !to) {
		console.error("Usage: node scripts/restore.mjs --from <backup dir> --to <empty data dir>");
		process.exit(2);
	}
	restore({ from, to })
		.then(({ manifest, journal }) => {
			console.log(`Restored backup from ${manifest.createdAt} into ${to}.`);
			console.log(`Checks passed: file digests, SQLite integrity, row counts, journal (${journal.entries} entries in ${journal.streams} streams).`);
			console.log(`Start EmDash with POWERFARM_DATA_DIR=${to} and the original EMDASH_ENCRYPTION_KEY, then open Audit and health.`);
		})
		.catch((e) => {
			console.error(`Restore refused: ${e.message}`);
			process.exit(1);
		});
}
