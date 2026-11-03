/**
 * Powerfarm Graph ontology.
 *
 * Node types are stable, typed and owned by EmDash: an EmDash collection, or one
 * of this plugin's EmDash storage collections. Node identity is
 * `<type>:<stable id>`, where the stable id of content is its EmDash
 * translation group (locale-independent) and the stable id of a storage record is
 * its storage key. Display names are never identifiers.
 *
 * The full ontology (institution, infrastructure, engineering, operations, AI,
 * research, Enterprise-of-One) is documented in docs/ONTOLOGY.md. Types marked
 * `planned` have no collection yet; they are reserved so future collections join
 * the same graph with the same identifiers and edge semantics.
 */

import type { CollectionSlug } from "./model.js";

export type Domain = "institution" | "infrastructure" | "engineering" | "operations" | "ai" | "research" | "enterprise" | "automation";

export interface NodeTypeSpec {
	domain: Domain;
	label: string;
	/** Where records of this type live. */
	source: { kind: "collection"; collection: CollectionSlug } | { kind: "storage"; storage: string } | { kind: "planned" };
	/** Minimum EmDash role to see nodes of this type at all. */
	minRole: number;
	/** Fields that identify hardware or people and are redacted unless the caller is privileged. */
	sensitiveFields?: readonly string[];
}

const SUB = 10;
const EDITOR = 40;

