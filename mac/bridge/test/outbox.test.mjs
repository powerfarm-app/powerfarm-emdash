// The lab is less available than Cloudflare: results survive outages and restarts.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Bridge } from "../src/runner.mjs";

const STUB = path.join(import.meta.dirname, "fixtures", "cfgutil-full.mjs");
chmodSync(STUB, 0o755);
const devices = [{ ecid: "0x1A2B3C4D5E6F", deviceType: "iPhone14,5" }];
const config = (logDir = mkdtempSync(path.join(os.tmpdir(), "pf-outbox-"))) => ({ cfgutilPath: STUB, profilesDir: "/tmp/profiles", logDir, hostAssetTag: "LAB-512", requireLocalConfirmation: true, simulate: false });
const job = { id: "op1:rev1", opCode: "OP-0001", opRevision: "rev1", leaseId: "lease_abc", assetTag: "IPHONE-13-RED", deviceClass: "iphone", ecid: "0x1A2B3C4D5E6F", operation: "inventory", parameters: {}, dryRun: false };

/** A fake EmDash that can go offline. Only `started` gets through while offline is "after-start". */
function emdash() {
	const state = { online: true, calls: [], refuse: null };
	const offline = () => Object.assign(new TypeError("fetch failed"), {});
	const c = {
		baseUrl: "https://powerfarm.example",
		state,
		claim: async () => (state.calls.push(["claim"]), { job: null }),
		check: async () => ({ proceed: true, status: "running" }),
		report: async (id, phase, extra) => {
			if (!state.online && phase !== "started") throw offline();
			if (state.refuse === phase) throw Object.assign(new Error("EmDash rejected bridge/report: LEASE_MISMATCH"), { status: 409, code: "LEASE_MISMATCH" });
			state.calls.push(["report", phase, extra.reportId]);
			return phase === "started" ? { proceed: true, status: "running" } : { proceed: false, status: phase };
		},
		uploadArtifact: async (a) => {
			if (!state.online) throw offline();
			state.calls.push(["artifact", a.kind]);
			return { evidenceId: "e1" };
		},
	};
	return c;
}

test("results produced while EmDash is unreachable are kept, survive a restart, and are delivered in order with the same report id", async () => {
	const cfg = config();
	const c = emdash();
	const b = new Bridge({ client: c, config: cfg, validated: ["inventory"] });
	await c.report(job.id, "started", { reportId: "x" }); // reachable at the start
	c.state.calls.length = 0;
	c.state.online = false; // the lab's line drops during the job
	await b.handle(job, null, devices);
	assert.equal(b.outbox.pending().length, 3, "two evidence files and the success report wait on disk");
	assert.equal(existsSync(path.join(cfg.logDir, "in-flight.json")), false, "the result is safe, so the job is no longer in flight");

	// The bridge restarts while still offline: nothing is reported as interrupted, nothing new is claimed.
	const again = new Bridge({ client: c, config: cfg, validated: ["inventory"] });
	await again.recoverInFlight();
	assert.equal(await again.tick(), false);
	assert.ok(!c.state.calls.some((x) => x[0] === "claim"), "no new work while results are undelivered");

	c.state.online = true;
	assert.equal(await again.flush(), 0);
	assert.deepEqual(c.state.calls.map((x) => (x[0] === "report" ? x[1] : x[0])).filter((k) => k !== "started"), ["artifact", "artifact", "succeeded"]);
	assert.match(String(c.state.calls.at(-1)[2]), /^rep_/, "the report id was fixed when it was queued");
	await again.tick();
	assert.ok(c.state.calls.some((x) => x[0] === "claim"), "claims resume once everything is delivered");
});

test("a report EmDash refuses is set aside for a person, not retried forever, and does not block later work", async () => {
	const cfg = config();
	const c = emdash();
	c.state.refuse = "succeeded";
	const b = new Bridge({ client: c, config: cfg, validated: ["inventory"] });
	await b.handle(job, null, devices);
	assert.equal(b.outbox.pending().length, 0);
	assert.equal(b.outbox.rejected().length, 1);
	await b.tick();
	assert.ok(c.state.calls.some((x) => x[0] === "claim"));
});

test("a crash before the result was queued is still reported as interrupted", async () => {
	const cfg = config();
	const c = emdash();
	const b = new Bridge({ client: c, config: cfg });
	const { writeFileSync } = await import("node:fs");
	writeFileSync(path.join(cfg.logDir, "in-flight.json"), JSON.stringify({ jobId: "op9:rev9", opCode: "OP-0009", leaseId: "lease_9", opRevision: "rev9" }));
	await b.recoverInFlight();
	assert.equal(c.state.calls[0][1], "interrupted");
});
