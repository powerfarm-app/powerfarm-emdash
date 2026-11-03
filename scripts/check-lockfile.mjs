#!/usr/bin/env node
// Prove that linking Powerfarm into EmDash's workspace added no dependency.
//
//   node scripts/check-lockfile.mjs <upstream pnpm-lock.yaml> <resulting pnpm-lock.yaml>
//
// Every top-level section of the lockfile must be byte-identical to EmDash's,
// except:
//   - `importers`, which may only gain entries under powerfarm/;
//   - `snapshots`, which keeps every upstream entry unchanged and may only gain
//     peer-dependency variants of packages already in `packages`.
// So the packages, their versions and integrity hashes are exactly the ones
// EmDash reviewed and locked upstream; Powerfarm brings none of its own.
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

export function compareLockfiles(upstreamText, resultText) {
	const problems = [];
	const a = sections(upstreamText);
	const b = sections(resultText);
	for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (name === "importers" || name === "snapshots") continue;
		if (a[name] !== b[name]) problems.push(`section "${name}" differs from EmDash's lockfile`);
	}
	const ia = importers(a.importers);
	const ib = importers(b.importers);
	for (const [key, text] of Object.entries(ia)) {
		if (ib[key] === undefined) problems.push(`importer "${key}" disappeared`);
		else if (ib[key].trimEnd() !== text.trimEnd()) problems.push(`importer "${key}" changed`);
	}
	const added = Object.keys(ib).filter((k) => ia[k] === undefined);
	for (const key of added) if (!key.startsWith("powerfarm/")) problems.push(`unexpected new importer "${key}"`);
	const known = new Set(Object.keys(importers(a.packages)));
	const sa = importers(a.snapshots);
	const sb = importers(b.snapshots);
	for (const [key, text] of Object.entries(sa)) {
		if (sb[key] === undefined) problems.push(`snapshot "${key}" disappeared`);
		else if (sb[key].trimEnd() !== text.trimEnd()) problems.push(`snapshot "${key}" changed`);
	}
	for (const key of Object.keys(sb)) {
		if (sa[key] !== undefined) continue;
		const base = key.replace(/\(.*$/, "");
		if (!known.has(base)) problems.push(`new package "${base}" (not in EmDash's lockfile)`);
	}
	return { ok: problems.length === 0, problems, added };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [upstream, result] = process.argv.slice(2);
	if (!upstream || !result) {
		console.error("Usage: check-lockfile.mjs <upstream pnpm-lock.yaml> <resulting pnpm-lock.yaml>");
		process.exit(2);
	}
	const r = compareLockfiles(readFileSync(upstream, "utf8"), readFileSync(result, "utf8"));
	if (!r.ok) {
		console.error("Powerfarm changed EmDash's dependency set. Powerfarm must use only what EmDash locks:");
		for (const p of r.problems) console.error(`  - ${p}`);
		process.exit(1);
	}
	console.log(`Lockfile OK: EmDash's packages unchanged; Powerfarm importers: ${r.added.join(", ")}`);
}
