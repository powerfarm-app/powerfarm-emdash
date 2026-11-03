// Graph: access control, identity, direction, storage nodes, paging, caching, staged edges.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { accessFor } from "../src/access.ts";
import { ContentReader } from "../src/content.ts";
import { clearGraphCache, GraphService } from "../src/graph.ts";
import { buildJob, createJobOnce } from "../src/jobs.ts";
import { bumpGraphVersion } from "../src/policy.ts";
import { fakeCtx } from "./fake-ctx.ts";
import { TestDb } from "./sqlite-port.ts";

const SUB = { id: "s1", role: 10 };
const EDITOR = { id: "e1", role: 40 };
const ADMIN = { id: "a1", role: 50 };

function world() {
	const db = new TestDb();
	const mission = db.insert("missions", { title: "Mission 001", code: "M001" });
	const iphone = db.insert("assets", { title: "iPhone 13 RED", asset_tag: "IPHONE-13-RED", device_class: "iphone", role: "fleet", serial_number: "F2LXK0ABCD12", ecid: "0x1A2B3C4D5E6F" });
	const lab = db.insert("assets", { title: "LAB 8GB", asset_tag: "LAB-8GB", device_class: "mac_apple_silicon", role: "fleet" });
	const proc = db.insert("procedures", { title: "iPhone restore", code: "P-IOS-RESTORE", operation: "restore" });
	const research = db.insert("research", { title: "Restore notes" });
	db.link("missions_assets", mission.group, iphone.group);
	db.link("missions_assets", mission.group, lab.group);
	db.link("research_procedures", research.group, proc.group);
	const op = db.insert("recovery_operations", { title: "Restore iPhone 13", op_code: "OP-0007", asset_tag: "IPHONE-13-RED", procedure_code: "P-IOS-RESTORE", mission_code: "M001", operation: "restore" });
	const draftOp = db.insert("recovery_operations", { title: "Unapproved idea", op_code: "OP-0008", asset_tag: "IPHONE-13-RED", procedure_code: "P-IOS-RESTORE", mission_code: "M001", operation: "restore" }, { status: "draft" });
	const ev = db.insert("evidence", { title: "Restore log", evidence_type: "log", asset_tag: "IPHONE-13-RED", op_code: "OP-0007", job_id: `${op.id}:${op.liveRevisionId}`, media_id: "media_9" });
	return { db, mission, iphone, lab, proc, research, op, draftOp, ev };
}

function service(w: ReturnType<typeof world>, user: { id: string; role: number }, request = {}, ctx = fakeCtx()) {
	return { g: new GraphService(ctx as never, new ContentReader(w.db.port()), accessFor(user, request)), ctx };
}

beforeEach(() => clearGraphCache());

test("published-only by default: drafts never appear without an editor asking for them", async () => {
	const w = world();
	const asSub = service(w, SUB).g;
	const asEditor = service(w, EDITOR).g;
	const asEditorDrafts = service(w, EDITOR, { includeDrafts: true }).g;
	const asSubAsking = service(w, SUB, { includeDrafts: true }).g;
	const ops = async (g: GraphService) => ((await g.neighbours(`asset:${w.iphone.group}`))?.neighbours ?? []).filter((n) => n.node.type === "operation").map((n) => n.node.key);
	assert.deepEqual(await ops(asSub), [], "subscribers cannot see operations at all");
	assert.deepEqual(await ops(asEditor), ["OP-0007"], "published only");
	assert.deepEqual(await ops(asSubAsking), [], "asking is not enough without the role");
	assert.deepEqual((await ops(asEditorDrafts)).sort(), ["OP-0007", "OP-0008"]);
	assert.equal(await asEditor.getNode(`operation:${w.draftOp.group}`), null, "a draft node is not reachable directly either");
});

