// Version 1 baseline tests, ported to the v1.1 APIs.
//
// Each test keeps its original name and intent. Tests 1, 2 and 6 are unchanged
// apart from imports. Tests 3–5 and 7 exercised v1 modules that were replaced
// (Snapshot, the v1 Graph and jobs.nextStep); they now assert the same
// behaviour through recovery.ts and the v1.1 GraphService. Where v1.1 is
// deliberately stricter (real executions only, exact verification, explicit OS
// policy), the fixtures supply what v1.1 requires rather than weakening it.
import assert from "node:assert/strict";
import { test } from "node:test";

// The bridge client's signer, to prove both sides agree on the wire format.
import { signRequest } from "../../mac/bridge/src/sign.mjs";
import { accessFor } from "../src/access.ts";
import { verifyBridgeRequest } from "../src/bridge-auth.ts";
import { ContentReader } from "../src/content.ts";
import { clearGraphCache, GraphService } from "../src/graph.ts";
import { JOB_TRANSITIONS } from "../src/model.ts";
import { acceptanceChecklist, assetProgress, deriveStatus, nextAction } from "../src/recovery.ts";
import { fakeCtx } from "./fake-ctx.ts";
import { at, attestation, goodObserved, iphone, job, mac } from "./helpers.ts";
import { TestDb } from "./sqlite-port.ts";

const SECRET = "x".repeat(64);
const ROUTE = "powerfarm/bridge/claim";

async function verify(headers: Record<string, string>, body: string, opts: Partial<Parameters<typeof verifyBridgeRequest>[0]> = {}) {
	const nonces = new Set<string>();
	return verifyBridgeRequest({
		headers: new Headers(headers),
		route: ROUTE,
		body,
		expectedBridgeId: "lab-512-bridge",
		secret: SECRET,
		claimNonce: async (n) => (nonces.has(n) ? false : (nonces.add(n), true)),
		...opts,
	});
}

test("a request signed by the bridge client verifies in the plugin", async () => {
	const body = JSON.stringify({ devices: [] });
	const headers = signRequest({ bridgeId: "lab-512-bridge", secret: SECRET, route: ROUTE, body });
	assert.deepEqual(await verify(headers, body), { ok: true, bridgeId: "lab-512-bridge" });
});

test("tampered body, wrong route, wrong secret, old timestamp and replays are rejected", async () => {
	const body = JSON.stringify({ devices: [] });
	const headers = signRequest({ bridgeId: "lab-512-bridge", secret: SECRET, route: ROUTE, body });
	assert.equal(((await verify(headers, body + " ")) as { reason: string }).reason, "BAD_SIGNATURE");
	assert.equal(((await verify(headers, body, { route: "powerfarm/bridge/report" })) as { reason: string }).reason, "BAD_SIGNATURE");
	assert.equal(((await verify(headers, body, { secret: "y".repeat(64) })) as { reason: string }).reason, "BAD_SIGNATURE");
	assert.equal(((await verify(headers, body, { expectedBridgeId: "other" })) as { reason: string }).reason, "UNKNOWN_BRIDGE");
	assert.equal(((await verify(headers, body, { secret: null })) as { reason: string }).reason, "NOT_CONFIGURED");
	const old = signRequest({ bridgeId: "lab-512-bridge", secret: SECRET, route: ROUTE, body, now: Date.now() - 3_600_000 });
	assert.equal(((await verify(old, body)) as { reason: string }).reason, "CLOCK_SKEW");

	const seen = new Set<string>();
	const claimNonce = async (n: string) => (seen.has(n) ? false : (seen.add(n), true));
	assert.equal((await verify(headers, body, { claimNonce })).ok, true);
	assert.equal(((await verify(headers, body, { claimNonce })) as { reason: string }).reason, "REPLAYED");
	// v1.1: during rotation the next secret is also accepted.
	assert.equal((await verify(signRequest({ bridgeId: "lab-512-bridge", secret: "z".repeat(64), route: ROUTE, body }), body, { nextSecret: "z".repeat(64) })).ok, true);
});

