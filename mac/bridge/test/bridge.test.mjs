import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseListText } from "../src/devices.mjs";
import { buildCommand, parseInventory } from "../src/operations.mjs";
// v1.1: a real bridge only executes operations validated on its host; fixtures declare that.
import { Bridge, normalizeEcid } from "../src/runner.mjs";
import { signRequest } from "../src/sign.mjs";

const config = (over = {}) => ({
	cfgutilPath: "/usr/bin/cfgutil",
	profilesDir: "/tmp/profiles",
	logDir: mkdtempSync(path.join(os.tmpdir(), "pf-bridge-")),
	hostAssetTag: "LAB-512",
	requireLocalConfirmation: true,
	simulate: false,
	...over,
});

const job = (over = {}) => ({
	id: "op1:rev1",
	opCode: "OP-0001",
	assetTag: "IPHONE-13-RED",
	ecid: "0x1A2B3C4D5E",
	operation: "inventory",
	parameters: {},
	dryRun: false,
	...over,
});

test("command lines are fixed argv lists pinned to the device ECID", () => {
	assert.deepEqual(buildCommand(job({ operation: "restore" }), "0x1A2B3C4D5E", config()).args, ["--ecid", "0x1A2B3C4D5E", "restore"]);
	assert.deepEqual(buildCommand(job({ operation: "backup" }), "0x1A2B3C4D5E", config()).args, ["--ecid", "0x1A2B3C4D5E", "backup"]);
	assert.equal(buildCommand(job({ operation: "verify" }), "0x1A2B3C4D5E", config()).args.includes("get"), true);
});

test("operations outside the allowlist are refused", () => {
	assert.throws(() => buildCommand(job({ operation: "erase-all-content" }), "0x1", config()), /not allowed/);
	assert.throws(() => buildCommand(job({ operation: "__proto__" }), "0x1", config()), /not allowed/);
});

test("profile installs cannot escape the profiles folder", () => {
	assert.throws(() => buildCommand(job({ operation: "install_profile", parameters: { profile: "../../etc/x.mobileconfig" } }), "0x1", config()), /profile/);
	assert.throws(() => buildCommand(job({ operation: "install_profile", parameters: { profile: "evil.sh" } }), "0x1", config()), /profile/);
	const ok = buildCommand(job({ operation: "install_profile", parameters: { profile: "baseline.mobileconfig" } }), "0x1", config());
	assert.equal(ok.args.at(-1), "/tmp/profiles/baseline.mobileconfig");
});

test("inventory output is parsed whether or not cfgutil nests it by ECID", () => {
	const nested = JSON.stringify({ Output: { "0x1A2B": { serialNumber: "F2LXYZ", firmwareVersion: "18.1", deviceType: "iPhone14,5" } } });
	assert.equal(parseInventory(nested, "0x1A2B").serialNumber, "F2LXYZ");
	assert.equal(parseInventory(nested, "0x1A2B").osVersion, "18.1");
	const flat = JSON.stringify({ Output: { serialNumber: "C02ABC", firmwareVersion: "15.1" } });
	assert.equal(parseInventory(flat, "0x9").serialNumber, "C02ABC");
	assert.equal(parseInventory("not json", "0x9").raw, "not json");
});

test("device list text fallback finds ECIDs", () => {
	const text = "Type: iPhone14,5\tECID: 0x1A2B3C\tUDID: 0000\nType: MacBookPro18,1  ECID: 0xFFEE\n";
	assert.deepEqual(parseListText(text).map((d) => d.ecid), ["0x1A2B3C", "0xFFEE"]);
});

test("ECIDs compare regardless of prefix, case and leading zeros", () => {
	assert.equal(normalizeEcid("0x001a2b"), normalizeEcid("1A2B"));
});

test("signatures carry route, timestamp, nonce and body hash", () => {
	const a = signRequest({ bridgeId: "b", secret: "s".repeat(32), route: "powerfarm/bridge/claim", body: "{}", now: 1_700_000_000_000, nonce: "n".repeat(24) });
	const b = signRequest({ bridgeId: "b", secret: "s".repeat(32), route: "powerfarm/bridge/check", body: "{}", now: 1_700_000_000_000, nonce: "n".repeat(24) });
	assert.notEqual(a["x-powerfarm-signature"], b["x-powerfarm-signature"]);
	assert.equal(a["x-powerfarm-timestamp"], "1700000000");
});

