// Mission 001 rules: simulation, verification, backups, inspections, approvals.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
	acceptanceChecklist,
	approvalViolations,
	assetProgress,
	deriveStatus,
	nextAction,
	normalizeEcid,
	normalizeSerial,
	osAccepted,
	verifyIdentity,
	type ApprovalInput,
} from "../src/recovery.ts";
import { at, attestation, goodObserved, iphone, job, mac } from "./helpers.ts";

const status = (asset = iphone(), jobs = [] as ReturnType<typeof job>[], evidence = [] as ReturnType<typeof attestation>[], degraded = false) =>
	deriveStatus(asset, assetProgress(asset, jobs, evidence), degraded);

const fullRecovery = (mode: "real" | "simulated" | "dry_run" = "real") => {
	const dry = mode === "dry_run";
	return [
		job({ operation: "inventory", finishedAt: at(1), result: { observed: goodObserved }, executionMode: mode, dryRun: dry }),
		job({ operation: "restore", finishedAt: at(3), executionMode: mode, dryRun: dry }),
		job({ operation: "verify", finishedAt: at(4), result: { observed: goodObserved }, executionMode: mode, dryRun: dry }),
	];
};
const attested = (after: number) => ["account_security", "activation_lock", "management_enrollment"].map((k) => attestation(k, at(after)));

// --- Simulation -------------------------------------------------------------------

test("simulated and dry-run executions never count as recovery, whatever the dryRun flag says", () => {
	for (const mode of ["simulated", "dry_run"] as const) {
		const jobs = fullRecovery(mode).map((j) => ({ ...j, dryRun: false })); // a lying flag must not matter
		const s = status(iphone(), jobs, attested(5));
		assert.notEqual(s.status, "verified", mode);
		assert.notEqual(s.status, "trusted", mode);
		assert.notEqual(s.status, "restored_unverified", mode);
		const p = assetProgress(iphone(), jobs, attested(5));
		assert.equal(p.restore, null, mode);
		assert.equal(p.verification, null, mode);
		assert.equal(acceptanceChecklist(iphone(), p, s, false).passed, false, mode);
	}
});

test("a simulated success does not clear an earlier real failure", () => {
	const jobs = [
		job({ operation: "backup", status: "failed", finishedAt: at(1) }),
		job({ operation: "backup", executionMode: "simulated", finishedAt: at(2) }),
	];
	assert.equal(status(iphone(), jobs).status, "blocked");
});

// --- Verification -------------------------------------------------------------------

test("identity verification is exact and fails closed", () => {
	const asset = iphone();
	assert.equal(verifyIdentity(asset, goodObserved).pass, true);
	assert.equal(verifyIdentity(asset, null).pass, false, "nothing observed");
	assert.equal(verifyIdentity(asset, { ...goodObserved, ecid: undefined }).pass, false, "missing ECID");
	assert.equal(verifyIdentity(asset, { ...goodObserved, serialNumber: undefined }).pass, false, "missing serial");
	assert.equal(verifyIdentity(asset, { ...goodObserved, serialNumber: "F2LXK0ABCD1" }).pass, false, "serial prefix");
	assert.equal(verifyIdentity(asset, { ...goodObserved, serialNumber: "F2LXK0ABCD123" }).pass, false, "serial superstring");
	assert.equal(verifyIdentity(asset, { ...goodObserved, ecid: "0x1A2B3C4D5E" }).pass, false, "ECID prefix");
	assert.equal(verifyIdentity({ ...asset, serialNumber: null }, goodObserved).pass, false, "nothing expected");
	assert.equal(verifyIdentity(asset, { ...goodObserved, osVersion: "17.6" }).pass, false, "OS below policy");
	assert.equal(verifyIdentity(asset, { ...goodObserved, osVersion: undefined }).pass, false, "OS not reported");
});

test("normalisation is explicit: ECID hex case/prefix/leading zeros, serial case and whitespace only", () => {
	assert.equal(normalizeEcid("0x001a2b"), normalizeEcid("1A2B"));
	assert.equal(normalizeEcid("1A2G"), null);
	assert.equal(normalizeSerial(" f2lxk0abcd12 "), "F2LXK0ABCD12");
	assert.equal(normalizeSerial("F2LX-K0AB"), null);
	assert.equal(osAccepted(">=18.0", "18.0.1").pass, true);
	assert.equal(osAccepted("15.1", "15.1.1").pass, false);
	assert.equal(osAccepted(null, "18.1").pass, false, "no policy is not a pass");
});

test("a Mac without a recorded ECID is identified by serial; a Mac with one must match it", () => {
	assert.equal(verifyIdentity(mac(), { serialNumber: "C07ZX1ABCD9Q", osVersion: "15.1" }).pass, true);
	assert.equal(verifyIdentity(mac({ ecid: "0xABCDEF" }), { serialNumber: "C07ZX1ABCD9Q", osVersion: "15.1" }).pass, false);
});