export const NODE_TYPES = {
	// Institution
	organization: { domain: "institution", label: "Organization", source: { kind: "collection", collection: "organizations" }, minRole: SUB },
	person: { domain: "institution", label: "Person", source: { kind: "collection", collection: "people" }, minRole: SUB },
	team: { domain: "institution", label: "Team", source: { kind: "planned" }, minRole: SUB },
	project: { domain: "institution", label: "Project", source: { kind: "collection", collection: "projects" }, minRole: SUB },
	mission: { domain: "institution", label: "Mission", source: { kind: "collection", collection: "missions" }, minRole: SUB },
	// Infrastructure
	asset: {
		domain: "infrastructure",
		label: "Asset",
		source: { kind: "collection", collection: "assets" },
		minRole: SUB,
		sensitiveFields: ["serial_number", "ecid"],
	},
	service: { domain: "infrastructure", label: "Service", source: { kind: "collection", collection: "services" }, minRole: SUB },
	service_instance: {
		domain: "infrastructure",
		label: "Service instance",
		source: { kind: "collection", collection: "service_instances" },
		minRole: SUB,
		sensitiveFields: ["endpoint"],
	},
	client: { domain: "enterprise", label: "Client", source: { kind: "collection", collection: "clients" }, minRole: SUB },
	product: { domain: "enterprise", label: "Product", source: { kind: "collection", collection: "products" }, minRole: SUB },
	contract: { domain: "enterprise", label: "Contract", source: { kind: "collection", collection: "contracts" }, minRole: EDITOR },
	blueprint: { domain: "automation", label: "Blueprint", source: { kind: "collection", collection: "blueprints" }, minRole: EDITOR },
	// Editors: work item titles name their subject, which may be confidential.
	work_item: { domain: "automation", label: "Work item", source: { kind: "collection", collection: "work_items" }, minRole: EDITOR },
	exception: { domain: "automation", label: "Security exception", source: { kind: "collection", collection: "exceptions" }, minRole: EDITOR },
	identifier: { domain: "enterprise", label: "Identifier", source: { kind: "collection", collection: "identifiers" }, minRole: EDITOR, sensitiveFields: ["value", "identifier", "title"] },
	vm: { domain: "infrastructure", label: "VM", source: { kind: "planned" }, minRole: SUB },
	network: { domain: "infrastructure", label: "Network", source: { kind: "planned" }, minRole: SUB },
	storage: { domain: "infrastructure", label: "Storage", source: { kind: "planned" }, minRole: SUB },
	// Engineering
	software: { domain: "engineering", label: "Software", source: { kind: "collection", collection: "software" }, minRole: SUB },
	requirement: { domain: "engineering", label: "Requirement", source: { kind: "collection", collection: "requirements" }, minRole: SUB },
	decision: { domain: "engineering", label: "Architecture decision", source: { kind: "collection", collection: "decisions" }, minRole: SUB },
	test: { domain: "engineering", label: "Test", source: { kind: "collection", collection: "tests" }, minRole: SUB },
	release: { domain: "engineering", label: "Release", source: { kind: "collection", collection: "releases" }, minRole: SUB },
	repository: { domain: "engineering", label: "Repository", source: { kind: "planned" }, minRole: SUB },
	deployment: { domain: "engineering", label: "Deployment", source: { kind: "planned" }, minRole: SUB },
	// Operations
	procedure: { domain: "operations", label: "Procedure", source: { kind: "collection", collection: "procedures" }, minRole: SUB },
	operation: { domain: "operations", label: "Recovery operation", source: { kind: "collection", collection: "recovery_operations" }, minRole: EDITOR },
	event: { domain: "operations", label: "Event", source: { kind: "collection", collection: "events" }, minRole: EDITOR },
	evidence: {
		domain: "operations",
		label: "Evidence",
		source: { kind: "collection", collection: "evidence" },
		minRole: EDITOR,
		sensitiveFields: ["media_id"],
	},
	job: {
		domain: "operations",
		label: "Recovery job",
		source: { kind: "storage", storage: "jobs" },
		minRole: EDITOR,
		sensitiveFields: ["ecid", "serialNumber", "leaseId"],
	},
	bridge: { domain: "operations", label: "Bridge instance", source: { kind: "storage", storage: "bridges" }, minRole: EDITOR },
	lease: { domain: "operations", label: "Lease", source: { kind: "storage", storage: "jobs" }, minRole: EDITOR },
	journal_event: { domain: "operations", label: "Journal event", source: { kind: "storage", storage: "journal" }, minRole: EDITOR },
	reconciliation: { domain: "operations", label: "Reconciliation record", source: { kind: "storage", storage: "reconciliations" }, minRole: EDITOR },
	// AI
	model: { domain: "ai", label: "Model", source: { kind: "planned" }, minRole: SUB },
	agent: { domain: "ai", label: "Agent", source: { kind: "collection", collection: "agents" }, minRole: SUB },
	grant: { domain: "automation", label: "Grant", source: { kind: "collection", collection: "grants" }, minRole: EDITOR },
	policy: { domain: "institution", label: "Policy", source: { kind: "collection", collection: "policies" }, minRole: SUB },
	tool: { domain: "ai", label: "Tool", source: { kind: "planned" }, minRole: SUB },
	mcp_capability: { domain: "ai", label: "MCP capability", source: { kind: "planned" }, minRole: SUB },
	skill: { domain: "ai", label: "Prompt or skill specification", source: { kind: "planned" }, minRole: SUB },
	evaluation: { domain: "ai", label: "Evaluation", source: { kind: "planned" }, minRole: SUB },
	// Research
	research: { domain: "research", label: "Research item", source: { kind: "collection", collection: "research" }, minRole: SUB },
	hypothesis: { domain: "research", label: "Hypothesis", source: { kind: "planned" }, minRole: SUB },
	experiment: { domain: "research", label: "Experiment", source: { kind: "planned" }, minRole: SUB },
	dataset: { domain: "research", label: "Dataset", source: { kind: "planned" }, minRole: SUB },
	source_doc: { domain: "research", label: "Source", source: { kind: "planned" }, minRole: SUB },
	publication: { domain: "research", label: "Publication", source: { kind: "planned" }, minRole: SUB },
	concept: { domain: "research", label: "Concept", source: { kind: "planned" }, minRole: SUB },
} as const satisfies Record<string, NodeTypeSpec>;

export type NodeType = keyof typeof NODE_TYPES;

