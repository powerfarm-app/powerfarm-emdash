#!/usr/bin/env node
// Prove that linking Powerfarm into EmDash's workspace added no dependency.
//
//   node scripts/check-lockfile.mjs <upstream pnpm-lock.yaml> <resulting pnpm-lock.yaml>
//
// The packages, their versions and their integrity hashes must be exactly the
// ones EmDash locks; Powerfarm brings none of its own and may only add importers
// under powerfarm/. Snapshots may gain peer-dependency variants of locked
// packages. Anything else pnpm rewrites during a full install is printed as a
// note, so it is visible in CI without failing on upstream's own drift.
import { readFileSync } from "node:fs";

/** Split a lockfile into top-level sections: { name: text }. */
export function sections(text) {
	const out = {};
	let name = "(header)";
	for (const line of text.split("\n")) {
		const m = /^([A-Za-z][\w-]*):/.exec(line);
		if (m) name = m[1];
		out[name] = (out[name] ?? "") + line + "\n";
	}
	return out;
}

/** Split a section into entries keyed by their two-space-indented key. */
export function importers(sectionText) {
	const out = {};
	let key = null;
	for (const line of (sectionText ?? "").split("\n").slice(1)) {
		// A key at two spaces, quoted or not, with or without an inline value ("react@19.2.0: {}").
		const m = /^ {2}('[^']+'|[^\s:'][^:]*):(?:\s|$)/.exec(line);
		if (m) key = m[1].replace(/^['"]|['"]$/g, "");
		if (key !== null) out[key] = (out[key] ?? "") + line + "\n";
	}
	return out;
}

const integrityOf = (entry) => /integrity: ([^,}\s]+)/.exec(entry ?? "")?.[1] ?? null;

/**
 * What must never happen: a package (name@version) EmDash does not lock, a changed
 * integrity hash for one it does, or an importer outside powerfarm/. Those fail.
 * What pnpm may legitimately rewrite during a full install (other metadata of an
 * existing entry, EmDash's own importers, top-level settings) is reported, not failed:
 * Powerfarm does not touch EmDash's package files, so those are upstream's.
 */
export function compareLockfiles(upstreamText, resultText) {
	const problems = [];
	const notes = [];
	const a = sections(upstreamText);
	const b = sections(resultText);

	const pa = importers(a.packages);
	const pb = importers(b.packages);
	for (const [key, entry] of Object.entries(pb)) {
		if (pa[key] === undefined) problems.push(`new package "${key}" (not in EmDash's lockfile)`);
		else if (integrityOf(entry) !== integrityOf(pa[key])) problems.push(`integrity of "${key}" changed (${integrityOf(pa[key])} -> ${integrityOf(entry)})`);
		else if (entry.trimEnd() !== pa[key].trimEnd()) notes.push(`metadata of "${key}" rewritten by pnpm`);
	}
	for (const key of Object.keys(pa)) if (pb[key] === undefined) notes.push(`"${key}" no longer needed`);

	const known = new Set(Object.keys(pa));
	const sa = importers(a.snapshots);
	const sb = importers(b.snapshots);
	for (const key of Object.keys(sb)) {
		if (sa[key] !== undefined) continue;
		const base = key.replace(/\(.*$/, "");
		if (!known.has(base)) problems.push(`new package "${base}" (not in EmDash's lockfile)`);
	}

	const ia = importers(a.importers);
	const ib = importers(b.importers);
	const added = Object.keys(ib).filter((k) => ia[k] === undefined);
	for (const key of added) if (!key.startsWith("powerfarm/")) problems.push(`unexpected new importer "${key}"`);
	for (const [key, text] of Object.entries(ia)) {
		if (ib[key] === undefined) notes.push(`EmDash importer "${key}" disappeared`);
		else if (ib[key].trimEnd() !== text.trimEnd()) notes.push(`EmDash importer "${key}" re-resolved by pnpm`);
	}

	for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (["importers", "packages", "snapshots"].includes(name)) continue;
		if (a[name] !== b[name]) notes.push(`section "${name}" rewritten by pnpm`);
	}
	return { ok: problems.length === 0, problems, notes, added };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [upstream, result] = process.argv.slice(2);
	if (!upstream || !result) {
		console.error("Usage: check-lockfile.mjs <upstream pnpm-lock.yaml> <resulting pnpm-lock.yaml>");
		process.exit(2);
	}
	const r = compareLockfiles(readFileSync(upstream, "utf8"), readFileSync(result, "utf8"));
	for (const n of r.notes.slice(0, 30)) console.log(`note: ${n}`);
	if (r.notes.length > 30) console.log(`note: … ${r.notes.length - 30} more`);
	if (!r.ok) {
		console.error("Powerfarm changed EmDash's dependency set. Powerfarm must use only what EmDash locks:");
		for (const p of r.problems) console.error(`  - ${p}`);
		process.exit(1);
	}
	console.log(`Lockfile OK: EmDash's packages unchanged; Powerfarm importers: ${r.added.join(", ")}`);
}
