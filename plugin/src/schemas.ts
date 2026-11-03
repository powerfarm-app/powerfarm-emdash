/**
 * Input schemas for private routes, MCP tools and the bridge. Bounded sizes everywhere.
 */

import { z } from "astro/zod";

import { CONTROL_IDS, ENTITY_COLLECTIONS } from "./entities.js";
import { COLLECTION_SLUGS, DATA_DECISIONS } from "./model.js";
import { NODE_TYPES } from "./ontology.js";

const nodeType = z.enum(Object.keys(NODE_TYPES) as [string, ...string[]]);
const entityCollection = z.enum(ENTITY_COLLECTIONS as unknown as [string, ...string[]]);
const identifier = z.object({
	namespace: z.string().trim().min(2).max(45).describe("vat, lei, duns, company_reg, domain, email_domain, github, or ext:<issuer>."),
	value: z.string().trim().min(1).max(120),
});
const ref = z.string().trim().min(1).max(200);
const flags = {
	includeDrafts: z.boolean().default(false).describe("Editors only: include unpublished drafts and proposed relationships."),
	revealIdentifiers: z.boolean().default(false).describe("Administrators only: show full serial numbers and ECIDs."),
};

export const S = {
	none: z.object({}),
	flags: z.object(flags),
	nodeRef: z.object({
		node: ref.describe("A node id such as asset:<group>, or a key such as LAB-8GB, OP-0007, P-VERIFY."),
		type: nodeType.optional().describe("Node type, needed when `node` is a key (asset, operation, procedure, mission, …)."),
		...flags,
	}),
	search: z.object({
		query: z.string().trim().min(1).max(200),
		types: z.array(nodeType).max(20).optional(),
		limit: z.number().int().min(1).max(50).default(20),
		...flags,
	}),
	neighbours: z.object({
		node: ref,
		type: nodeType.optional(),
		direction: z.enum(["out", "in", "both"]).default("both"),
		edgeTypes: z.array(z.string().max(60)).max(20).optional(),
		nodeTypes: z.array(nodeType).max(20).optional(),
		states: z.array(z.enum(["published", "draft", "proposed", "historical"])).max(4).optional(),
		limit: z.number().int().min(1).max(200).default(50),
		cursor: z.string().max(200).optional(),
		...flags,
	}),
	trace: z.object({
		node: ref,
		type: nodeType.optional(),
		depth: z.number().int().min(1).max(4).default(2),
		direction: z.enum(["out", "in", "both"]).default("out"),
		edgeTypes: z.array(z.string().max(60)).max(20).optional(),
		nodeTypes: z.array(nodeType).max(20).optional(),
		maxNodes: z.number().int().min(1).max(300).default(100),
		...flags,
	}),
	knowledge: z.object({
		query: z.string().trim().min(1).max(300),
		types: z.array(nodeType).max(20).optional(),
		limit: z.number().int().min(1).max(20).default(8),
		...flags,
	}),
	asset: z.object({ assetTag: z.string().trim().min(1).max(64).describe("Asset tag, for example LAB-8GB or IPHONE-13-RED."), revealIdentifiers: flags.revealIdentifiers }),
	procedure: z.object({ code: z.string().trim().min(1).max(64) }),
	evidence: z.object({
		assetTag: z.string().trim().max(64).optional(),
		opCode: z.string().trim().max(64).optional(),
		evidenceId: z.string().trim().max(200).optional(),
		revealIdentifiers: flags.revealIdentifiers,
	}),
	panel: z.object({ id: ref, ...flags }),
	columns: z.object({ collection: z.enum(["assets", "recovery_operations", "procedures"]), ids: z.array(z.string().max(100)).max(100) }),
	list: z.object({ limit: z.number().int().min(1).max(200).default(100), ...flags }),
	prepare: z.object({
		assetTag: z.string().trim().min(1).max(64),
		procedureCode: z.string().trim().min(1).max(64),
		rationale: z.string().trim().min(20).max(4000).describe("Why this operation, why now, and what was checked."),
		parameters: z.record(z.string().max(40), z.union([z.string().max(200), z.boolean(), z.number()])).optional(),
		dryRun: z.boolean().default(true),
		dataDecision: z.enum(DATA_DECISIONS).optional(),
		backupOpCode: z.string().trim().max(32).optional(),
		missionCode: z.string().trim().max(32).default("M001"),
	}),
	propose: z.object({
		collection: z.enum(["research", "requirements", "decisions", "procedures", "tests"]),
		data: z.record(z.string().max(60), z.unknown()).describe("Field values for the draft. Keys must be fields of the collection."),
	}),
	resolveInspection: z.object({
		jobId: z.string().min(1).max(200),
		finding: z.enum(["not_executed", "executed", "unknown"]),
		note: z.string().trim().min(10).max(2000),
	}),
	manualStart: z.object({ jobId: z.string().min(1).max(200) }),
	manualComplete: z.object({
		jobId: z.string().min(1).max(200),
		outcome: z.enum(["succeeded", "failed"]),
		note: z.string().trim().min(5).max(2000),
		evidenceIds: z.array(z.string().max(200)).max(20).default([]),
		observed: z
			.object({
				serialNumber: z.string().trim().max(40).optional(),
				ecid: z.string().trim().max(40).optional(),
				osVersion: z.string().trim().max(20).optional(),
				buildVersion: z.string().trim().max(20).optional(),
			})
			.optional(),
	}),
	acknowledge: z.object({ confirm: z.literal(true) }),

	// ---- 1.2 entities, identity and automation ------------------------------------------
	entity: z.object({
		collection: entityCollection,
		ref: ref.describe("The record's code (CL-0001), entry id or translation group."),
		...flags,
	}),
	entityColumns: z.object({ collection: entityCollection, ids: z.array(z.string().max(100)).max(100) }),
	registrationCheck: z.object({
		collection: entityCollection,
		title: z.string().trim().min(1).max(200),
		code: z.string().trim().max(41).optional(),
		identifiers: z.array(identifier).max(20).optional(),
		subject: z.string().max(120).optional().describe("The record being edited, so it is not reported as its own duplicate."),
	}),
	proposeEntity: z.object({
		collection: entityCollection,
		title: z.string().trim().min(1).max(200),
		description: z.string().trim().max(4000).optional(),
		classification: z.enum(["public", "internal", "confidential", "restricted"]).optional(),
		identifiers: z.array(identifier).max(20).optional(),
		fields: z
			.record(z.string().regex(/^[a-z_]{1,40}$/), z.union([z.string().max(2000), z.number(), z.boolean()]))
			.optional()
			.describe("Other plain fields of the collection (for example client_kind, legal_name, service_kind, environment)."),
	}),
	runs: z.object({ status: z.enum(["queued", "running", "waiting_approval", "waiting_input", "succeeded", "partially_failed", "failed", "cancelled", "needs_attention"]).optional() }),
	run: z.object({ runId: z.string().min(1).max(300) }),
	preview: z.object({
		blueprint: z.string().trim().min(1).max(64).describe("Blueprint code, for example BP-CLIENT-ONBOARDING."),
		collection: entityCollection,
		subject: ref.describe("Code of the record to preview against."),
		useDraft: z.boolean().default(false).describe("Editors: preview the blueprint's unpublished draft."),
	}),
	identityLookup: identifier,
	controls: z.object({}).describe("The control catalogue."),
	controlIds: z.enum(CONTROL_IDS as [string, ...string[]]),
};

