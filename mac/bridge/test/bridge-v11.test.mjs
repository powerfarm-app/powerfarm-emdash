// v1.1 bridge behaviour: validation gating, leases, evidence, redaction, interruption.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ADAPTERS, adapterFor } from "../src/adapters.mjs";
import { artifactRoute } from "../src/client.mjs";
import { redact } from "../src/redact.mjs";
import { Bridge } from "../src/runner.mjs";
import { capabilityReport, validatedOperations } from "../src/validation.mjs";

const STUB = path.join(import.meta.dirname, "fixtures", "cfgutil-full.mjs");
chmodSync(STUB, 0o755);
const devices = [{ ecid: "0x1A2B3C4D5E6F", deviceType: "iPhone14,5" }];

const config = (over = {}) => ({
	cfgutilPath: STUB,
	profilesDir: "/tmp/profiles",
	logDir: mkdtempSync(path.join(os.tmpdir(), "pf-bridge11-")),
	hostAssetTag: "LAB-512",
	requireLocalConfirmation: true,
	simulate: false,
	...over,
});

const job = (over = {}) => ({
	id: "op1:rev1",
	opCode: "OP-0001",
	opRevision: "rev1",
	leaseId: "lease_abc",
	assetTag: "IPHONE-13-RED",
	deviceClass: "iphone",
	ecid: "0x1A2B3C4D5E6F",
	operation: "inventory",
	parameters: {},
	dryRun: false,
	...over,
});

function client({ started = { proceed: true, status: "running" } } = {}) {
	const calls = [];
	return {
		baseUrl: "http://fake",
		calls,
		claim: async (req) => (calls.push(["claim", req]), { job: null }),
		check: async (id, lease) => (calls.push(["check", id, lease]), { proceed: true, status: "running" }),
		report: async (id, phase, extra) => (calls.push(["report", phase, extra]), phase === "started" ? started : { proceed: false, status: phase }),
		uploadArtifact: async (a) => (calls.push(["artifact", a]), { evidenceId: "e1" }),
	};
}

test("operations are enabled only when validated on this host with this exact tool version", () => {
	const host = { macosVersion: "15.1", cfgutilVersion: "2.17" };
	const none = capabilityReport({ operations: {} }, host);
	assert.deepEqual(validatedOperations(none), []);
	const v = { operations: { inventory: { macosMajor: "15", cfgutilVersion: "2.17", method: "executed", validatedAt: "t" }, restore: { macosMajor: "15", cfgutilVersion: "2.16", method: "operator-attested", validatedAt: "t" } } };
	assert.deepEqual(validatedOperations(capabilityReport(v, host)), ["inventory"], "restore was validated with another cfgutil");
	assert.deepEqual(validatedOperations(capabilityReport(v, { macosVersion: "16.0", cfgutilVersion: "2.17" })), [], "different macOS major");
	assert.deepEqual(validatedOperations(capabilityReport(v, { macosVersion: "15.1", cfgutilVersion: null })), [], "no cfgutil");
	const mac = capabilityReport(v, host).find((a) => a.id === "mac-manual");
	assert.ok(mac.operations.every((o) => !o.validated), "Mac operations are never offered");
	assert.ok(mac.operations.some((o) => o.name === "mac_dfu_restore" && /Finder/.test(o.reason)));
});

test("adapters keep device classes apart: no Mac operation is executable", () => {
	assert.equal(adapterFor("restore", "iphone")?.id, "ios-cfgutil");
	assert.equal(adapterFor("restore", "mac_apple_silicon"), null);
	assert.equal(adapterFor("mac_dfu_restore"), null);
	assert.equal(ADAPTERS.find((a) => a.id === "mac-manual").operations.length, undefined);
});

test("a real bridge refuses an operation it has not validated, even if EmDash sent it", async () => {
	const c = client();
	await new Bridge({ client: c, config: config() }).handle(job(), null, devices);
	assert.equal(c.calls.at(-1)[1], "failed");
	assert.match(c.calls.at(-1)[2].message, /not validated on this host/);
});