test("verification and attestations from before the latest restore do not count", () => {
	const jobs = [
		job({ operation: "inventory", finishedAt: at(1), result: { observed: goodObserved } }),
		job({ operation: "restore", finishedAt: at(2) }),
		job({ operation: "verify", finishedAt: at(3), result: { observed: goodObserved } }),
		job({ operation: "restore", finishedAt: at(6) }), // a second restore
	];
	const s = status(iphone(), jobs, attested(4));
	assert.equal(s.status, "restored_unverified");
	const p = assetProgress(iphone(), jobs, attested(4));
	assert.equal(p.verification, null);
	assert.equal(p.attestations.account_security, null);
});

test("the full sequence reaches verified, then trusted only after a later sign-off", () => {
	const jobs = fullRecovery();
	assert.equal(status(iphone(), jobs.slice(0, 2)).status, "restored_unverified");
	assert.equal(status(iphone(), jobs).status, "restored_unverified", "attestations still missing");
	assert.equal(status(iphone(), jobs, attested(5)).status, "verified");
	assert.equal(status(iphone(), jobs, [...attested(5), attestation("trust_signoff", at(4.5 as number))]).status, "verified", "sign-off before attestations");
	const trusted = status(iphone(), jobs, [...attested(5), attestation("trust_signoff", at(6))]);
	assert.equal(trusted.status, "trusted");
	const p = assetProgress(iphone(), jobs, [...attested(5), attestation("trust_signoff", at(6))]);
	assert.equal(acceptanceChecklist(iphone(), p, trusted, false).passed, true);
	assert.equal(acceptanceChecklist(iphone(), p, trusted, true).passed, false, "degraded audit blocks acceptance");
	assert.equal(status(iphone(), jobs, attested(5), true).status, "blocked", "degraded audit blocks verified");
});

test("a verification that does not match blocks the asset", () => {
	const jobs = [...fullRecovery().slice(0, 2), job({ operation: "verify", finishedAt: at(4), result: { observed: { ...goodObserved, serialNumber: "XXXXXXXXXXXX" } } })];
	assert.equal(status(iphone(), jobs, attested(5)).status, "blocked");
});

// --- Unknown outcomes -----------------------------------------------------------------

test("an interrupted job is an unknown outcome until a person resolves it, and then needs a fresh inventory", () => {
	const interrupted = job({ operation: "restore", status: "needs_inspection", finishedAt: at(3) });
	assert.equal(status(iphone(), [job({ result: { observed: goodObserved } }), interrupted]).status, "unknown_outcome");
	const next = nextAction(iphone(), status(iphone(), [interrupted]), assetProgress(iphone(), [interrupted], []), "LAB-512");
	assert.equal(next.procedureCode, "P-INSPECT");

	const resolved = { ...interrupted, inspection: { resolvedBy: "u1", resolvedAt: at(4), finding: "unknown" as const, note: "Device at setup screen" } };
	const p = assetProgress(iphone(), [job({ finishedAt: at(1), result: { observed: goodObserved } }), resolved], []);
	assert.equal(p.inventoryAfterInspection, false, "inventory from before the inspection does not count");
	const p2 = assetProgress(iphone(), [resolved, job({ finishedAt: at(5), result: { observed: goodObserved } })], []);
	assert.equal(p2.inventoryAfterInspection, true);
});

// --- Approvals ------------------------------------------------------------------------

function approval(over: Partial<ApprovalInput> = {}, op: Record<string, unknown> = {}): ApprovalInput {
	return {
		origin: "api",
		actor: { id: "u1", role: 50 },
		authorId: "u1",
		settings: { requireSecondPerson: false, destructiveMinRole: 50, hostAssetTag: "LAB-512" },
		op: {
			op_code: "OP-0100",
			operation: "restore",
			asset_tag: "IPHONE-13-RED",
			procedure_code: "P-IOS-RESTORE",
			mission_code: "M001",
			dry_run: false,
			parameters: {},
			data_decision: "backup_verified",
			backup_op_code: "OP-0050",
			...op,
		},
		asset: iphone(),
		procedure: { code: "P-IOS-RESTORE", operation: "restore", deviceClasses: ["iphone", "ipad"] },
		missionExists: true,
		jobsForAsset: [job({ result: { observed: goodObserved } })],
		evidenceForAsset: [],
		backupOp: { opCode: "OP-0050", status: "published", operation: "backup", assetTag: "IPHONE-13-RED", dataDecision: null },
		backupJobs: [job({ opCode: "OP-0050", operation: "backup", finishedAt: at(2) })],
		auditDegraded: false,
		...over,
	};
}

test("a well-formed destructive approval passes", () => {
	assert.deepEqual(approvalViolations(approval()), []);
});

test("AI, plugins and the scheduler can never approve", () => {
	for (const origin of ["mcp", "plugin", "scheduler", "system"]) assert.match(approvalViolations(approval({ origin }))[0] ?? "", /person/);
});

