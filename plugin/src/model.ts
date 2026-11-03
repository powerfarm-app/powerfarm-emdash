/**
 * The Powerfarm content model as the plugin sees it.
 *
 * The collections themselves are defined in the site seed (`site/seed/seed.json`)
 * and live in EmDash's schema registry. This file names them and records what
 * EmDash's schema cannot express:
 *
 * 1. Business keys: the field each collection is addressed by (`LAB-512`, `P-VERIFY`).
 *    They are stable identifiers chosen by people; display names never are.
 * 2. Link fields: string fields holding another entry's business key, used only on
 *    operational records the plugin and the bridge write (operations, events,
 *    evidence). EmDash's plugin context and its MCP content tools cannot set
 *    relation-bound reference fields, so these records cannot use native
 *    relations. Knowledge relationships (mission scope, software, research,
 *    custodians, engineering) use EmDash's native relations and are not duplicated.
 *    See docs/ARCHITECTURE.md, "Why link fields remain".
 * 3. The operation registry: which operation runs through which adapter for which
 *    device class, and how dangerous it is.
 */

export const PLUGIN_ID = "powerfarm";
export const PLUGIN_VERSION = "1.4.1";
/** Content model the plugin expects; status reports what an installation is missing (docs/ONTOLOGY-V1.2.md, migration). */
export const SCHEMA_VERSION = "1.3.0";

export const COLLECTIONS = {
	missions: { key: "code", label: "Mission" },
	assets: { key: "asset_tag", label: "Asset" },
	procedures: { key: "code", label: "Procedure" },
	recovery_operations: { key: "op_code", label: "Recovery operation" },
	events: { key: "journal_id", label: "Event" },
	evidence: { key: null, label: "Evidence" },
	software: { key: null, label: "Software" },
	research: { key: null, label: "Research" },
	people: { key: "code", label: "Person" },
	projects: { key: "code", label: "Project" },
	requirements: { key: "code", label: "Requirement" },
	decisions: { key: "code", label: "Architecture decision" },
	tests: { key: "code", label: "Test" },
	releases: { key: "code", label: "Release" },
	// 1.2 entities and automation (docs/ONTOLOGY-V1.2.md)
	clients: { key: "code", label: "Client" },
	products: { key: "code", label: "Product" },
	services: { key: "code", label: "Service" },
	service_instances: { key: "code", label: "Service instance" },
	contracts: { key: "code", label: "Contract" },
	blueprints: { key: "code", label: "Blueprint" },
	work_items: { key: "code", label: "Work item" },
	exceptions: { key: "code", label: "Security exception" },
	identifiers: { key: "identifier", label: "Identifier" },
	// 1.3 Powerfarm MDM
	incidents: { key: null, label: "Incident" },
	mdm_profiles: { key: "identifier", label: "Device profile" },
	// 1.4 Powerfarm Identity
	organizations: { key: "code", label: "Organisation" },
	agents: { key: "code", label: "Agent" },
	grants: { key: "code", label: "Grant" },
	policies: { key: "code", label: "Policy" },
} as const satisfies Record<string, { key: string | null; label: string }>;

export type CollectionSlug = keyof typeof COLLECTIONS;
export const COLLECTION_SLUGS = Object.keys(COLLECTIONS) as CollectionSlug[];

export function isPowerfarmCollection(value: string): value is CollectionSlug {
	return Object.hasOwn(COLLECTIONS, value);
}

export interface LinkField {
	collection: CollectionSlug;
	field: string;
	target: CollectionSlug;
	/** Edge type in the ontology (see ontology.ts). */
	edge: string;
	/** Must the target exist when the entry is created? */
	required: boolean;
}

export const LINK_FIELDS: readonly LinkField[] = [
	{ collection: "recovery_operations", field: "asset_tag", target: "assets", edge: "targets", required: true },
	{ collection: "recovery_operations", field: "procedure_code", target: "procedures", edge: "follows", required: true },
	{ collection: "recovery_operations", field: "mission_code", target: "missions", edge: "part_of", required: true },
	{ collection: "recovery_operations", field: "backup_op_code", target: "recovery_operations", edge: "relies_on_backup", required: false },
	{ collection: "events", field: "asset_tag", target: "assets", edge: "about", required: false },
	{ collection: "events", field: "op_code", target: "recovery_operations", edge: "about", required: false },
	{ collection: "evidence", field: "asset_tag", target: "assets", edge: "evidence_for", required: false },
	{ collection: "evidence", field: "op_code", target: "recovery_operations", edge: "evidence_for", required: false },
	{ collection: "work_items", field: "blueprint_code", target: "blueprints", edge: "uses_template", required: false },
	// 1.2: a merged duplicate points at the record that absorbed it.
	...(["clients", "products", "services", "service_instances", "contracts"] as const).map((c) => ({ collection: c, field: "merged_into", target: c, edge: "merged_into", required: false })),
];

/**
 * Polymorphic subject links (1.2): `<entity collection>:<KEY>` strings that point
 * at one entity of any entity type. Validated on save; shown as graph edges.
 */
