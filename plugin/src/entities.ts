/**
 * The 1.2 entity contract: classification, lifecycle, controls per lifecycle
 * stage, subject references and secret hygiene. Pure functions only; hooks,
 * routes and the blueprint runner call into this module.
 *
 * See docs/ONTOLOGY-V1.2.md. Everything here constrains what EmDash content may
 * become; nothing here stores state.
 */

import { type CollectionSlug, ROLE } from "./model.js";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export function classificationRank(value: unknown): number {
	const i = CLASSIFICATIONS.indexOf(value as Classification);
	return i < 0 ? -1 : i;
}

/** Minimum EmDash role that may see an entity of this classification at all. */
export const CLASSIFICATION_MIN_ROLE: Readonly<Record<Classification, number>> = {
	public: ROLE.SUBSCRIBER,
	internal: ROLE.CONTRIBUTOR,
	confidential: ROLE.EDITOR,
	restricted: ROLE.ADMIN,
};

export function isClassification(value: unknown): value is Classification {
	return classificationRank(value) >= 0;
}

/** The higher of two classifications (unknown values count as `internal`). */
export function maxClassification(a: unknown, b: unknown): Classification {
	const ra = isClassification(a) ? classificationRank(a) : 1;
	const rb = isClassification(b) ? classificationRank(b) : 1;
	return CLASSIFICATIONS[Math.max(ra, rb)]!;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export const LIFECYCLE = ["intake", "active", "suspended", "retired"] as const;
export type Lifecycle = (typeof LIFECYCLE)[number];
export type Stage = "intake" | "activation" | "operation" | "retirement";

/** Allowed published-lifecycle changes. `null` = never published. Retired is final. */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<Lifecycle | "none", readonly Lifecycle[]>> = {
	none: ["intake"],
	intake: ["intake", "active", "retired"],
	active: ["active", "suspended", "retired"],
	suspended: ["suspended", "active", "retired"],
	retired: [],
};

/** Which gate a published-lifecycle change must pass. */
export function stageFor(from: Lifecycle | null, to: Lifecycle): Stage | null {
	if (from === null) return "intake";
	if (to === "active" && from !== "active") return "activation";
	if (to === "retired" && from !== "retired") return "retirement";
	return null;
}

export function isLifecycle(value: unknown): value is Lifecycle {
	return LIFECYCLE.includes(value as Lifecycle);
}

// ---------------------------------------------------------------------------
// Entity types
// ---------------------------------------------------------------------------

export const ENTITY_COLLECTIONS = ["clients", "products", "services", "service_instances", "contracts", "organizations", "people", "agents"] as const;
export type EntityCollection = (typeof ENTITY_COLLECTIONS)[number];

export function isEntityCollection(value: string): value is EntityCollection {
	return (ENTITY_COLLECTIONS as readonly string[]).includes(value);
}

export interface EntityTypeSpec {
	collection: EntityCollection;
	nodeType: string;
	codePrefix: string;
	defaultClassification: Classification;
	/** Role needed to publish an activation (on top of EmDash's publish permission). */
	activationMinRole: number;
	/** Reference fields that point at other entities (for dependants and blueprints). */
	references: readonly string[];
}

export const ENTITY_TYPES: Readonly<Record<EntityCollection, EntityTypeSpec>> = {
	clients: { collection: "clients", nodeType: "client", codePrefix: "CL", defaultClassification: "internal", activationMinRole: ROLE.EDITOR, references: ["owner", "products", "projects", "contracts"] },
	products: { collection: "products", nodeType: "product", codePrefix: "PR", defaultClassification: "internal", activationMinRole: ROLE.EDITOR, references: ["owner", "services", "clients"] },
	services: { collection: "services", nodeType: "service", codePrefix: "SV", defaultClassification: "internal", activationMinRole: ROLE.EDITOR, references: ["owner", "software", "instances", "projects", "products"] },
	service_instances: { collection: "service_instances", nodeType: "service_instance", codePrefix: "SI", defaultClassification: "internal", activationMinRole: ROLE.EDITOR, references: ["owner", "service", "hosts", "projects"] },
	contracts: { collection: "contracts", nodeType: "contract", codePrefix: "CT", defaultClassification: "confidential", activationMinRole: ROLE.ADMIN, references: ["owner", "client", "products", "services"] },
	// 1.4 Powerfarm Identity: principals. A person's lifecycle reads intake = invited, retired = departed.
	organizations: { collection: "organizations", nodeType: "organization", codePrefix: "OR", defaultClassification: "internal", activationMinRole: ROLE.ADMIN, references: ["owner", "people", "services"] },
	people: { collection: "people", nodeType: "person", codePrefix: "PE", defaultClassification: "confidential", activationMinRole: ROLE.ADMIN, references: ["owner", "assets", "projects", "agents"] },
	agents: { collection: "agents", nodeType: "agent", codePrefix: "AG", defaultClassification: "internal", activationMinRole: ROLE.ADMIN, references: ["owner"] },
};

/** Code prefixes for the supporting collections whose codes the plugin allocates. */
export const CODE_PREFIXES: Readonly<Partial<Record<CollectionSlug, string>>> = {
	...Object.fromEntries(ENTITY_COLLECTIONS.map((c) => [c, ENTITY_TYPES[c].codePrefix])),
	work_items: "WI",
	exceptions: "EX",
	grants: "GR",
	policies: "PO",
};

// ---------------------------------------------------------------------------
// Subjects: `<collection>:<KEY>` links from work items, exceptions and evidence
// ---------------------------------------------------------------------------

export interface SubjectRef {
	collection: EntityCollection;
	key: string;
}

export function formatSubject(collection: string, key: string): string {
	return `${collection}:${key.trim().toUpperCase()}`;
}

export function parseSubject(value: unknown): SubjectRef | null {
	if (typeof value !== "string") return null;
	const m = /^([a-z_]+):([A-Za-z0-9._-]{1,64})$/.exec(value.trim());
	if (!m || !isEntityCollection(m[1]!)) return null;
	return { collection: m[1] as EntityCollection, key: m[2]!.toUpperCase() };
}

/** Journal stream for an entity. */
export function streamForEntity(collection: string, key: string): string {
	return `entity:${collection}:${key.toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

export type Pillar = "identity" | "authority" | "security" | "maintenance";

export interface ControlSpec {
	label: string;
	pillar: Pillar;
	/** Attestation kind (evidence `attests`) that satisfies it, if evidence-based. */
	attestation?: string;
	/** Role needed to record that attestation. */
	attestRole?: number;
	/** Attestation must be at most this old. */
	validDays?: number;
	/** May a security exception waive it? */
	waivable: boolean;
	/** The attestation must carry a server-verified file. */
	needsFile?: boolean;
}

export const CONTROLS = {
	owner_assigned: { label: "Accountable owner assigned", pillar: "authority", waivable: false },
	identity_recorded: { label: "At least one identifier claimed in the registry", pillar: "identity", waivable: true },
	identity_verified: { label: "Identity verified by a person", pillar: "identity", attestation: "identity_verified", attestRole: ROLE.EDITOR, waivable: true },
	classification_reviewed: { label: "Classification reviewed", pillar: "security", attestation: "classification_reviewed", attestRole: ROLE.EDITOR, validDays: 365, waivable: false },
	access_reviewed: { label: "Access reviewed by an administrator", pillar: "authority", attestation: "access_reviewed", attestRole: ROLE.ADMIN, validDays: 180, waivable: true },
	security_baseline: { label: "Security baseline reviewed", pillar: "security", attestation: "security_baseline_reviewed", attestRole: ROLE.EDITOR, validDays: 365, waivable: true },
	maintenance_plan: { label: "Review cadence set and maintenance plan recorded", pillar: "maintenance", attestation: "maintenance_plan", attestRole: ROLE.EDITOR, waivable: true },
	service_linked: { label: "Linked to its catalogue service", pillar: "identity", waivable: false },
	secrets_referenced: { label: "Credentials referenced, never stored", pillar: "security", waivable: false },
	counterparty_linked: { label: "Client (counterparty) linked", pillar: "identity", waivable: true },
	dates_recorded: { label: "Effective and end or renewal dates recorded", pillar: "maintenance", waivable: false },
	contract_signed: { label: "Signed copy attested by an administrator", pillar: "authority", attestation: "contract_signed", attestRole: ROLE.ADMIN, needsFile: true, waivable: false },
	review_current: { label: "Maintenance review within the cadence", pillar: "maintenance", attestation: "maintenance_review", attestRole: ROLE.EDITOR, waivable: true },
	renewal_not_due: { label: "Renewal and end dates not passed", pillar: "maintenance", waivable: true },
	retirement_approved: { label: "Retirement approved by an administrator", pillar: "authority", attestation: "retirement_approved", attestRole: ROLE.ADMIN, waivable: false },
	no_active_dependants: { label: "Nothing active depends on it", pillar: "maintenance", waivable: false },
} as const satisfies Record<string, ControlSpec>;

export type ControlId = keyof typeof CONTROLS;
export const CONTROL_IDS = Object.keys(CONTROLS) as ControlId[];

export function controlSpec(id: string): ControlSpec | null {
	return Object.hasOwn(CONTROLS, id) ? CONTROLS[id as ControlId] : null;
}

/** Attestation kinds that satisfy controls, with the role needed to record them. */
export const CONTROL_ATTESTATIONS: Readonly<Record<string, { control: ControlId; minRole: number; needsFile: boolean }>> = Object.fromEntries(
	(Object.entries(CONTROLS) as Array<[ControlId, ControlSpec]>)
		.filter(([, c]) => c.attestation)
		.map(([id, c]) => [c.attestation!, { control: id, minRole: c.attestRole ?? ROLE.EDITOR, needsFile: !!c.needsFile }]),
);

/** The facts a control evaluation needs about one entity. Built by controls.ts. */
export interface EntityFacts {
	collection: EntityCollection;
	key: string;
	title: string;
	createdAt: string | null;
	lifecycle: Lifecycle | null;
	classification: Classification | null;
	data: Record<string, unknown>;
	/** Effective reference selections by field (staged draft values over live ones), as translation groups. */
	references: Record<string, string[]>;
}

/** Which controls a stage requires for an entity. */
export function requiredControls(entity: EntityFacts, stage: Stage): ControlId[] {
	const sensitive = classificationRank(entity.classification) >= classificationRank("confidential");
	switch (stage) {
		case "intake":
			return [];
		case "activation":
			switch (entity.collection) {
				case "clients":
					return ["owner_assigned", "identity_recorded", "identity_verified", "classification_reviewed", ...(sensitive ? (["access_reviewed"] as const) : []), "maintenance_plan"];
				case "products":
					return ["owner_assigned", "classification_reviewed", "security_baseline", "maintenance_plan"];
				case "services":
					return ["owner_assigned", "classification_reviewed", "security_baseline", "maintenance_plan"];
				case "service_instances":
					return ["owner_assigned", "service_linked", "secrets_referenced", "security_baseline", "access_reviewed", "maintenance_plan"];
				case "contracts":
					return ["owner_assigned", "counterparty_linked", "classification_reviewed", "dates_recorded", "contract_signed"];
				case "organizations":
					return ["owner_assigned", "identity_recorded", "classification_reviewed"];
				case "people":
				case "agents":
					// A person belongs to an organisation and signs in with at least one registered identity; an agent has a responsible person and its own identity.
					return ["owner_assigned", "identity_recorded"];
			}
			return [];
		case "operation":
			return entity.collection === "contracts" ? ["review_current", "renewal_not_due"] : ["review_current"];
		case "retirement":
			return ["retirement_approved", "no_active_dependants"];
	}
}

// ---------------------------------------------------------------------------
// Secret hygiene
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
	[/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE|OPENSSH)/, "a PEM key or certificate"],
	[/\b(AKIA|ASIA)[0-9A-Z]{16}\b/, "an AWS access key"],
	[/\bgh[pousr]_[A-Za-z0-9]{30,}\b/, "a GitHub token"],
	[/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/, "a Slack token"],
	[/\bsk-[A-Za-z0-9_-]{20,}\b/, "an API secret key"],
	[/\bec_pat_[A-Za-z0-9_-]{10,}\b/, "an EmDash token"],
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a JWT"],
	[/\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*\S{6,}/i, "a credential assignment"],
	[/[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{3,}@/i, "a URL with an embedded password"],
];

/** Find a value that looks like a credential anywhere in a record. Returns a description, or null. */
export function findSecretLike(value: unknown, path = ""): string | null {
	if (typeof value === "string") {
		for (const [re, what] of SECRET_PATTERNS) if (re.test(value)) return `${path || "a field"} looks like it contains ${what}`;
		return null;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length && i < 200; i++) {
			const hit = findSecretLike(value[i], `${path}[${i}]`);
			if (hit) return hit;
		}
		return null;
	}
	if (value && typeof value === "object") {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			const hit = findSecretLike(v, path ? `${path}.${k}` : k);
			if (hit) return hit;
		}
	}
	return null;
}

export const SECRET_STORES = ["emdash_setting", "password_manager", "vault", "host_file"] as const;

export interface SecretRef {
	name: string;
	store: (typeof SECRET_STORES)[number];
	reference: string;
}

/** Validate `secret_refs`: where a credential lives, never the credential. */
export function parseSecretRefs(value: unknown): { refs: SecretRef[]; errors: string[] } {
	if (value === null || value === undefined || value === "") return { refs: [], errors: [] };
	if (!Array.isArray(value)) return { refs: [], errors: ["Secret references must be a list of {name, store, reference}."] };
	const errors: string[] = [];
	const refs: SecretRef[] = [];
	if (value.length > 30) errors.push("At most 30 secret references.");
	value.slice(0, 30).forEach((item, i) => {
		const r = item as Record<string, unknown> | null;
		if (!r || typeof r !== "object") return void errors.push(`Secret reference ${i + 1} is not an object.`);
		const extra = Object.keys(r).filter((k) => !["name", "store", "reference"].includes(k));
		if (extra.length) errors.push(`Secret reference ${i + 1} has unexpected fields (${extra.join(", ")}); only name, store and reference are allowed.`);
		const name = typeof r.name === "string" ? r.name.trim() : "";
		const store = r.store;
		const reference = typeof r.reference === "string" ? r.reference.trim() : "";
		if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) errors.push(`Secret reference ${i + 1}: name must be 1–64 letters, digits, dot, dash or underscore.`);
		if (!SECRET_STORES.includes(store as SecretRef["store"])) errors.push(`Secret reference ${i + 1}: store must be one of ${SECRET_STORES.join(", ")}.`);
		if (!/^[A-Za-z0-9_.:/#-]{1,200}$/.test(reference)) errors.push(`Secret reference ${i + 1}: reference must be a path or item name (letters, digits, . _ : / # -).`);
		else if (reference.length >= 24 && !/[/:#._-]/.test(reference)) {
			// A long run with no path separators is what a key or token looks like, not a location.
			errors.push(`Secret reference ${i + 1}: reference looks like a secret value, not a location.`);
		}
		if (errors.length === 0) refs.push({ name, store: store as SecretRef["store"], reference });
	});
	return { refs, errors };
}
