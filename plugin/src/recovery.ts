/**
 * Mission 001 rules. Pure functions over plain data, shared by the publish
 * policy, the reconciliation task, the admin and the MCP tools.
 *
 * Invariants enforced here:
 * - Only `real` executions count. A dry run or a simulated run never satisfies a
 *   milestone, clears a failure, or makes a device verified or trusted.
 * - Verification fails closed: expected and observed identifiers must both exist
 *   and match exactly after explicit normalisation.
 * - Every milestone is bound to the latest real restore: verifications and
 *   attestations recorded before it do not count.
 * - A destructive operation needs its own data-preservation decision.
 * - An unknown outcome blocks the asset until a person inspects it, and a new
 *   destructive attempt then needs a fresh real inventory.
 */

import {
	ACTIVE_JOB_STATUSES,
	BACKUP_OPERATIONS,
	DATA_DECISIONS,
	type DataDecision,
	DEVICE_CLASSES,
	INVENTORY_OPERATIONS,
	type Job,
	type AssetStatus,
	operationSpec,
	RESTORE_OPERATIONS,
	ROLE,
	VERIFY_OPERATIONS,
} from "./model.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface AssetFacts {
	assetTag: string;
	title: string;
	deviceClass: string | null;
	role: string | null;
	ecid: string | null;
	serialNumber: string | null;
	/** Acceptance policy for the OS after restore, e.g. ">=18.0" or "15.1". Required for verification. */
	osPolicy: string | null;
	inMission: boolean;
}

export interface EvidenceFacts {
	id: string;
	evidenceType: string;
	attests: string | null;
	assetTag: string | null;
	opCode: string | null;
	jobId: string | null;
	createdAt: string;
	sha256: string | null;
	mediaId: string | null;
	digestVerified: boolean;
	signedBy: string | null;
}

export interface OperationFacts {
	opCode: string;
	status: string;
	operation: string;
	assetTag: string;
	dataDecision: string | null;
}

export const SECURITY_ATTESTATIONS = ["account_security", "activation_lock", "management_enrollment"] as const;

// ---------------------------------------------------------------------------
// Normalisation and identity
// ---------------------------------------------------------------------------

/** ECIDs: hexadecimal, case-insensitive, optional 0x prefix, leading zeros insignificant. */
export function normalizeEcid(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const v = value.trim().toUpperCase().replace(/^0X/, "");
	if (!/^[0-9A-F]+$/.test(v)) return null;
	const stripped = v.replace(/^0+/, "");
	return stripped || "0";
}

/** Serial numbers: alphanumeric, case-insensitive, surrounding whitespace ignored. Nothing else is altered. */
export function normalizeSerial(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const v = value.trim().toUpperCase();
	return /^[A-Z0-9]{8,20}$/.test(v) ? v : null;
}