// ---------------------------------------------------------------------------
// The loop, against a fake EmDash
// ---------------------------------------------------------------------------

function fakeClient({ job: claimed, check = { proceed: true, status: "running" }, started = { proceed: true, status: "running" } }) {
	const calls = [];
	return {
		baseUrl: "http://fake",
		calls,
		claim: async (devices) => (calls.push(["claim", devices]), { job: claimed, procedure: { physicalSteps: "Plug it in." } }),
		check: async (id) => (calls.push(["check", id]), check),
		report: async (id, phase, extra) => (calls.push(["report", phase, extra]), phase === "started" ? started : { proceed: false, status: phase }),
	};
}

const devices = [{ ecid: "0x1A2B3C4D5E", deviceType: "iPhone14,5" }];

test("simulation reports success without touching the device", async () => {
	const client = fakeClient({ job: job({ operation: "restore" }) });
	const bridge = new Bridge({ client, config: config({ simulate: true, simulatedDevices: devices }) });
	assert.equal(await bridge.tick(), true);
	const phases = client.calls.filter((c) => c[0] === "report").map((c) => c[1]);
	assert.deepEqual(phases, ["started", "succeeded"]);
	assert.equal(client.calls.at(-1)[2].result.simulated, true);
});

test("a dry run of a destructive operation never executes it", async () => {
	const client = fakeClient({ job: job({ operation: "restore", dryRun: true }) });
	const bridge = new Bridge({ client, config: config() });
	await bridge.handle((await client.claim(devices)).job, null, devices);
	const last = client.calls.at(-1);
	assert.equal(last[1], "succeeded");
	assert.match(last[2].message, /^Dry run: would run/);
});

test("the bridge refuses to act on its own host", async () => {
	const client = fakeClient({ job: job({ assetTag: "LAB-512" }) });
	const bridge = new Bridge({ client, config: config() });
	await bridge.handle(job({ assetTag: "LAB-512" }), null, devices);
	assert.equal(client.calls.at(-1)[1], "failed");
	assert.match(client.calls.at(-1)[2].message, /host/);
});

test("a job for a device that is not connected fails before starting", async () => {
	const client = fakeClient({ job: job() });
	const bridge = new Bridge({ client, config: config() });
	await bridge.handle(job({ ecid: "0xDEAD" }), null, devices);
	assert.deepEqual(client.calls.map((c) => c[1]), ["failed"]);
});

test("if EmDash says the approval was withdrawn at start, nothing runs", async () => {
	const client = fakeClient({ job: job(), started: { proceed: false, status: "revoked", reason: "withdrawn" } });
	const bridge = new Bridge({ client, config: config(), validated: ["inventory"] });
	await bridge.handle(job(), null, devices);
	assert.deepEqual(client.calls.map((c) => c[1]), ["started"]);
});

test("destructive restores fail closed without a person at the terminal", async () => {
	const client = fakeClient({ job: job({ operation: "restore" }) });
	const cfg = config({ simulatedDevices: devices });
	const bridge = new Bridge({ client, config: cfg, validated: ["restore"] });
	bridge.config = { ...cfg, simulate: false };
	const stdinTTY = process.stdin.isTTY;
	process.stdin.isTTY = false;
	try {
		// Re-check of devices calls cfgutil; point it at a stub that prints the device.
		bridge.config.cfgutilPath = path.join(import.meta.dirname, "fixtures", "cfgutil-stub.mjs");
		await bridge.handle(job({ operation: "restore" }), null, devices);
	} finally {
		process.stdin.isTTY = stdinTTY;
	}
	const last = client.calls.at(-1);
	assert.equal(last[1], "failed");
	assert.match(last[2].message, /Local confirmation/);
	assert.ok(client.calls.some((c) => c[0] === "check"), "approval is re-checked before asking");
});
