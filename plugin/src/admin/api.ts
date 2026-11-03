import { apiFetch, parseApiResponse } from "emdash/plugin-utils";

const BASE = "/_emdash/api/plugins/powerfarm";

export async function call<T>(route: string, body: Record<string, unknown> = {}): Promise<T> {
	const response = await apiFetch(`${BASE}/${route}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	return parseApiResponse<T>(response, `Powerfarm request failed: ${route}`);
}

/**
 * Share one request among many components (every list cell, every widget).
 * Entries expire after `ttlMs` so the views stay current.
 */
const shared = new Map<string, { at: number; promise: Promise<unknown> }>();
export function sharedCall<T>(route: string, body: Record<string, unknown> = {}, ttlMs = 10_000): Promise<T> {
	const key = `${route}|${JSON.stringify(body)}`;
	const hit = shared.get(key);
	if (hit && Date.now() - hit.at < ttlMs) return hit.promise as Promise<T>;
	const promise = call<T>(route, body).catch((error) => {
		shared.delete(key);
		throw error;
	});
	shared.set(key, { at: Date.now(), promise });
	if (shared.size > 200) shared.delete(shared.keys().next().value!);
	return promise;
}

export function invalidateShared(): void {
	shared.clear();
}

export const ADMIN = "/_emdash/admin";
export function contentUrl(collection: string, id?: string): string {
	return id ? `${ADMIN}/content/${collection}/${id}` : `${ADMIN}/content/${collection}`;
}
export function pluginPage(path: string, params?: Record<string, string>): string {
	const q = params ? `?${new URLSearchParams(params).toString()}` : "";
	return `${ADMIN}/plugins/powerfarm${path}${q}`;
}

// ---- Response shapes (see src/services.ts) --------------------------------------

export interface NextAction {
	assetTag: string;
	status: string;
	action: string;
	procedureCode: string | null;
	operator: boolean;
	instructions: string[];
	blocking: string | null;
	complete: boolean;
}

export interface JobSummary {
	id: string;
	opId: string;
	opCode: string;
	opRevision: string;
	assetTag: string;
	operation: string;
	status: string;
	executionMode: string | null;
	dryRun: boolean;
	destructive: boolean;
	claimedBy: string | null;
	updatedAt: string;
	lastMessage: string | null;
	evidence: Array<{ kind: string; evidenceId: string; sha256: string }>;
	missingEvidence: string[];
	inspection: { finding: string; note: string } | null;
	adapter?: string;
}

export interface FleetAsset {
	assetTag: string;
	title: string;
	id: string;
	deviceClass: string | null;
	role: string | null;
	inMission: boolean;
	status: string;
	reasons: string[];
	lastVerifiedAt: string | null;
	missing: string[];
	blocker: string | null;
	next: NextAction;
	activeJobs: JobSummary[];
	acceptancePassed: boolean;
}

export interface Fleet {
	mission: string;
	auditDegraded: boolean;
	targets: number;
	trusted: number;
	complete: boolean;
	assets: FleetAsset[];
}

export interface Dashboard {
	mission: { code: string; targets: number; trusted: number; complete: boolean; statusCounts: Record<string, number> };
	readiness: Array<{ assetTag: string; title: string; status: string; inMission: boolean; role: string | null }>;
	physicalActions: Array<{ assetTag: string; action: string; procedureCode: string | null }>;
	needsInspection: JobSummary[];
	failed: Array<{ kind: string; ref: string; detail: string }>;
	pendingApprovals: Array<{ id: string; opCode: string | null; title: string; assetTag: unknown; preparedByAi: boolean }>;
	bridges: Array<{ id: string; status: unknown; lastSeenAt: unknown; version: unknown; mode: unknown; validated: unknown }>;
	missingEvidence: Array<{ ref: string; detail: string }>;
	recent: Array<{ at: string; type: string; title: string; stream: string }>;
	audit: { degraded: boolean; since: string | null; reasons: string[]; projectionBacklog: number; jobsWithAuditGaps: number };
	tasks: Record<string, { at: string; ok: boolean; error: string | null } | null>;
}

export interface NodeView {
	id: string;
	type: string;
	domain: string;
	key: string | null;
	title: string;
	status: string | null;
	state: string;
	updatedAt: string | null;
	data?: Record<string, unknown>;
	adminUrl?: string;
}

export interface Neighbour {
	direction: "out" | "in";
	node: NodeView;
	edge: { id: string; type: string; label: string; from: string; to: string; source: string; state: string; recordedAt: string | null; origin: string };
}

// ---- 1.2 shapes (see src/entity-services.ts, src/controls.ts, src/runs.ts) ---------------

export interface ControlRow {
	control: string;
	label: string;
	pillar: string;
	status: "met" | "waived" | "missing" | "expired";
	detail: string;
	exception?: string;
}

export interface RunView {
	id: string;
	blueprint: string;
	templateRevision: string;
	trigger: string;
	subject: string;
	status: string;
	initiatedBy: string;
	createdAt: string;
	closedAt: string | null;
	steps: Array<{ id: string; action: string; status: string; message: string | null; ref: { collection: string; id: string; key: string | null } | null; attention: number }>;
}

export interface EntityPanelData {
	subject: string;
	id: string;
	title: string;
	status: string;
	lifecycle: string | null;
	classification: string | null;
	mergedInto: string | null;
	identifiers: Array<{ identifier: string; status: string; holder?: string }>;
	controls: { activation: ControlRow[]; operation: ControlRow[]; retirement: ControlRow[]; expiredExceptions: string[] };
	exceptions: Array<{ code: string; control: string; expiresAt: string | null }>;
	evidence: Array<{ id: string; attests: string | null; identifier: string | null; digestVerified: boolean; createdAt: string }>;
	dependants: Array<{ collection: string; key: string | null; title: string; active: boolean; relation: string }>;
	runs: RunView[];
	workItems: Array<{ id: string; code: string | null; title: string; kind: string; pillar: string | null; status: string; dueAt: string | null; requiredRole: number | null; adminUrl: string }>;
	revisions: Array<{ id: string; at: string }>;
}

export interface Option {
	id: string;
	key: string | null;
	title: string;
	lifecycle: string | null;
}

export interface RegistrationOptions {
	people: Option[];
	products: Option[];
	services: Option[];
	projects: Option[];
	clients: Option[];
	assets: Option[];
	software: Option[];
	blueprints: Array<{ code: string | null; title: string; target: string | null; trigger: string | null; published: boolean }>;
	types: Array<{ collection: string; codePrefix: string; defaultClassification: string }>;
}

export interface PreviewResult {
	simulated: true;
	blueprint: string;
	templateRevision: string | null;
	subject: string;
	errors: string[];
	steps: Array<{ id: string; action: string; outcome: string; detail: string; dependsOn: string[] }>;
}