export const SUBJECT_LINKS: ReadonlyArray<{ collection: CollectionSlug; field: string; edge: string }> = [
	{ collection: "work_items", field: "subject", edge: "concerns" },
	{ collection: "exceptions", field: "subject", edge: "waives" },
	{ collection: "evidence", field: "subject", edge: "evidence_for" },
	{ collection: "identifiers", field: "subject", edge: "identifies" },
	{ collection: "grants", field: "principal", edge: "granted_to" },
	{ collection: "grants", field: "delegated_by", edge: "delegated_by" },
];

// ---------------------------------------------------------------------------
// Devices and operations
// ---------------------------------------------------------------------------

export const DEVICE_CLASSES = ["mac_apple_silicon", "mac_intel", "iphone", "ipad"] as const;
export type DeviceClass = (typeof DEVICE_CLASSES)[number];

/**
 * How an operation is executed.
 * - `bridge`: the Apple Hardware Bridge runs it, but only if the bridge reports the
 *   operation as validated on its host (see bridge/src/adapters).
 * - `manual`: a person does it (Finder DFU, macOS Recovery, setup screens); the
 *   approval and the outcome are recorded in EmDash.
 */
export type ExecutionAdapter = "bridge" | "manual";

export type OperationClass = "read" | "preserve" | "repair" | "destructive" | "attest";

export interface OperationSpec {
	class: OperationClass;
	adapter: ExecutionAdapter;
	deviceClasses: readonly DeviceClass[];
	/** May the bridge run it in a dry run? Only read-only operations execute in dry runs. */
	readOnly: boolean;
	/** Destroys data or replaces the system. */
	destructive: boolean;
	/** Evidence kinds a successful run must leave behind. */
	requiredEvidence: readonly string[];
}

const IOS: readonly DeviceClass[] = ["iphone", "ipad"];
const APPLE_SILICON_MAC: readonly DeviceClass[] = ["mac_apple_silicon"];
const ANY: readonly DeviceClass[] = DEVICE_CLASSES;

/**
 * Every operation the platform knows. Mac DFU revive/restore and macOS Recovery
 * are manual: Apple documents them as Finder actions on a second Mac running
 * macOS 14 or later, and no automated route has been validated.
 */
export const OPERATIONS = {
	inventory: { class: "read", adapter: "bridge", deviceClasses: IOS, readOnly: true, destructive: false, requiredEvidence: ["inventory_report"] },
	verify: { class: "read", adapter: "bridge", deviceClasses: IOS, readOnly: true, destructive: false, requiredEvidence: ["verification_report"] },
	backup: { class: "preserve", adapter: "bridge", deviceClasses: IOS, readOnly: false, destructive: false, requiredEvidence: ["backup_manifest"] },
	restore: { class: "destructive", adapter: "bridge", deviceClasses: IOS, readOnly: false, destructive: true, requiredEvidence: ["restore_log"] },
	install_profile: { class: "repair", adapter: "bridge", deviceClasses: IOS, readOnly: false, destructive: false, requiredEvidence: ["install_log"] },
	mac_inventory_manual: { class: "read", adapter: "manual", deviceClasses: ["mac_apple_silicon", "mac_intel"], readOnly: true, destructive: false, requiredEvidence: ["inventory_report"] },
	mac_recovery_reinstall: { class: "destructive", adapter: "manual", deviceClasses: APPLE_SILICON_MAC, readOnly: false, destructive: true, requiredEvidence: ["attestation"] },
	mac_dfu_revive: { class: "repair", adapter: "manual", deviceClasses: APPLE_SILICON_MAC, readOnly: false, destructive: false, requiredEvidence: ["attestation"] },
	mac_dfu_restore: { class: "destructive", adapter: "manual", deviceClasses: APPLE_SILICON_MAC, readOnly: false, destructive: true, requiredEvidence: ["attestation"] },
	mac_verify_manual: { class: "read", adapter: "manual", deviceClasses: ["mac_apple_silicon", "mac_intel"], readOnly: true, destructive: false, requiredEvidence: ["verification_report"] },
	backup_manual: { class: "preserve", adapter: "manual", deviceClasses: ANY, readOnly: false, destructive: false, requiredEvidence: ["backup_manifest"] },
	security_baseline: { class: "attest", adapter: "manual", deviceClasses: ANY, readOnly: false, destructive: false, requiredEvidence: ["attestation"] },
} as const satisfies Record<string, OperationSpec>;

export type OperationName = keyof typeof OPERATIONS;
export const OPERATION_NAMES = Object.keys(OPERATIONS) as OperationName[];
export const BRIDGE_OPERATIONS = OPERATION_NAMES.filter((n) => OPERATIONS[n].adapter === "bridge");

export function operationSpec(name: unknown): OperationSpec | null {
	return typeof name === "string" && Object.hasOwn(OPERATIONS, name) ? OPERATIONS[name as OperationName] : null;
}

export function isBridgeOperation(name: unknown): boolean {
	return operationSpec(name)?.adapter === "bridge";
}