const BY_COLLECTION = new Map<string, NodeType>(
	(Object.entries(NODE_TYPES) as Array<[NodeType, NodeTypeSpec]>)
		.filter(([, spec]) => spec.source.kind === "collection")
		.map(([type, spec]) => [(spec.source as { collection: string }).collection, type]),
);

export function nodeTypeOfCollection(collection: string): NodeType | null {
	return BY_COLLECTION.get(collection) ?? null;
}

export function collectionOfNodeType(type: string): CollectionSlug | null {
	const spec = (NODE_TYPES as Record<string, NodeTypeSpec>)[type];
	return spec?.source.kind === "collection" ? spec.source.collection : null;
}

/** Native EmDash relations in the seed, as typed graph edges. Parent → child. */
export const RELATION_EDGES: Readonly<Record<string, { type: string; label: string; inverse: string }>> = {
	missions_assets: { type: "scopes", label: "scopes", inverse: "in scope of" },
	missions_procedures: { type: "uses_procedure", label: "uses procedure", inverse: "used by mission" },
	missions_projects: { type: "part_of_programme", label: "includes project", inverse: "part of mission" },
	assets_software: { type: "runs", label: "runs", inverse: "installed on" },
	procedures_software: { type: "requires_tool", label: "requires tool", inverse: "required by" },
	research_assets: { type: "studies", label: "studies", inverse: "studied by" },
	research_procedures: { type: "informs", label: "informs", inverse: "informed by" },
	people_assets: { type: "custodian_of", label: "custodian of", inverse: "custodian" },
	projects_requirements: { type: "has_requirement", label: "has requirement", inverse: "requirement of" },
	requirements_decisions: { type: "decided_by", label: "decided by", inverse: "decides" },
	decisions_software: { type: "governs", label: "governs", inverse: "governed by" },
	tests_requirements: { type: "verifies", label: "verifies", inverse: "verified by" },
	tests_software: { type: "tests", label: "tests", inverse: "tested by" },
	releases_software: { type: "releases", label: "releases", inverse: "released in" },
	releases_tests: { type: "passed", label: "passed tests", inverse: "passed in release" },
	projects_software: { type: "builds", label: "builds", inverse: "built by" },
	people_projects: { type: "responsible_for", label: "responsible for", inverse: "responsible" },
	// 1.2 entities
	people_clients: { type: "owns", label: "owns", inverse: "owned by" },
	people_products: { type: "owns", label: "owns", inverse: "owned by" },
	people_services: { type: "owns", label: "owns", inverse: "owned by" },
	people_service_instances: { type: "owns", label: "owns", inverse: "owned by" },
	people_contracts: { type: "owns", label: "owns", inverse: "owned by" },
	people_work_items: { type: "assigned", label: "is assigned", inverse: "assigned to" },
	organizations_people: { type: "employs", label: "employs", inverse: "member of" },
	organizations_services: { type: "owns", label: "owns", inverse: "owned by" },
	people_organizations: { type: "owns", label: "owns", inverse: "owned by" },
	people_agents: { type: "responsible_for", label: "responsible for", inverse: "responsible" },
	clients_products: { type: "subscribes_to", label: "subscribes to", inverse: "used by client" },
	clients_projects: { type: "sponsors", label: "sponsors", inverse: "sponsored by" },
	clients_contracts: { type: "party_to", label: "party to", inverse: "with client" },
	products_services: { type: "uses_service", label: "uses service", inverse: "used by product" },
	services_software: { type: "implemented_by", label: "implemented by", inverse: "implements" },
	services_instances: { type: "has_instance", label: "has instance", inverse: "instance of" },
	service_instances_assets: { type: "runs_on", label: "runs on", inverse: "hosts" },
	projects_services: { type: "uses_service", label: "uses shared service", inverse: "used by project" },
	projects_service_instances: { type: "uses_instance", label: "uses instance", inverse: "used by project" },
	contracts_products: { type: "covers", label: "covers", inverse: "covered by" },
	contracts_services: { type: "covers", label: "covers", inverse: "covered by" },
};