test("Mission 001 sequence for an iPhone follows inventory → backup → restore → verify → attestation → human sign-off", () => {
	const asset = iphone();
	const jobs: ReturnType<typeof job>[] = [];
	const evidence: ReturnType<typeof attestation>[] = [];
	const step = () => {
		const p = assetProgress(asset, jobs, evidence);
		return nextAction(asset, deriveStatus(asset, p, false), p, "LAB-512").procedureCode ?? "-";
	};
	const steps: string[] = [];

	steps.push(step()); // identified, inventory not yet real
	jobs.push(job({ operation: "inventory", finishedAt: at(1), result: { observed: goodObserved } }));
	steps.push(step()); // recovery ready → restore (backup decision is part of the restore approval)
	jobs.push(job({ operation: "backup", finishedAt: at(2) }));
	jobs.push(job({ operation: "restore", dryRun: true, executionMode: "dry_run", finishedAt: at(3) }));
	steps.push(step()); // a dry run does not count
	jobs.push(job({ operation: "restore", finishedAt: at(4) }));
	steps.push(step());
	jobs.push(job({ operation: "verify", finishedAt: at(5), result: { observed: goodObserved } }));
	steps.push(step());

	assert.deepEqual(steps, ["P-INVENTORY", "P-IOS-RESTORE", "P-IOS-RESTORE", "P-VERIFY", "P-ACCOUNT-SECURITY"]);

	for (const k of ["account_security", "activation_lock", "management_enrollment"]) evidence.push(attestation(k, at(6)));
	const p = assetProgress(asset, jobs, evidence);
	const status = deriveStatus(asset, p, false);
	assert.equal(status.status, "verified");
	assert.equal(nextAction(asset, status, p, "LAB-512").blocking, "Needs a person's decision.");

	evidence.push(attestation("trust_signoff", at(7)));
	const p2 = assetProgress(asset, jobs, evidence);
	const final = deriveStatus(asset, p2, false);
	assert.equal(final.status, "trusted");
	assert.equal(nextAction(asset, final, p2, "LAB-512").complete, true);
	assert.equal(acceptanceChecklist(asset, p2, final, false).passed, true);
});

test("an active job blocks the next step; the host and the comms terminal are handled specially", () => {
	const asset = iphone();
	const running = [job({ status: "running", operation: "restore", finishedAt: null as never })];
	const p = assetProgress(asset, running, []);
	assert.match(nextAction(asset, deriveStatus(asset, p, false), p, "LAB-512").blocking ?? "", /is running/);

	const host = mac({ assetTag: "LAB-512", role: "trusted_host", serialNumber: null });
	const hp = assetProgress(host, [], []);
	assert.equal(nextAction(host, deriveStatus(host, hp, false), hp, "LAB-512").procedureCode, "P-HOST-BOOTSTRAP");

	const comms = mac({ assetTag: "LAB-001", deviceClass: "mac_intel", role: "comms_terminal" });
	const cp = assetProgress(comms, [], []);
	assert.equal(nextAction(comms, deriveStatus(comms, cp, false), cp, "LAB-512").complete, true);
});

test("a failed verification blocks progress until it is resolved", () => {
	const asset = iphone();
	const jobs = [
		job({ operation: "inventory", finishedAt: at(1), result: { observed: goodObserved } }),
		job({ operation: "backup", finishedAt: at(2) }),
		job({ operation: "restore", finishedAt: at(3) }),
		job({ operation: "verify", finishedAt: at(4), result: { observed: { ...goodObserved, serialNumber: "ZZZZZZZZZZZZ" } } }),
	];
	const p = assetProgress(asset, jobs, []);
	const status = deriveStatus(asset, p, false);
	assert.equal(status.status, "blocked");
	assert.match(nextAction(asset, status, p, "LAB-512").blocking ?? "", /did not pass/);
});

test("job transitions only move forward; terminal states are final", () => {
	for (const terminal of ["succeeded", "failed", "revoked", "stalled", "needs_inspection"] as const) assert.deepEqual(JOB_TRANSITIONS[terminal], []);
	assert.ok(!JOB_TRANSITIONS.approved.includes("running"), "a job must be claimed before it runs");
	assert.ok(!JOB_TRANSITIONS.running.includes("approved"));
});

test("the graph joins native relations and link fields, and traces across them", async () => {
	clearGraphCache();
	const db = new TestDb();
	const mission = db.insert("missions", { title: "Mission 001", code: "M001" });
	const asset = db.insert("assets", { title: "iPhone 13 RED", asset_tag: "IPHONE-13-RED", device_class: "iphone", role: "fleet" });
	const proc = db.insert("procedures", { title: "iPhone restore", code: "P-IOS-RESTORE", operation: "restore" });
	db.insert("recovery_operations", { title: "Restore iPhone 13", op_code: "OP-0007", asset_tag: "IPHONE-13-RED", procedure_code: "P-IOS-RESTORE", mission_code: "M001", operation: "restore" });
	db.insert("events", { title: "OP-0007 succeeded", event_type: "job.succeeded", occurred_at: at(1), op_code: "OP-0007", asset_tag: "IPHONE-13-RED", journal_id: "evt_1" });
	const research = db.insert("research", { title: "iOS restore notes" });
	db.link("missions_assets", mission.group, asset.group);
	db.link("research_procedures", research.group, proc.group);
	const g = new GraphService(fakeCtx() as never, new ContentReader(db.port()), accessFor({ id: "e", role: 40 }));

	assert.equal((await g.search("op-0007"))[0]?.key, "OP-0007");
	const around = (await g.neighbours(`asset:${asset.group}`))!.neighbours.map((n) => n.node.type).sort();
	assert.deepEqual(around, ["event", "mission", "operation"]);
	const traced = await g.trace(`asset:${asset.group}`, { depth: 3, direction: "both" });
	const r = traced!.nodes.find((n) => n.id === `research:${research.group}`);
	assert.ok(r, "research reached through operation → procedure → research");
	assert.equal(r.depth, 3);
});