// ---- Bridge wire format ----------------------------------------------------------

const device = z.object({
	ecid: z.string().trim().regex(/^(0x)?[0-9a-fA-F]{1,20}$/).optional(),
	serialNumber: z.string().trim().regex(/^[A-Za-z0-9]{8,20}$/).optional(),
	deviceType: z.string().trim().max(64).optional(),
});

const observed = z.object({
	ecid: z.string().trim().max(40).optional(),
	serialNumber: z.string().trim().max(40).optional(),
	deviceType: z.string().trim().max(64).optional(),
	osVersion: z.string().trim().max(20).optional(),
	buildVersion: z.string().trim().max(20).optional(),
	activationState: z.string().trim().max(40).optional(),
});

export const BridgeS = {
	claim: z.object({
		devices: z.array(device).max(32).default([]),
		mode: z.enum(["real", "simulated"]),
		validatedOperations: z.array(z.string().max(40)).max(20).default([]),
		bridgeVersion: z.string().max(32).optional(),
	}),
	check: z.object({ jobId: z.string().min(1).max(200), leaseId: z.string().min(1).max(100) }),
	report: z.object({
		jobId: z.string().min(1).max(200),
		leaseId: z.string().min(1).max(100),
		reportId: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/),
		opRevision: z.string().min(1).max(200),
		phase: z.enum(["started", "progress", "succeeded", "failed", "interrupted"]),
		message: z.string().max(2000).optional(),
		observed: observed.optional(),
		result: z.record(z.string().max(40), z.union([z.string().max(4000), z.number(), z.boolean(), z.null()])).optional(),
	}),
	health: z.object({
		bridgeVersion: z.string().max(32),
		macosVersion: z.string().max(40).nullable(),
		cfgutilPath: z.string().max(300).nullable(),
		cfgutilVersion: z.string().max(80).nullable(),
		mode: z.enum(["real", "simulated"]),
		adapters: z
			.array(
				z.object({
					id: z.string().max(60),
					deviceClasses: z.array(z.string().max(40)).max(8),
					operations: z.array(z.object({ name: z.string().max(40), validated: z.boolean(), reason: z.string().max(300).optional() })).max(20),
				}),
			)
			.max(10),
		devices: z.number().int().min(0).max(100),
	}),
};

export const COLLECTION_ENUM = z.enum(COLLECTION_SLUGS as [string, ...string[]]);