/** Labels for link-field and storage-derived edges. */
export const DERIVED_EDGES: Readonly<Record<string, { label: string; inverse: string }>> = {
	targets: { label: "targets", inverse: "targeted by" },
	follows: { label: "follows procedure", inverse: "followed by" },
	part_of: { label: "part of", inverse: "includes" },
	relies_on_backup: { label: "relies on backup", inverse: "backup for" },
	about: { label: "about", inverse: "described by" },
	evidence_for: { label: "evidence for", inverse: "has evidence" },
	executes: { label: "executes", inverse: "executed by job" },
	acts_on: { label: "acts on", inverse: "acted on by job" },
	claimed_by: { label: "claimed by", inverse: "claimed" },
	holds_lease: { label: "holds lease", inverse: "lease of" },
	recorded: { label: "recorded", inverse: "recorded by" },
	reconciles: { label: "reconciles", inverse: "reconciled by" },
	produced: { label: "produced evidence", inverse: "produced by job" },
	// 1.2
	concerns: { label: "concerns", inverse: "has work item" },
	waives: { label: "waives a control on", inverse: "has exception" },
	identifies: { label: "identifies", inverse: "identified by" },
	uses_template: { label: "created by blueprint", inverse: "created work" },
	merged_into: { label: "merged into", inverse: "absorbed" },
	// 1.4
	granted_to: { label: "grants authority to", inverse: "holds grant" },
	delegated_by: { label: "delegated by", inverse: "delegated" },
};

/**
 * Relation-bound reference fields in the seed: which relation and side each
 * field edits. Used to read staged (proposed) selections from draft revisions.
 * Keep in sync with site/seed/seed.json (the seed test checks this).
 */
export const REFERENCE_FIELDS: Readonly<Record<string, { relation: string; side: "parent" | "child" }>> = {
	"missions.assets": { relation: "missions_assets", side: "parent" },
	"missions.procedures": { relation: "missions_procedures", side: "parent" },
	"missions.projects": { relation: "missions_projects", side: "parent" },
	"assets.software": { relation: "assets_software", side: "parent" },
	"assets.custodians": { relation: "people_assets", side: "child" },
	"assets.missions": { relation: "missions_assets", side: "child" },
	"procedures.software": { relation: "procedures_software", side: "parent" },
	"software.installed_on": { relation: "assets_software", side: "child" },
	"software.used_by": { relation: "procedures_software", side: "child" },
	"research.assets": { relation: "research_assets", side: "parent" },
	"research.procedures": { relation: "research_procedures", side: "parent" },
	"people.assets": { relation: "people_assets", side: "parent" },
	"people.projects": { relation: "people_projects", side: "parent" },
	"projects.requirements": { relation: "projects_requirements", side: "parent" },
	"projects.software": { relation: "projects_software", side: "parent" },
	"requirements.decisions": { relation: "requirements_decisions", side: "parent" },
	"decisions.software": { relation: "decisions_software", side: "parent" },
	"tests.requirements": { relation: "tests_requirements", side: "parent" },
	"tests.software": { relation: "tests_software", side: "parent" },
	"releases.software": { relation: "releases_software", side: "parent" },
	"releases.tests": { relation: "releases_tests", side: "parent" },
	// 1.2 entities
	"clients.owner": { relation: "people_clients", side: "child" },
	"clients.products": { relation: "clients_products", side: "parent" },
	"clients.projects": { relation: "clients_projects", side: "parent" },
	"clients.contracts": { relation: "clients_contracts", side: "parent" },
	"products.owner": { relation: "people_products", side: "child" },
	"products.services": { relation: "products_services", side: "parent" },
	"products.clients": { relation: "clients_products", side: "child" },
	"services.owner": { relation: "people_services", side: "child" },
	"services.software": { relation: "services_software", side: "parent" },
	"services.instances": { relation: "services_instances", side: "parent" },
	"services.projects": { relation: "projects_services", side: "child" },
	"services.products": { relation: "products_services", side: "child" },
	"service_instances.owner": { relation: "people_service_instances", side: "child" },
	"service_instances.service": { relation: "services_instances", side: "child" },
	"service_instances.hosts": { relation: "service_instances_assets", side: "parent" },
	"service_instances.projects": { relation: "projects_service_instances", side: "child" },
	"contracts.owner": { relation: "people_contracts", side: "child" },
	"contracts.client": { relation: "clients_contracts", side: "child" },
	"contracts.products": { relation: "contracts_products", side: "parent" },
	"contracts.services": { relation: "contracts_services", side: "parent" },
	"work_items.assignee": { relation: "people_work_items", side: "child" },
	"organizations.owner": { relation: "people_organizations", side: "child" },
	"organizations.people": { relation: "organizations_people", side: "parent" },
	"organizations.services": { relation: "organizations_services", side: "parent" },
	"people.owner": { relation: "organizations_people", side: "child" },
	"people.agents": { relation: "people_agents", side: "parent" },
	"agents.owner": { relation: "people_agents", side: "child" },
};