test("the claim declares mode and validated operations; a simulator declares none", async () => {
	const real = client();
	await new Bridge({ client: real, config: config(), validated: ["inventory"] }).tick();
	assert.deepEqual(real.calls[0][1].mode, "real");
	assert.deepEqual(real.calls[0][1].validatedOperations, ["inventory"]);
	const sim = client();
	await new Bridge({ client: sim, config: config({ simulate: true, simulatedDevices: devices }), validated: ["inventory"] }).tick();
	assert.equal(sim.calls[0][1].mode, "simulated");
	assert.deepEqual(sim.calls[0][1].validatedOperations, []);
});

test("a real inventory uploads redacted evidence before reporting success, with lease and revision on every report", async () => {
	const c = client();
	await new Bridge({ client: c, config: config(), validated: ["inventory"] }).handle(job(), null, devices);
	const kinds = c.calls.map((x) => x[0] === "report" ? x[1] : x[0]);
	assert.deepEqual(kinds, ["started", "artifact", "artifact", "succeeded"]);
	for (const r of c.calls.filter((x) => x[0] === "report")) {
		assert.equal(r[2].leaseId, "lease_abc");
		assert.equal(r[2].opRevision, "rev1");
	}
	const log = c.calls.find((x) => x[0] === "artifact")[1];
	assert.equal(log.kind, "inventory_report");
	const text = log.bytes.toString();
	assert.ok(!text.includes("someone@example.com"), "email redacted");
	assert.ok(!text.includes("abc123"), "token redacted");
	assert.ok(text.includes("F2LXK0ABCD12"), "device identifiers kept");
	const done = c.calls.at(-1)[2];
	assert.equal(done.observed.serialNumber, "F2LXK0ABCD12");
	assert.equal(done.observed.osVersion, "18.2");
});

test("a crash mid-job is reported as interrupted on the next start", async () => {
	const cfg = config();
	writeFileSync(path.join(cfg.logDir, "in-flight.json"), JSON.stringify({ jobId: "op9:rev9", opCode: "OP-0009", leaseId: "lease_9", opRevision: "rev9" }));
	const c = client();
	await new Bridge({ client: c, config: cfg }).recoverInFlight();
	assert.deepEqual(c.calls[0].slice(0, 2), ["report", "interrupted"]);
	assert.equal(c.calls[0][2].leaseId, "lease_9");
	assert.equal(existsSync(path.join(cfg.logDir, "in-flight.json")), false);
});

test("shutdown stops a non-destructive command and reports it interrupted; it never kills a restore", async () => {
	process.env.STUB_BACKUP_MS = "2000";
	try {
		const c = client();
		const bridge = new Bridge({ client: c, config: config(), validated: ["backup"] });
		const running = bridge.handle(job({ operation: "backup" }), null, devices);
		await new Promise((r) => setTimeout(r, 300));
		bridge.requestStop();
		await running;
		assert.equal(c.calls.at(-1)[1], "interrupted");
	} finally {
		delete process.env.STUB_BACKUP_MS;
	}
	const b = new Bridge({ client: client(), config: config() });
	let killed = false;
	b.current = { job: job({ operation: "restore" }), destructive: true, child: { kill: () => (killed = true) } };
	b.requestStop();
	assert.equal(killed, false);
});

test("redaction removes account identifiers and credentials but keeps device identifiers and timestamps", () => {
	const out = redact("2026-11-02 10:46:27 user a.b@icloud.com phone +351 912 345 678 password: hunter2 Bearer abc.def ec_pat_XYZ ECID 0x1A2B serial F2LXK0ABCD12");
	assert.ok(!/icloud|912 345|hunter2|abc\.def|ec_pat_XYZ/.test(out), out);
	assert.ok(out.includes("2026-11-02 10:46:27") && out.includes("0x1A2B") && out.includes("F2LXK0ABCD12"));
});

test("the artifact signature covers its metadata", () => {
	const base = { jobId: "j", leaseId: "l", kind: "restore_log", sha256: "a".repeat(64), contentType: "text/plain", filename: "f.log" };
	assert.notEqual(artifactRoute(base), artifactRoute({ ...base, jobId: "other" }));
	assert.notEqual(artifactRoute(base), artifactRoute({ ...base, kind: "inventory_report" }));
	assert.equal(artifactRoute(base).split("|").length, 7);
});