test("operational node types are hidden from subscribers; hardware identifiers are masked unless an admin asks", async () => {
	const w = world();
	const sub = service(w, SUB).g;
	assert.equal(await sub.getNode(`evidence:${w.ev.group}`), null);
	const node = await sub.getNode(`asset:${w.iphone.group}`);
	assert.equal(node!.data!.serial_number, "••••CD12");
	assert.equal(node!.data!.ecid, "••••5E6F");
	const adminDefault = await service(w, ADMIN).g.getNode(`asset:${w.iphone.group}`);
	assert.equal(adminDefault!.data!.serial_number, "••••CD12", "even admins get masked values by default");
	const adminReveal = await service(w, ADMIN, { revealIdentifiers: true }).g.getNode(`asset:${w.iphone.group}`);
	assert.equal(adminReveal!.data!.serial_number, "F2LXK0ABCD12");
	const editorReveal = await service(w, EDITOR, { revealIdentifiers: true }).g.getNode(`asset:${w.iphone.group}`);
	assert.equal(editorReveal!.data!.serial_number, "••••CD12", "editors cannot reveal");
});

test("identity is the translation group, choosing the default locale's row, not the last row", async () => {
	const db = new TestDb();
	db.insert("software", { title: "Zeta (pt)" }, { locale: "pt", group: "grp_sw" });
	db.insert("software", { title: "Alpha (en)" }, { locale: "en", group: "grp_sw" });
	db.insert("software", { title: "Beta (fr)" }, { locale: "fr", group: "grp_sw" });
	const g = new GraphService(fakeCtx() as never, new ContentReader(db.port(), "en"), accessFor(SUB));
	const node = await g.getNode("software:grp_sw");
	assert.equal(node!.title, "Alpha (en)");
	assert.equal(node!.id, "software:grp_sw");
});

test("relationship direction and labels follow the relation's parent → child", async () => {
	const w = world();
	const g = service(w, EDITOR).g;
	const fromMission = await g.neighbours(`mission:${w.mission.group}`, { direction: "out" });
	assert.deepEqual(fromMission!.neighbours.map((n) => [n.edge.type, n.edge.label, n.node.key]).sort(), [
		["scopes", "scopes", "IPHONE-13-RED"],
		["scopes", "scopes", "LAB-8GB"],
	]);
	const intoAsset = await g.neighbours(`asset:${w.iphone.group}`, { direction: "in", edgeTypes: ["scopes"] });
	assert.equal(intoAsset!.neighbours[0]!.edge.label, "in scope of");
	assert.equal(intoAsset!.neighbours[0]!.edge.from, `mission:${w.mission.group}`);
	assert.equal(intoAsset!.neighbours[0]!.edge.state, "published");
});

test("jobs, leases, bridges and journal entries are graph nodes, connected to operation, asset and evidence", async () => {
	const w = world();
	const ctx = fakeCtx();
	const job = buildJob(
		{ opId: w.op.id, liveRevisionId: w.op.liveRevisionId, authorId: "a1", data: { op_code: "OP-0007", operation: "restore", asset_tag: "IPHONE-13-RED", procedure_code: "P-IOS-RESTORE", mission_code: "M001", dry_run: false } },
		{ asset: { assetTag: "IPHONE-13-RED", deviceClass: "iphone", ecid: "0x1A2B3C4D5E6F", serialNumber: "F2LXK0ABCD12" }, approvedBy: "user:a1", approvedAt: new Date().toISOString() },
	) as never as { id: string };
	await createJobOnce(ctx as never, { ...(job as object), claimedBy: "lab-512-bridge", leaseId: "lease_x", evidence: [{ kind: "restore_log", evidenceId: w.ev.id, mediaId: "media_9", sha256: "a".repeat(64) }] } as never, "policy");
	await ctx.storage.bridges.put("lab-512-bridge", { id: "lab-512-bridge", status: "online", lastSeenAt: new Date().toISOString(), bridgeVersion: "1.1.0" });
	const g = service(w, EDITOR, {}, ctx).g;

	const aroundAsset = await g.neighbours(`asset:${w.iphone.group}`, { nodeTypes: ["job"] });
	assert.equal(aroundAsset!.neighbours.length, 1);
	const jobNode = aroundAsset!.neighbours[0]!.node;
	assert.equal(jobNode.type, "job");
	const aroundJob = await g.neighbours(jobNode.id);
	const types = new Set(aroundJob!.neighbours.map((n) => `${n.edge.type}:${n.node.type}`));
	for (const t of ["executes:operation", "acts_on:asset", "claimed_by:bridge", "holds_lease:lease", "produced:evidence", "recorded:journal_event"]) assert.ok(types.has(t), t);
	assert.ok(aroundJob!.neighbours.filter((n) => n.edge.type === "recorded").every((n) => n.edge.state === "historical"));
	const jobView = await g.getNode(jobNode.id);
	assert.equal(jobView!.data!.leaseId, undefined, "lease tokens never appear");
	assert.equal(jobView!.data!.ecid, "••••5E6F");
	const evidence = await g.neighbours(`evidence:${w.ev.group}`);
	assert.ok(evidence!.neighbours.some((n) => n.node.type === "job"), "evidence → job");
	assert.ok(evidence!.neighbours.some((n) => n.edge.type === "evidence_for" && n.node.type === "asset"), "evidence → asset");
});

