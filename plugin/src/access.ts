/**
 * Who may see what in graph, dashboard and MCP responses.
 *
 * EmDash has already authenticated the caller and checked the route's declared
 * permission before any of this runs. This module narrows further:
 * - drafts only for editors and above, and only when explicitly requested;
 * - operational node types (operations, jobs, events, evidence, bridges) only
 *   for editors and above;
 * - hardware identifiers (serial numbers, ECIDs) and lease tokens are masked
 *   unless the caller is an administrator who explicitly asked to reveal them;
 * - secrets never appear: settings are not graph data, and job records never
 *   carry credentials.
 * - 1.2 entities carry a classification: confidential needs an editor,
 *   restricted an administrator, and bearer-token callers (API tokens, MCP)
 *   never see above the `tokenMaxClassification` setting (default internal).
 *   Records without a classification (all 1.1 collections) keep the rules above.
 */

import type { View } from "./content.js";
import { CLASSIFICATION_MIN_ROLE, type Classification, classificationRank, CLASSIFICATIONS, isClassification } from "./entities.js";
import { ROLE } from "./model.js";
import { NODE_TYPES, type NodeTypeSpec } from "./ontology.js";

export interface Access {
	role: number;
	userId: string | null;
	view: View;
	/** Unmasked hardware identifiers. Administrators only, on explicit request. */
	revealIdentifiers: boolean;
	/** Highest classification this caller may see (role and token cap combined). */
	maxClassification: number;
	/** The caller authenticated with a bearer token (API token or MCP), not a browser session. */
	token: boolean;
}

export interface AccessRequest {
	includeDrafts?: boolean;
	revealIdentifiers?: boolean;
}

export function accessFor(
	user: { id: string; role: number } | undefined | null,
	request: AccessRequest = {},
	caller: { token?: boolean; tokenMaxClassification?: Classification } = {},
): Access {
	const role = user?.role ?? 0;
	let max = -1;
	for (const c of CLASSIFICATIONS) if (role >= CLASSIFICATION_MIN_ROLE[c]) max = classificationRank(c);
	if (caller.token) max = Math.min(max, classificationRank(caller.tokenMaxClassification ?? "internal"));
	return {
		role,
		userId: user?.id ?? null,
		view: request.includeDrafts && role >= ROLE.EDITOR ? "draft" : "published",
		revealIdentifiers: !!request.revealIdentifiers && role >= ROLE.ADMIN && !caller.token,
		maxClassification: max,
		token: !!caller.token,
	};
}

/** May the caller see a record of this classification? Unclassified records defer to the type rules. */
export function canSeeClassification(access: Access, classification: unknown): boolean {
	if (classification === null || classification === undefined || classification === "") return true;
	if (!isClassification(classification)) return access.maxClassification >= classificationRank("restricted");
	return classificationRank(classification) <= access.maxClassification;
}

export function canSeeType(access: Access, type: string): boolean {
	const spec = (NODE_TYPES as Record<string, NodeTypeSpec>)[type];
	if (!spec || spec.source.kind === "planned") return false;
	return access.role >= spec.minRole;
}

/** Mask an identifier, keeping the last four characters so a person can still match a device in front of them. */
export function mask(value: string): string {
	const clean = value.trim();
	if (clean.length <= 4) return "••••";
	return `••••${clean.slice(-4)}`;
}

const ALWAYS_REMOVED = new Set(["secret", "password", "token", "bridgeSecret", "apiKey", "leaseId"]);

/** Apply field-level filtering for a node type. Returns a copy. */
export function filterFields(access: Access, type: string, data: Record<string, unknown>): Record<string, unknown> {
	const spec = (NODE_TYPES as Record<string, NodeTypeSpec>)[type];
	const sensitive = new Set(spec?.sensitiveFields ?? []);
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		// Where credentials live is shown to administrators in a session; others see only how many references exist.
		if (key === "secret_refs") {
			out.secret_refs = access.role >= ROLE.ADMIN && !access.token ? value : Array.isArray(value) ? `${value.length} reference(s)` : null;
			continue;
		}
		// Contract documents are never part of graph, search or MCP answers.
		if (type === "contract" && key === "document") continue;
		if (ALWAYS_REMOVED.has(key) || /secret|password|token/i.test(key)) continue;
		if (sensitive.has(key) && typeof value === "string" && value && !access.revealIdentifiers) {
			out[key] = mask(value);
			continue;
		}
		out[key] = value;
	}
	return out;
}
