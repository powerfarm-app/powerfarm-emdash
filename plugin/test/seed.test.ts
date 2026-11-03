// The seed and the plugin must agree: every field the code reads or writes exists.
import assert from "node:assert/strict";
import { test } from "node:test";

import { COLLECTIONS, DATA_DECISIONS, DEVICE_CLASSES, LINK_FIELDS, OPERATION_NAMES } from "../src/model.ts";
import { REFERENCE_FIELDS, RELATION_EDGES, RELATION_ENDS } from "../src/ontology.ts";
import { loadSeed } from "./sqlite-port.ts";

const seed = loadSeed() as ReturnType<typeof loadSeed> & {
	collections: Array<{ slug: string; supports?: string[]; fields: Array<{ slug: string; type: string; unique?: boolean; indexed?: boolean; validation?: Record<string, unknown> }> }>;
	content: Record<string, Array<{ id: string; data: Record<string, unknown> }>>;
};
const field = (c: string, f: string) => seed.collections.find((x) => x.slug === c)?.fields.find((x) => x.slug === f);

test("every Powerfarm collection exists in the seed with its key field unique and indexed", () => {
	for (const [slug, spec] of Object.entries(COLLECTIONS)) {
		assert.ok(seed.collections.some((c) => c.slug === slug), slug);
		if (spec.key) {
			const k = field(slug, spec.key);
			assert.ok(k, `${slug}.${spec.key}`);
			assert.ok(k.unique && k.indexed, `${slug}.${spec.key} unique+indexed`);
		}
	}
});

test("link fields, reference fields and relations match the plugin's maps", () => {
	for (const l of LINK_FIELDS) assert.ok(field(l.collection, l.field)?.indexed, `${l.collection}.${l.field} indexed`);
	const seedRefs = seed.collections.flatMap((c) => c.fields.filter((f) => f.type === "reference").map((f) => [`${c.slug}.${f.slug}`, f.validation] as const));
	assert.deepEqual(new Set(seedRefs.map(([k]) => k)), new Set(Object.keys(REFERENCE_FIELDS)));
	for (const [k, v] of seedRefs) assert.deepEqual({ relation: v!.relation, side: v!.relationSide }, REFERENCE_FIELDS[k], k);
	for (const r of seed.relations) {
		assert.deepEqual(RELATION_ENDS[r.slug], { parent: r.parentCollection, child: r.childCollection }, r.slug);
		assert.ok(RELATION_EDGES[r.slug], `${r.slug} has an ontology edge type`);
	}
});

test("operation, device-class and data-decision options match the registry", () => {
	const opts = (c: string, f: string) => (field(c, f)?.validation?.options as string[]) ?? [];
	assert.deepEqual(new Set(opts("procedures", "operation")), new Set(["none", ...OPERATION_NAMES]));
	assert.deepEqual(new Set(opts("recovery_operations", "operation")), new Set(["none", ...OPERATION_NAMES]));
	assert.deepEqual(new Set(opts("assets", "device_class")), new Set(DEVICE_CLASSES));
	assert.deepEqual(new Set(opts("recovery_operations", "data_decision")), new Set(DATA_DECISIONS));
	for (const p of seed.content.procedures) assert.ok(["none", ...OPERATION_NAMES].includes(p.data.operation as string), String(p.data.code));
});

test("fields the journal projection and evidence writer use all exist", () => {
	for (const f of ["title", "event_type", "occurred_at", "stream", "sequence", "journal_id", "entry_hash", "asset_tag", "op_code", "job_id", "actor", "source", "payload"]) assert.ok(field("events", f), `events.${f}`);
	assert.ok(field("events", "journal_id")?.unique);
	for (const f of ["title", "evidence_type", "artifact_kind", "asset_tag", "op_code", "job_id", "op_revision", "captured_at", "file", "media_id", "sha256", "size_bytes", "original_filename", "mime_type", "digest_status", "execution_mode", "description", "attests", "signed_by"]) assert.ok(field("evidence", f), `evidence.${f}`);
	assert.equal(field("assets", "trust_state"), undefined, "trust is derived, never a field");
	assert.equal(field("assets", "recovery_state"), undefined, "recovery state is derived, never a field");
	assert.ok(seed.collections.find((c) => c.slug === "recovery_operations")!.supports!.includes("drafts"), "approval needs drafts");
});

test("the fleet is exactly as given, with no invented identifiers, and LAB 001 is not a mission target", () => {
	const assets = seed.content.assets.map((a) => a.data);
	assert.deepEqual(assets.map((a) => a.title), ["LAB 001", "LAB 512", "LAB 8GB", "LAB 256", "iPhone 13 RED", "iPhone 14 PURPLE", "iPhone 15 BLACK"]);
	for (const a of assets) {
		for (const k of ["serial_number", "ecid", "model_identifier", "os_policy"]) assert.equal(a[k], undefined, `${a.title} has no ${k}`);
	}
	const lab001 = assets.find((a) => a.title === "LAB 001")!;
	assert.equal(lab001.model, "MacBook Pro");
	assert.equal(lab001.os_at_intake, "macOS Catalina 10.15.7");
	assert.equal(lab001.role, "comms_terminal");
	for (const t of ["LAB 512", "LAB 8GB", "LAB 256"]) assert.equal(assets.find((a) => a.title === t)!.model, "Mac mini (M1)");
	const scope = seed.content.missions[0]!.data.assets as string[];
	assert.equal(scope.length, 6);
	assert.ok(!scope.includes("$ref:asset-lab-001"));
});

test("seed references only point at entries that come earlier", () => {
	const seen = new Set<string>();
	for (const [, entries] of Object.entries(seed.content)) {
		for (const e of entries) {
			for (const value of Object.values(e.data)) {
				for (const v of Array.isArray(value) ? value : [value]) {
					if (typeof v === "string" && v.startsWith("$ref:")) assert.ok(seen.has(v.slice(5)), `${e.id} → ${v}`);
				}
			}
			seen.add(e.id);
		}
	}
});