test("the backup decision belongs to the exact device and needs a real backup", () => {
	assert.ok(approvalViolations(approval({}, { data_decision: null })).some((v) => /data-preservation/.test(v)));
	assert.ok(approvalViolations(approval({}, { data_decision: "blocked" })).some((v) => /blocked/.test(v)));
	const otherDevice = approval({ backupOp: { opCode: "OP-0050", status: "published", operation: "backup", assetTag: "IPHONE-14-PURPLE", dataDecision: null } });
	assert.ok(approvalViolations(otherDevice).some((v) => /IPHONE-14-PURPLE/.test(v)));
	const simulatedBackup = approval({ backupJobs: [job({ operation: "backup", executionMode: "simulated" })] });
	assert.ok(approvalViolations(simulatedBackup).some((v) => /no real, successful backup/.test(v)));
	assert.ok(approvalViolations(approval({}, { data_decision: "backup_waived", rationale: "short" })).some((v) => /rationale/.test(v)));
	assert.deepEqual(approvalViolations(approval({}, { data_decision: "no_user_data", rationale: "Device was factory fresh and never signed in." })), []);
	// Macs get no automatic pass.
	const macRestore = approval(
		{ asset: mac(), procedure: { code: "P-MAC-RESTORE", operation: "mac_dfu_restore", deviceClasses: ["mac_apple_silicon"] }, jobsForAsset: [] },
		{ operation: "mac_dfu_restore", asset_tag: "LAB-8GB", procedure_code: "P-MAC-RESTORE", data_decision: null },
	);
	assert.ok(approvalViolations(macRestore).some((v) => /data-preservation/.test(v)));
});

test("one active job per asset; unknown outcomes and degraded audit block destructive approval", () => {
	const busy = approval({ jobsForAsset: [job({ status: "running", operation: "backup", opCode: "OP-0060" })] });
	assert.ok(approvalViolations(busy).some((v) => /active job/.test(v)));
	const unknown = approval({ jobsForAsset: [job({ status: "needs_inspection", operation: "restore", opCode: "OP-0061" })] });
	assert.ok(approvalViolations(unknown).some((v) => /unknown outcome/.test(v)));
	assert.ok(approvalViolations(approval({ auditDegraded: true })).some((v) => /degraded/.test(v)));
});

test("second-person approval fails closed when the author is unknown, and never blocks a single operator when off", () => {
	const on = { requireSecondPerson: true, destructiveMinRole: 50, hostAssetTag: "LAB-512" };
	assert.ok(approvalViolations(approval({ settings: on, authorId: null })).some((v) => /author is unknown/.test(v)));
	assert.ok(approvalViolations(approval({ settings: on })).some((v) => /cannot approve their own/.test(v)));
	assert.deepEqual(approvalViolations(approval({ settings: on, authorId: "u2" })), []);
	assert.deepEqual(approvalViolations(approval()), [], "off: the same person may author and approve");
});

test("the bridge never acts on the host; the host's own recovery is recorded, not executed", () => {
	const host = mac({ assetTag: "LAB-512", role: "trusted_host" });
	const restore = approval(
		{ asset: host, procedure: { code: "P-MAC-RESTORE", operation: "mac_dfu_restore", deviceClasses: ["mac_apple_silicon"] }, jobsForAsset: [] },
		{ operation: "mac_dfu_restore", asset_tag: "LAB-512", data_decision: "no_user_data", rationale: "LAB 512 was erased during bootstrap; nothing kept." },
	);
	assert.ok(approvalViolations(restore).some((v) => /recordOnly/.test(v)));
	assert.deepEqual(approvalViolations({ ...restore, op: { ...restore.op, parameters: { recordOnly: true } } }), []);
});

test("device classes are enforced: no iPhone tooling on a Mac, no Mac DFU on an iPhone, LAB 001 is never a target", () => {
	const wrong = approval({ asset: mac() }, { asset_tag: "LAB-8GB" });
	assert.ok(approvalViolations(wrong).some((v) => /not available for mac_apple_silicon/.test(v)));
	const comms = approval({ asset: mac({ assetTag: "LAB-001", deviceClass: "mac_intel", role: "comms_terminal" }) });
	assert.ok(approvalViolations(comms).some((v) => /communications terminal/.test(v)));
	const unknownParam = approval({}, { parameters: { shell: "rm -rf /" } });
	assert.ok(approvalViolations(unknownParam).some((v) => /Parameters not allowed/.test(v)));
});

test("LAB 001 stays out of scope; the host's next action is the independent bootstrap", () => {
	const comms = mac({ assetTag: "LAB-001", deviceClass: "mac_intel", role: "comms_terminal" });
	assert.equal(status(comms).status, "out_of_scope");
	const host = mac({ assetTag: "LAB-512", role: "trusted_host", serialNumber: null });
	const s = status(host);
	assert.equal(s.status, "unidentified");
	const n = nextAction(host, s, assetProgress(host, [], []), "LAB-512");
	assert.equal(n.procedureCode, "P-HOST-BOOTSTRAP");
	assert.ok(n.instructions.some((i) => /macOS 14 or later/.test(i)));
	assert.ok(n.instructions.some((i) => /LAB 001 .*cannot/.test(i)));
});