function versionParts(v: string): number[] | null {
	const m = v.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
	return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

function compareVersions(a: number[], b: number[]): number {
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
	return 0;
}

/** OS acceptance: ">=X.Y[.Z]" (minimum) or an exact version. An empty policy fails: acceptance must be explicit. */
export function osAccepted(policy: string | null, observed: string | null): { pass: boolean; reason: string } {
	if (!observed) return { pass: false, reason: "No OS version was reported." };
	const obs = versionParts(observed);
	if (!obs) return { pass: false, reason: `Reported OS version "${observed}" is not a version number.` };
	const p = (policy ?? "").trim();
	if (!p) return { pass: false, reason: "No OS acceptance policy is set on the asset (for example >=18.0)." };
	if (p.startsWith(">=")) {
		const min = versionParts(p.slice(2));
		if (!min) return { pass: false, reason: `OS policy "${p}" is not valid.` };
		return compareVersions(obs, min) >= 0 ? { pass: true, reason: `OS ${observed} meets ${p}.` } : { pass: false, reason: `OS ${observed} is older than ${p}.` };
	}
	const exact = versionParts(p);
	if (!exact) return { pass: false, reason: `OS policy "${p}" is not valid.` };
	return compareVersions(obs, exact) === 0 ? { pass: true, reason: `OS ${observed} equals ${p}.` } : { pass: false, reason: `OS ${observed} is not ${p}.` };
}

export interface IdentityCheck {
	pass: boolean;
	checks: Array<{ field: "ecid" | "serialNumber" | "osVersion"; pass: boolean; expected: string | null; observed: string | null; reason: string }>;
}

/**
 * Which identifiers must be recorded. iPhones and iPads always report an ECID to
 * the bridge, so both are required. A Mac's ECID is only visible in DFU mode;
 * when it has not been recorded, a Mac is identified by its serial number alone.
 */
export function ecidRequired(asset: Pick<AssetFacts, "deviceClass" | "ecid">): boolean {
	return !(asset.deviceClass ?? "").startsWith("mac") || !!normalizeEcid(asset.ecid);
}

export function identityRecorded(asset: Pick<AssetFacts, "deviceClass" | "ecid" | "serialNumber">): boolean {
	return !!normalizeSerial(asset.serialNumber) && (!ecidRequired(asset) || !!normalizeEcid(asset.ecid));
}

/** Exact, fail-closed identity verification. */
export function verifyIdentity(asset: Pick<AssetFacts, "ecid" | "serialNumber" | "osPolicy" | "deviceClass">, observed: Record<string, unknown> | null): IdentityCheck {
	const obs = observed ?? {};
	const exE = normalizeEcid(asset.ecid);
	const obE = normalizeEcid(obs.ecid);
	const exS = normalizeSerial(asset.serialNumber);
	const obS = normalizeSerial(obs.serialNumber);
	const check = (field: "ecid" | "serialNumber", expected: string | null, seen: string | null) => {
		if (!expected) return { field, pass: false, expected, observed: seen, reason: "No expected value is recorded on the asset." };
		if (!seen) return { field, pass: false, expected, observed: seen, reason: "The device did not report this value." };
		return expected === seen
			? { field, pass: true, expected, observed: seen, reason: "Exact match." }
			: { field, pass: false, expected, observed: seen, reason: "Does not match the asset record." };
	};
	const osVersion = typeof obs.osVersion === "string" ? obs.osVersion : null;
	const os = osAccepted(asset.osPolicy, osVersion);
	const checks: IdentityCheck["checks"] = [
		ecidRequired(asset)
			? check("ecid", exE, obE)
			: { field: "ecid", pass: true, expected: null, observed: obE, reason: "Mac without a recorded ECID: identified by serial number." },
		check("serialNumber", exS, obS),
		{ field: "osVersion", pass: os.pass, expected: asset.osPolicy, observed: osVersion, reason: os.reason },
	];
	return { pass: checks.every((c) => c.pass), checks };
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

/** A job counts only if it really ran and succeeded. */
export function countsAsReal(job: Job): boolean {
	return job.status === "succeeded" && job.executionMode === "real" && !job.dryRun;
}

function when(job: Job): string {
	return job.finishedAt ?? job.updatedAt;
}

function latest(jobs: Job[]): Job | null {
	return [...jobs].sort((a, b) => when(b).localeCompare(when(a)))[0] ?? null;
}

export interface AssetProgress {
	inventory: Job | null;
	inventoryIdentityMatches: boolean;
	backup: Job | null;
	restore: Job | null;
	restoreFailedAfterSuccess: Job | null;
	verification: Job | null;
	verificationIdentity: IdentityCheck | null;
	failedVerificationAfterRestore: Job | null;
	attestations: Record<string, EvidenceFacts | null>;
	trustSignoff: EvidenceFacts | null;
	active: Job[];
	activeRestore: Job | null;
	activeVerify: Job | null;
	unresolvedInspection: Job | null;
	failedOutstanding: Job[];
	inventoryAfterInspection: boolean;
}

export function assetProgress(asset: AssetFacts, jobs: Job[], evidence: EvidenceFacts[]): AssetProgress {
	const mine = jobs.filter((j) => j.assetTag.toUpperCase() === asset.assetTag.toUpperCase());
	const real = mine.filter(countsAsReal);
	const realOf = (ops: ReadonlySet<string>, after?: string | null) => latest(real.filter((j) => ops.has(j.operation) && (!after || when(j) > after)));

	const restore = realOf(RESTORE_OPERATIONS);
	const restoreAt = restore ? when(restore) : null;
	const restoreFailedAfterSuccess = latest(
		mine.filter((j) => RESTORE_OPERATIONS.has(j.operation) && j.executionMode === "real" && j.status === "failed" && (!restoreAt || when(j) > restoreAt)),
	);

	const verifications = real.filter((j) => VERIFY_OPERATIONS.has(j.operation) && (!restoreAt || when(j) > restoreAt));
	const verification = restore ? latest(verifications) : null;
	const verificationIdentity = verification ? verifyIdentity(asset, (verification.result?.observed as Record<string, unknown>) ?? null) : null;
	const failedVerificationAfterRestore = restore
		? latest(
				mine.filter(
					(j) =>
						VERIFY_OPERATIONS.has(j.operation) &&
						j.executionMode === "real" &&
						when(j) > restoreAt! &&
						(j.status === "failed" || (j.status === "succeeded" && !verifyIdentity(asset, (j.result?.observed as Record<string, unknown>) ?? null).pass)),
				),
			)
		: null;

	const inventory = realOf(INVENTORY_OPERATIONS);
	const inventoryIdentityMatches = inventory
		? (() => {
				const check = verifyIdentity({ ...asset, osPolicy: null }, (inventory.result?.observed as Record<string, unknown>) ?? null);
				return check.checks.filter((c) => c.field !== "osVersion").every((c) => c.pass);
			})()
		: false;

	const myEvidence = evidence.filter((e) => e.assetTag?.toUpperCase() === asset.assetTag.toUpperCase());
	const afterRestore = (e: EvidenceFacts) => !!restoreAt && e.createdAt > restoreAt;
	const attestations: Record<string, EvidenceFacts | null> = {};
	for (const kind of SECURITY_ATTESTATIONS) {
		attestations[kind] =
			myEvidence.filter((e) => e.evidenceType === "attestation" && e.attests === kind && afterRestore(e)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ??
			null;
	}
	const verificationAt = verification ? when(verification) : null;
	const latestAttestationAt = Object.values(attestations).reduce<string | null>((m, e) => (e && (!m || e.createdAt > m) ? e.createdAt : m), null);
	const trustSignoff =
		myEvidence
			.filter(
				(e) =>
					e.evidenceType === "attestation" &&
					e.attests === "trust_signoff" &&
					!!verificationAt &&
					e.createdAt > verificationAt &&
					!!latestAttestationAt &&
					e.createdAt > latestAttestationAt,
			)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;

	const active = mine.filter((j) => (ACTIVE_JOB_STATUSES as readonly string[]).includes(j.status));
	const unresolvedInspection = latest(mine.filter((j) => j.status === "needs_inspection" && !j.inspection));
	const resolvedInspection = latest(mine.filter((j) => j.status === "needs_inspection" && j.inspection));
	const inventoryAfterInspection = resolvedInspection ? !!realOf(INVENTORY_OPERATIONS, resolvedInspection.inspection!.resolvedAt) : true;

	return {
		inventory,
		inventoryIdentityMatches,
		backup: realOf(BACKUP_OPERATIONS, restoreAt),
		restore,
		restoreFailedAfterSuccess,
		verification,
		verificationIdentity,
		failedVerificationAfterRestore,
		attestations,
		trustSignoff,
		active,
		activeRestore: active.find((j) => RESTORE_OPERATIONS.has(j.operation)) ?? null,
		activeVerify: active.find((j) => VERIFY_OPERATIONS.has(j.operation)) ?? null,
		unresolvedInspection,
		failedOutstanding: mine.filter(
			(j) =>
				(j.status === "failed" || j.status === "stalled") &&
				j.executionMode !== "simulated" &&
				!real.some((s) => s.operation === j.operation && when(s) > when(j)),
		),
		inventoryAfterInspection,
	};
}

// ---------------------------------------------------------------------------
// Derived status
// ---------------------------------------------------------------------------

export interface StatusResult {
	status: AssetStatus;
	reasons: string[];
	lastVerifiedAt: string | null;
}

export function deriveStatus(asset: AssetFacts, progress: AssetProgress, auditDegraded: boolean): StatusResult {
	const r = (status: AssetStatus, ...reasons: string[]): StatusResult => ({
		status,
		reasons,
		lastVerifiedAt: progress.verification && progress.verificationIdentity?.pass ? when(progress.verification) : null,
	});
	if (asset.role === "comms_terminal") return r("out_of_scope", "Communications terminal. Not a recovery target.");
	if (progress.unresolvedInspection) {
		return r("unknown_outcome", `${progress.unresolvedInspection.opCode} stopped mid-operation. Inspect the device and record the finding.`);
	}
	if (progress.activeRestore) {
		return progress.activeRestore.status === "approved"
			? r("restore_authorised", `${progress.activeRestore.opCode} is approved and waiting.`)
			: r("restoring", `${progress.activeRestore.opCode} is ${progress.activeRestore.status}.`);
	}
	if (progress.restoreFailedAfterSuccess && !progress.restore) return r("failed", `${progress.restoreFailedAfterSuccess.opCode} failed.`);
	if (progress.restore) {
		if (progress.restoreFailedAfterSuccess) return r("failed", `A later restore ${progress.restoreFailedAfterSuccess.opCode} failed.`);
		if (progress.activeVerify) return r("verification_in_progress", `${progress.activeVerify.opCode} is ${progress.activeVerify.status}.`);
		if (!progress.verification || !progress.verificationIdentity?.pass) {
			if (progress.failedVerificationAfterRestore) {
				return r("blocked", `Verification ${progress.failedVerificationAfterRestore.opCode} did not pass. Investigate before continuing.`);
			}
			return r("restored_unverified", "Restored. Not yet verified.");
		}
		const missing = SECURITY_ATTESTATIONS.filter((k) => !progress.attestations[k]);
		if (missing.length > 0) return r("restored_unverified", `Identity verified. Missing attestations after the restore: ${missing.join(", ")}.`);
		if (auditDegraded) return r("blocked", "The audit journal is degraded. Resolve it before the device can count as verified.");
		if (progress.trustSignoff) return r("trusted", "Verified, attested and signed off.");
		return r("verified", "Verified and attested. Awaiting a person's trust sign-off.");
	}
	if (progress.failedOutstanding.length > 0) {
		const f = progress.failedOutstanding[0]!;
		return r("blocked", `${f.opCode} (${f.operation}) is ${f.status}. Review it before continuing.`);
	}
	if (!identityRecorded(asset)) {
		return r("unidentified", "The device's identifiers are not recorded from a verified inventory.");
	}
	if (progress.inventory && progress.inventoryIdentityMatches && progress.inventoryAfterInspection) return r("recovery_ready", "Identity confirmed by inventory.");
	return r("identified", "Identifiers recorded; confirm them with a real inventory.");
}

// ---------------------------------------------------------------------------
// Approval rules
// ---------------------------------------------------------------------------

export interface ApprovalInput {
	origin: string;
	actor: { id: string; role: number } | null;
	authorId: string | null;
	settings: { requireSecondPerson: boolean; destructiveMinRole: number; hostAssetTag: string };
	op: Record<string, unknown>;
	asset: AssetFacts | null;
	procedure: { code: string; operation: string; deviceClasses: string[] } | null;
	missionExists: boolean;
	jobsForAsset: Job[];
	evidenceForAsset: EvidenceFacts[];
	backupOp: OperationFacts | null;
	backupJobs: Job[];
	auditDegraded: boolean;
}

const RATIONALE_MIN = 20;

export function approvalViolations(input: ApprovalInput): string[] {
	const v: string[] = [];
	const { op, asset, procedure, actor } = input;

	if (!["api", "visual-editor"].includes(input.origin) || !actor) {
		v.push(`Approval must come from a person in the EmDash admin, not from "${input.origin}".`);
		return v;
	}
	if (actor.role < ROLE.EDITOR) v.push("Only editors and administrators can approve recovery operations.");

	const spec = operationSpec(op.operation);
	if (!spec) {
		v.push(`Unknown operation "${String(op.operation)}".`);
		return v;
	}
	if (!asset) v.push(`Asset "${String(op.asset_tag)}" does not exist.`);
	if (!procedure) v.push(`Procedure "${String(op.procedure_code)}" does not exist.`);
	if (!input.missionExists) v.push(`Mission "${String(op.mission_code)}" does not exist.`);
	if (!asset || !procedure) return v;

	if (procedure.operation !== op.operation) v.push(`Procedure ${procedure.code} performs "${procedure.operation}", not "${String(op.operation)}".`);
	const deviceClass = asset.deviceClass ?? "";
	if (!(DEVICE_CLASSES as readonly string[]).includes(deviceClass)) v.push(`${asset.assetTag} has no device class recorded.`);
	else {
		if (!spec.deviceClasses.includes(deviceClass as never)) v.push(`"${String(op.operation)}" is not available for ${deviceClass} devices.`);
		if (procedure.deviceClasses.length > 0 && !procedure.deviceClasses.includes(deviceClass)) v.push(`Procedure ${procedure.code} does not apply to ${deviceClass}.`);
	}
	if (asset.role === "comms_terminal") v.push(`${asset.assetTag} is the communications terminal and is not a recovery target.`);
	if (!asset.inMission) v.push(`${asset.assetTag} is not in the scope of mission ${String(op.mission_code)}.`);

	const params = (op.parameters && typeof op.parameters === "object" ? op.parameters : {}) as Record<string, unknown>;
	const allowedParams = op.operation === "install_profile" ? ["profile"] : spec.adapter === "manual" ? ["recordOnly"] : [];
	const extra = Object.keys(params).filter((k) => !allowedParams.includes(k));
	if (extra.length > 0) v.push(`Parameters not allowed for ${String(op.operation)}: ${extra.join(", ")}.`);
	if (op.operation === "install_profile" && (typeof params.profile !== "string" || !/^[A-Za-z0-9._-]+\.mobileconfig$/.test(params.profile))) {
		v.push("install_profile needs parameters.profile: a .mobileconfig file name.");
	}

	const isHost = asset.assetTag.toUpperCase() === input.settings.hostAssetTag.toUpperCase();
	if (isHost) {
		if (spec.adapter === "bridge") v.push(`${asset.assetTag} hosts the bridge and EmDash. The bridge never operates on it.`);
		if (spec.destructive && params.recordOnly !== true) {
			v.push(`${asset.assetTag} is recovered outside the platform (P-HOST-BOOTSTRAP). Record that recovery with "recordOnly": true.`);
		}
	}

	const dryRun = op.dry_run === true;
	const destructive = spec.destructive && !dryRun;
	if (destructive && actor.role < input.settings.destructiveMinRole) v.push("Destructive operations need an administrator's approval.");

	if (input.settings.requireSecondPerson) {
		if (!input.authorId) v.push("Second-person approval is on, and the operation's author is unknown.");
		else if (input.authorId === actor.id) v.push("Second-person approval is on: the author cannot approve their own operation.");
	}

	if (spec.adapter === "bridge" && op.operation !== "inventory" && !normalizeEcid(asset.ecid)) {
		v.push(`${asset.assetTag} has no ECID recorded. Run an inventory and record the ECID first.`);
	}
	if (spec.adapter === "bridge" && !dryRun && op.operation !== "inventory" && !normalizeSerial(asset.serialNumber)) {
		v.push(`${asset.assetTag} has no serial number recorded.`);
	}

	const progress = assetProgress(asset, input.jobsForAsset, input.evidenceForAsset);
	const otherActive = progress.active.filter((j) => j.opCode !== op.op_code);
	if (otherActive.length > 0) v.push(`${asset.assetTag} already has an active job (${otherActive[0]!.opCode}, ${otherActive[0]!.status}).`);
	if (progress.active.some((j) => j.opCode === op.op_code && j.status !== "approved")) {
		v.push("This operation is already executing. Wait for it to finish.");
	}
	if (progress.unresolvedInspection) {
		v.push(`${progress.unresolvedInspection.opCode} has an unknown outcome. Inspect the device and record the finding first.`);
	}

	if (destructive) {
		if (input.auditDegraded) v.push("The audit journal is degraded. Destructive operations are refused until it is resolved.");
		if (!progress.inventoryAfterInspection) v.push("A real inventory is required after the last inspection before another destructive attempt.");
		const decision = op.data_decision as DataDecision | null;
		if (!decision || !(DATA_DECISIONS as readonly string[]).includes(decision)) {
			v.push("Record a data-preservation decision on this operation: backup verified, backup waived, or no user data.");
		} else if (decision === "blocked") {
			v.push("The data-preservation decision is 'blocked'. Resolve it before approving.");
		} else if (decision === "backup_verified") {
			const b = input.backupOp;
			if (!b) v.push("Set 'Backup operation' to the backup operation for this device.");
			else {
				if (b.assetTag.toUpperCase() !== asset.assetTag.toUpperCase()) v.push(`Backup ${b.opCode} is for ${b.assetTag}, not ${asset.assetTag}.`);
				if (!BACKUP_OPERATIONS.has(b.operation)) v.push(`${b.opCode} is not a backup operation.`);
				const ok = input.backupJobs.filter(countsAsReal);
				const lastRestore = progress.restore ? when(progress.restore) : null;
				if (!ok.some((j) => !lastRestore || when(j) > lastRestore)) v.push(`${b.opCode} has no real, successful backup since the last restore.`);
			}
		} else if (typeof op.rationale !== "string" || op.rationale.trim().length < RATIONALE_MIN) {
			v.push(`"${decision}" needs a written rationale of at least ${RATIONALE_MIN} characters.`);
		}
	}
	return v;
}

// ---------------------------------------------------------------------------
// Next physical action and acceptance
// ---------------------------------------------------------------------------

export interface NextAction {
	assetTag: string;
	status: AssetStatus;
	action: string;
	procedureCode: string | null;
	operator: boolean;
	instructions: string[];
	blocking: string | null;
	complete: boolean;
}

const MAC_DFU_HOST =
	"Use a second, trusted Mac running macOS 14 or later, connected directly with a USB-C data cable to the target Mac's DFU port. Finder shows Revive Mac and Restore Mac.";

export function nextAction(asset: AssetFacts, status: StatusResult, progress: AssetProgress, hostAssetTag: string): NextAction {
	const isMac = (asset.deviceClass ?? "").startsWith("mac");
	const isHost = asset.assetTag.toUpperCase() === hostAssetTag.toUpperCase();
	const a = (action: string, procedureCode: string | null, operator: boolean, instructions: string[], blocking: string | null = null, complete = false): NextAction => ({
		assetTag: asset.assetTag,
		status: status.status,
		action,
		procedureCode,
		operator,
		instructions,
		blocking,
		complete,
	});
	switch (status.status) {
		case "out_of_scope":
			return a("None. LAB 001 is the communications terminal.", null, false, [], null, true);
		case "unknown_outcome":
			return a("Inspect the device and record what happened.", "P-INSPECT", true, [
				"Look at the device: is it at a setup screen, in recovery mode, at the previous system, or unresponsive?",
				"Do not start another restore.",
				"Record the finding on the job (Mission 001 → job → Resolve inspection). A real inventory is required next.",
			], status.reasons[0] ?? null);
		case "restore_authorised":
		case "restoring":
		case "verification_in_progress":
			return a("Wait for the active job.", progress.active[0]?.procedureCode ?? null, true, ["Keep the device connected and powered."], status.reasons[0] ?? null);
		case "failed":
		case "blocked":
			return a("Review the failure before continuing.", null, true, status.reasons, status.reasons[0] ?? null);
		case "unidentified":
			if (isHost) {
				return a("Recover LAB 512 outside the platform, then record its identity.", "P-HOST-BOOTSTRAP", true, [
					"Try LAB 512's own macOS Recovery first (hold the power button at startup, choose Options).",
					`If DFU is needed: ${MAC_DFU_HOST} LAB 001 (Catalina, Intel) cannot do this.`,
					"Or use Apple-authorised service.",
					"Afterwards record serial number and ECID from About This Mac / System Information on the asset, and record the recovery with a manual operation marked recordOnly.",
				]);
			}
			return isMac
				? a("Record the Mac's identity.", "P-MAC-INVENTORY", true, [
						"On the Mac: Apple menu → System Settings → General → About: note the serial number.",
						`ECID: connect it in DFU mode to the DFU host (${MAC_DFU_HOST}) and read it from Apple Configurator, or leave the ECID empty if DFU is not used.`,
						"Enter both on the asset, then complete a manual inventory operation.",
					])
				: a("Run an inventory.", "P-INVENTORY", true, [
						"Connect the iPhone to the bridge host with a USB cable. Unlock it and tap Trust.",
						"Approve an inventory operation. Copy the reported serial number and ECID onto the asset.",
					]);
		case "identified":
			return a("Confirm identity with a real inventory.", isMac ? "P-MAC-INVENTORY" : "P-INVENTORY", true, ["Run the inventory with Dry run off."]);
		case "recovery_ready":
			return isMac
				? a("Decide on data, then restore the Mac.", isHost ? "P-HOST-BOOTSTRAP" : "P-MAC-RESTORE", true, [
						"Record the data-preservation decision on the restore operation.",
						"Try macOS Recovery first (P-MAC-RECOVERY). Use DFU restore only if Recovery cannot erase and reinstall.",
						MAC_DFU_HOST,
					])
				: a("Decide on data, then restore the iPhone.", "P-IOS-RESTORE", true, [
						"Back up with P-IOS-BACKUP, or record 'backup waived' / 'no user data' with a rationale on the restore operation.",
						"Do not restore an untrusted backup's settings, profiles or apps afterwards.",
					]);
		case "restored_unverified": {
			if (!progress.verification || !progress.verificationIdentity?.pass) {
				return a("Verify the restored device.", isMac ? "P-MAC-VERIFY" : "P-VERIFY", true, [
					isMac ? "Read serial number and macOS version in About This Mac and complete the manual verification." : "Connect the iPhone to the bridge host and approve a verify operation.",
				]);
			}
			const missing = SECURITY_ATTESTATIONS.filter((k) => !progress.attestations[k]);
			return a("Complete the security baseline and record attestations.", "P-ACCOUNT-SECURITY", true, [
				`Record attestations after the restore for: ${missing.join(", ")}.`,
				"Sign in with Powerfarm's own Apple Account, check Activation Lock belongs to it, and confirm there is no device management enrolment you do not recognise.",
			]);
		}
		case "verified":
			return a("Review the record and sign off trust.", null, true, ["An administrator records a 'trust_signoff' attestation."], "Needs a person's decision.");
		case "trusted":
			return a("Recovered and trusted.", null, false, [], null, true);
		default:
			return a("Review the asset.", null, true, status.reasons);
	}
}

export interface ChecklistItem {
	check: string;
	pass: boolean;
	detail?: string;
}

export function acceptanceChecklist(asset: AssetFacts, progress: AssetProgress, status: StatusResult, auditDegraded: boolean): { assetTag: string; passed: boolean; checks: ChecklistItem[] } {
	const id = progress.verificationIdentity;
	const checks: ChecklistItem[] = [
		{ check: "Identity recorded (serial number, and ECID where required)", pass: identityRecorded(asset) },
		{ check: "Real inventory confirmed the identity", pass: !!progress.inventory && progress.inventoryIdentityMatches },
		{ check: "Real erase and restore completed", pass: !!progress.restore },
		{ check: "Real verification after the latest restore", pass: !!progress.verification },
		{ check: "ECID matches exactly", pass: !!id?.checks.find((c) => c.field === "ecid")?.pass, detail: id?.checks.find((c) => c.field === "ecid")?.reason },
		{ check: "Serial number matches exactly", pass: !!id?.checks.find((c) => c.field === "serialNumber")?.pass, detail: id?.checks.find((c) => c.field === "serialNumber")?.reason },
		{ check: "OS meets the acceptance policy", pass: !!id?.checks.find((c) => c.field === "osVersion")?.pass, detail: id?.checks.find((c) => c.field === "osVersion")?.reason },
		...SECURITY_ATTESTATIONS.map((k) => ({ check: `Attestation after restore: ${k.replace(/_/g, " ")}`, pass: !!progress.attestations[k] })),
		{ check: "Evidence digests verified by the server", pass: !!progress.verification && progress.verification.evidence.length > 0 },
		{ check: "No active, failed or unresolved jobs", pass: progress.active.length === 0 && progress.failedOutstanding.length === 0 && !progress.unresolvedInspection },
		{ check: "Audit journal intact", pass: !auditDegraded },
		{ check: "Trust signed off by a person after verification", pass: !!progress.trustSignoff },
	];
	return { assetTag: asset.assetTag, passed: status.status === "trusted" && checks.every((c) => c.pass), checks };
}