/** Relation slug → its two collections. Keep in sync with the seed. */
export const RELATION_ENDS: Readonly<Record<string, { parent: CollectionSlug; child: CollectionSlug }>> = {
	missions_assets: { parent: "missions", child: "assets" },
	missions_procedures: { parent: "missions", child: "procedures" },
	missions_projects: { parent: "missions", child: "projects" },
	assets_software: { parent: "assets", child: "software" },
	procedures_software: { parent: "procedures", child: "software" },
	research_assets: { parent: "research", child: "assets" },
	research_procedures: { parent: "research", child: "procedures" },
	people_assets: { parent: "people", child: "assets" },
	people_projects: { parent: "people", child: "projects" },
	projects_requirements: { parent: "projects", child: "requirements" },
	projects_software: { parent: "projects", child: "software" },
	requirements_decisions: { parent: "requirements", child: "decisions" },
	decisions_software: { parent: "decisions", child: "software" },
	tests_requirements: { parent: "tests", child: "requirements" },
	tests_software: { parent: "tests", child: "software" },
	releases_software: { parent: "releases", child: "software" },
	releases_tests: { parent: "releases", child: "tests" },
	people_clients: { parent: "people", child: "clients" },
	people_products: { parent: "people", child: "products" },
	people_services: { parent: "people", child: "services" },
	people_service_instances: { parent: "people", child: "service_instances" },
	people_contracts: { parent: "people", child: "contracts" },
	people_work_items: { parent: "people", child: "work_items" },
	organizations_people: { parent: "organizations", child: "people" },
	organizations_services: { parent: "organizations", child: "services" },
	people_organizations: { parent: "people", child: "organizations" },
	people_agents: { parent: "people", child: "agents" },
	clients_products: { parent: "clients", child: "products" },
	clients_projects: { parent: "clients", child: "projects" },
	clients_contracts: { parent: "clients", child: "contracts" },
	products_services: { parent: "products", child: "services" },
	services_software: { parent: "services", child: "software" },
	services_instances: { parent: "services", child: "service_instances" },
	service_instances_assets: { parent: "service_instances", child: "assets" },
	projects_services: { parent: "projects", child: "services" },
	projects_service_instances: { parent: "projects", child: "service_instances" },
	contracts_products: { parent: "contracts", child: "products" },
	contracts_services: { parent: "contracts", child: "services" },
};

/**
 * Field of `collection` that holds the given relation end, if any. Inverse of
 * REFERENCE_FIELDS; used to turn live relation edges into per-field selections.
 */
export function referenceFieldFor(collection: string, relation: string, side: "parent" | "child"): string | null {
	for (const [name, spec] of Object.entries(REFERENCE_FIELDS)) {
		const dot = name.indexOf(".");
		if (name.slice(0, dot) === collection && spec.relation === relation && spec.side === side) return name.slice(dot + 1);
	}
	return null;
}