/** Operations whose success counts as "the device was restored". */
export const RESTORE_OPERATIONS: ReadonlySet<string> = new Set(["restore", "mac_recovery_reinstall", "mac_dfu_restore"]);
/** Operations whose success counts as "the restored device was verified". */
export const VERIFY_OPERATIONS: ReadonlySet<string> = new Set(["verify", "mac_verify_manual"]);
export const BACKUP_OPERATIONS: ReadonlySet<string> = new Set(["backup", "backup_manual"]);
export const INVENTORY_OPERATIONS: ReadonlySet<string> = new Set(["inventory", "mac_inventory_manual"]);

/** Data-preservation decision a destructive operation must carry. */
export const DATA_DECISIONS = ["backup_verified", "backup_waived", "no_user_data", "blocked"] as const;
export type DataDecision = (typeof DATA_DECISIONS)[number];

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/** EmDash role levels (packages/auth/src/types.ts). */
export const ROLE = { SUBSCRIBER: 10, CONTRIBUTOR: 20, AUTHOR: 30, EDITOR: 40, ADMIN: 50 } as const;

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const JOB_STATUSES = [
	"approved",
	"claimed",
	"running",
	"succeeded",
	"failed",
	"revoked",
	"stalled",
	"needs_inspection",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const ACTIVE_JOB_STATUSES: readonly JobStatus[] = ["approved", "claimed", "running"];
/** Terminal for automation. `needs_inspection` additionally keeps the asset locked until a person resolves it. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ["succeeded", "failed", "revoked", "stalled", "needs_inspection"];

/** Allowed job transitions. Nothing moves a job backwards, and nothing retries an unknown outcome. */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
	approved: ["claimed", "revoked"],
	claimed: ["running", "failed", "revoked", "stalled"],
	running: ["running", "succeeded", "failed", "needs_inspection"],
	succeeded: [],
	failed: [],
	revoked: [],
	stalled: [],
	needs_inspection: [],
};

/**
 * `real`: the operation ran on the device. `dry_run`: an approved dry run; only
 * read-only operations execute. `simulated`: a bridge in simulation mode; nothing
 * touched any device. Only `real` successes count towards recovery.
 */
export const EXECUTION_MODES = ["real", "dry_run", "simulated"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export interface Job {
	/** `${opId}:${opRevision}`: one job per approved revision. */
	id: string;
	opId: string;
	opCode: string;
	/** The exact EmDash revision that was published (approved). Never null. */
	opRevision: string;
	missionCode: string | null;
	assetTag: string;
	deviceClass: string;
	ecid: string | null;
	serialNumber: string | null;
	procedureCode: string;
	operation: OperationName;
	operationClass: OperationClass;
	destructive: boolean;
	parameters: Record<string, unknown>;
	dryRun: boolean;
	dataDecision: DataDecision | null;
	requiredEvidence: string[];
	status: JobStatus;
	authorId: string | null;
	approvedBy: string;
	approvedAt: string;
	claimedBy: string | null;
	claimedAt: string | null;
	/** Random token issued at claim; every report must present it. */
	leaseId: string | null;
	leaseExpiresAt: string | null;
	/** Set at claim from the bridge's declared mode, and forced for dry runs. */
	executionMode: ExecutionMode | null;
	startedAt: string | null;
	finishedAt: string | null;
	updatedAt: string;
	lastMessage: string | null;
	result: Record<string, unknown> | null;
	/** Media-backed evidence recorded for this job, by kind. */
	evidence: Array<{ kind: string; evidenceId: string; mediaId: string | null; sha256: string }>;
	/** A journal append failed for one of this job's transitions. */
	auditGap: boolean;
	/** Set when a person resolves a needs_inspection job. */
	inspection: { resolvedBy: string; resolvedAt: string; finding: "not_executed" | "executed" | "unknown"; note: string } | null;
}

// ---------------------------------------------------------------------------
// Derived asset status
// ---------------------------------------------------------------------------

/**
 * Asset status is derived from jobs, evidence and the journal. It is never an
 * editable field, so nobody (and no AI client) can mark a device trusted by
 * editing a record.
 */
export const ASSET_STATUSES = [
	"out_of_scope",
	"unidentified",
	"identified",
	"recovery_ready",
	"restore_authorised",
	"restoring",
	"restored_unverified",
	"verification_in_progress",
	"verified",
	"trusted",
	"blocked",
	"unknown_outcome",
	"failed",
] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const SETTINGS = {
	bridgeId: "bridgeId",
	bridgeSecret: "bridgeSecret",
	bridgeSecretNext: "bridgeSecretNext",
	bridgeEnabled: "bridgeEnabled",
	hostAssetTag: "hostAssetTag",
	requireSecondPerson: "requireSecondPerson",
	destructiveMinRole: "destructiveMinRole",
	claimLeaseMinutes: "claimLeaseMinutes",
	maxArtifactMegabytes: "maxArtifactMegabytes",
	tokenMaxClassification: "tokenMaxClassification",
} as const;

export const DEFAULTS = {
	hostAssetTag: "LAB-512",
	requireSecondPerson: false,
	destructiveMinRole: ROLE.ADMIN,
	claimLeaseMinutes: 20,
	bridgeEnabled: true,
	maxArtifactMegabytes: 8,
	tokenMaxClassification: "internal",
} as const;

export const MISSION_001 = "M001";