test("neighbour queries page with stable cursors; traversal is bounded", async () => {
	const db = new TestDb();
	const mission = db.insert("missions", { title: "Big", code: "M900" });
	for (let i = 0; i < 25; i++) db.link("missions_assets", mission.group, db.insert("assets", { title: `A${i}`, asset_tag: `A-${String(i).padStart(2, "0")}`, device_class: "iphone", role: "fleet" }).group);
	const g = new GraphService(fakeCtx() as never, new ContentReader(db.port()), accessFor(EDITOR));
	const seen: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await g.neighbours(`mission:${mission.group}`, { limit: 10, cursor });
		assert.equal(page!.total, 25);
		seen.push(...page!.neighbours.map((n) => n.node.key!));
		cursor = page!.cursor;
	} while (cursor);
	assert.equal(seen.length, 25);
	assert.equal(new Set(seen).size, 25);
	const traced = await g.trace(`mission:${mission.group}`, { depth: 4, maxNodes: 5 });
	assert.equal(traced!.nodes.length, 5);
	assert.equal(traced!.truncated, true);
});

test("content edges are cached and invalidated by the graph version the hooks bump", async () => {
	const w = world();
	const ctx = fakeCtx();
	const g = service(w, EDITOR, {}, ctx).g;
	const count = async () => (await g.neighbours(`mission:${w.mission.group}`, { edgeTypes: ["scopes"] }))!.total;
	assert.equal(await count(), 2);
	w.db.link("missions_assets", w.mission.group, w.db.insert("assets", { title: "iPhone 14 PURPLE", asset_tag: "IPHONE-14-PURPLE", device_class: "iphone", role: "fleet" }).group);
	assert.equal(await count(), 2, "cached");
	await bumpGraphVersion(ctx as never);
	assert.equal(await count(), 3, "invalidated");
});

test("staged references in a draft revision show as proposed edges, only in the draft view", async () => {
	const db = new TestDb();
	const mission = db.insert("missions", { title: "Mission 001", code: "M001" });
	const asset = db.insert("assets", { title: "iPhone 15 BLACK", asset_tag: "IPHONE-15-BLACK", device_class: "iphone", role: "fleet" });
	db.db.prepare("update ec_missions set draft_revision_id = ? where id = ?").run("rev_d1", mission.id);
	db.db.prepare("insert into revisions values (?, ?, ?, ?, ?, ?)").run("rev_d1", "missions", mission.id, JSON.stringify({ title: "Mission 001", code: "M001", _references: { assets: [asset.group] } }), null, "");
	const published = new GraphService(fakeCtx() as never, new ContentReader(db.port()), accessFor(EDITOR));
	const draft = new GraphService(fakeCtx() as never, new ContentReader(db.port()), accessFor(EDITOR, { includeDrafts: true }));
	assert.equal((await published.neighbours(`mission:${mission.group}`))!.total, 0);
	const proposed = (await draft.neighbours(`mission:${mission.group}`))!.neighbours;
	assert.equal(proposed.length, 1);
	assert.equal(proposed[0]!.edge.state, "proposed");
	assert.equal(proposed[0]!.edge.source, "staged");
});

test("search resolves business keys exactly and returns no drafts", async () => {
	const w = world();
	const g = service(w, EDITOR).g;
	assert.equal((await g.search("op-0007"))[0]?.key, "OP-0007");
	assert.deepEqual(await g.search("OP-0008"), [], "draft operation not searchable in published view");
	const ctxPackage = await g.context("IPHONE-13-RED");
	assert.equal(ctxPackage.items[0]!.node!.key, "IPHONE-13-RED");
	assert.ok(ctxPackage.items[0]!.related.length > 0);
	assert.equal(ctxPackage.identifiersRedacted, true);
});
