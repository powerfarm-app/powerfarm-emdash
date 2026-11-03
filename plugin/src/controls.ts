/**
 * Lifecycle controls for 1.2 entities, derived from EmDash content: the entity's
 * own fields and relations, evidence attestations naming it as subject,
 * published security exceptions, and the identity registry. Nothing here is an
 * editable status; `evaluate` is pure and `loadEntityState` only reads.
 */

import type { ContentReader, Entity, View } from "./content.js";
import {
	classificationRank,
	type ControlId,
	CONTROLS,
	type ControlSpec,
	ENTITY_TYPES,
	type EntityCollection,
	type EntityFacts,
	findSecretLike,
	formatSubject,
	isClassification,
	isEntityCollection,
	isLifecycle,
	parseSecretRefs,
	requiredControls,
	type Stage,
} from "./entities.js";
import { type Claim, formatIdentifier, type Identifier, type IdentityEvidence, identifierStatus, type IdentifierStatus, lookupMany, parseIdentifiers } from "./identity.js";
import { type CollectionSlug, isPowerfarmCollection } from "./model.js";
import { referenceFieldFor, RELATION_ENDS } from "./ontology.js";

export type ControlStatus = "met" | "waived" | "missing" | "expired";

export interface ControlResult {
	control: ControlId;
	label: string;
	pillar: ControlSpec["pillar"];
	status: ControlStatus;
	detail: string;
	/** Exception code when waived. */
	exception?: string;
}

export interface SubjectEvidence extends IdentityEvidence {
	id: string;
}

export interface SubjectException {
	code: string;
	control: string;
	expiresAt: string | null;
}

export interface Dependant {
	collection: string;
	key: string | null;
	title: string;
	active: boolean;
	relation: string;
}

export interface EntityState {
	entity: Entity;
	facts: EntityFacts;
	subject: string;
	identifiers: Identifier[];
	identifierErrors: string[];
	/** Registry entries for the record's identifiers, by `namespace:value`. */
	claims: Map<string, Claim>;
	evidence: SubjectEvidence[];
	exceptions: SubjectException[];
	dependants: Dependant[];
}

const DAY = 86_400_000;

function attestationsFor(state: Pick<EntityState, "evidence" | "facts">, kind: string, validDays: number | undefined, now: number): { valid: SubjectEvidence[]; stale: SubjectEvidence[] } {
	const created = state.facts.createdAt ? Date.parse(state.facts.createdAt) : 0;
	const all = state.evidence.filter((e) => e.attests === kind && e.signedBy && Date.parse(e.createdAt) >= created);
	const fresh = (e: SubjectEvidence) => validDays === undefined || now - Date.parse(e.createdAt) <= validDays * DAY;
	return { valid: all.filter(fresh), stale: all.filter((e) => !fresh(e)) };
}

function evaluateOne(state: EntityState, id: ControlId, now: number): { status: "met" | "missing" | "expired"; detail: string } {
	const spec: ControlSpec = CONTROLS[id];
	const { facts } = state;
	const refs = facts.references;
	const attested = (needsIdentifier = false): { status: "met" | "missing" | "expired"; detail: string } => {
		const { valid, stale } = attestationsFor(state, spec.attestation!, spec.validDays, now);
		let usable = spec.needsFile ? valid.filter((e) => e.digestVerified) : valid;
		if (needsIdentifier) {
			const names = new Set(state.identifiers.map(formatIdentifier));
			usable = usable.filter((e) => e.identifier && names.has(e.identifier));
		}
		if (usable.length > 0) {
			const latest = usable.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
			return { status: "met", detail: `${spec.attestation} recorded ${latest.createdAt.slice(0, 10)}` };
		}
		if (stale.length > 0) return { status: "expired", detail: `The last ${spec.attestation} is older than ${spec.validDays} days.` };
		if (spec.needsFile && valid.length > 0) return { status: "missing", detail: `${spec.attestation} needs the signed copy attached so the server can hash it.` };
		if (needsIdentifier && valid.length > 0) return { status: "missing", detail: "The identity_verified attestation must name one of this record's identifiers (namespace:value)." };
		return { status: "missing", detail: `Record a ${spec.attestation} attestation with subject ${state.subject}.` };
	};
	switch (id) {
		case "owner_assigned":
			return (refs.owner?.length ?? 0) > 0 ? { status: "met", detail: "Owner set" } : { status: "missing", detail: "Set the accountable owner." };
		case "identity_recorded": {
			if (state.identifierErrors.length) return { status: "missing", detail: state.identifierErrors[0]! };
			if (state.identifiers.length === 0) return { status: "missing", detail: "Add at least one identifier (VAT, LEI, domain …)." };
			const held = state.identifiers.filter((i) => {
				const c = state.claims.get(formatIdentifier(i));
				return c && c.subject !== state.subject;
			});
			return held.length ? { status: "missing", detail: `${formatIdentifier(held[0]!)} belongs to ${held.length === 1 ? state.claims.get(formatIdentifier(held[0]!))!.subject : "other records"}.` } : { status: "met", detail: `${state.identifiers.length} identifier(s)` };
		}
		case "identity_verified":
			return attested(state.identifiers.length > 0);
		case "maintenance_plan": {
			const cadence = Number(facts.data.review_cadence_days ?? 0);
			if (!(cadence > 0)) return { status: "missing", detail: "Set Review every (days)." };
			return attested();
		}
		case "service_linked":
			return (refs.service?.length ?? 0) === 1 ? { status: "met", detail: "Linked" } : { status: "missing", detail: "Select the catalogue service this is an instance of." };
		case "secrets_referenced": {
			const parsed = parseSecretRefs(facts.data.secret_refs);
			if (parsed.errors.length) return { status: "missing", detail: parsed.errors[0]! };
			const leak = findSecretLike(facts.data);
			return leak ? { status: "missing", detail: `${leak}. Remove it and reference where it is stored.` } : { status: "met", detail: `${parsed.refs.length} reference(s), no inline credentials` };
		}
		case "counterparty_linked":
			return (refs.client?.length ?? 0) > 0 ? { status: "met", detail: "Client linked" } : { status: "missing", detail: "Select the client." };
		case "dates_recorded":
			return facts.data.effective_date && (facts.data.end_date || facts.data.renewal_date)
				? { status: "met", detail: "Dates recorded" }
				: { status: "missing", detail: "Record the effective date and an end or renewal date." };
		case "review_current": {
			const cadence = Number(facts.data.review_cadence_days ?? 0);
			if (!(cadence > 0)) return { status: "missing", detail: "No review cadence set." };
			const reviews = state.evidence.filter((e) => (e.attests === "maintenance_review" || e.attests === "maintenance_plan") && e.signedBy);
			const last = reviews.map((e) => Date.parse(e.createdAt)).sort((a, b) => b - a)[0];
			if (!last) return { status: "missing", detail: "Never reviewed." };
			return now - last <= cadence * DAY ? { status: "met", detail: `Reviewed ${new Date(last).toISOString().slice(0, 10)}` } : { status: "expired", detail: `Review overdue since ${new Date(last + cadence * DAY).toISOString().slice(0, 10)}.` };
		}
		case "renewal_not_due": {
			const dates = [facts.data.renewal_date, facts.data.end_date].filter((d): d is string => typeof d === "string" && !!d).map(Date.parse).filter(Number.isFinite);
			if (dates.length === 0) return { status: "missing", detail: "No end or renewal date." };
			const next = Math.min(...dates);
			return next > now ? { status: "met", detail: `Next date ${new Date(next).toISOString().slice(0, 10)}` } : { status: "expired", detail: `Passed on ${new Date(next).toISOString().slice(0, 10)}.` };
		}
		case "no_active_dependants": {
			const active = state.dependants.filter((d) => d.active);
			return active.length ? { status: "missing", detail: `Still used by ${active.slice(0, 3).map((d) => d.key ?? d.title).join(", ")}${active.length > 3 ? " …" : ""}.` } : { status: "met", detail: "Nothing active depends on it" };
		}
		case "classification_reviewed":
		case "access_reviewed":
		case "security_baseline":
		case "contract_signed":
		case "retirement_approved":
			return attested();
	}
}

/** Evaluate one control, including an unexpired published exception for it. */
export function evaluateControl(state: EntityState, id: ControlId, now = Date.now()): ControlResult {
	const spec: ControlSpec = CONTROLS[id];
	const r = evaluateOne(state, id, now);
	if (r.status !== "met" && spec.waivable) {
		const exception = state.exceptions.find((e) => e.control === id && e.expiresAt && Date.parse(e.expiresAt) > now);
		if (exception) return { control: id, label: spec.label, pillar: spec.pillar, status: "waived", detail: `Waived by ${exception.code} until ${exception.expiresAt!.slice(0, 10)}`, exception: exception.code };
	}
	return { control: id, label: spec.label, pillar: spec.pillar, status: r.status, detail: r.detail };
}

/** Evaluate the controls a stage requires. */
export function evaluate(state: EntityState, stage: Stage, now = Date.now()): ControlResult[] {
	return requiredControls(state.facts, stage).map((id) => evaluateControl(state, id, now));
}

/** Controls that block a gate (anything not met or waived). */
export function blocking(results: readonly ControlResult[]): ControlResult[] {
	return results.filter((r) => r.status !== "met" && r.status !== "waived");
}

/** Every stage at once, for panels and MCP. */
export function controlReport(state: EntityState, now = Date.now()) {
	const expiredExceptions = state.exceptions.filter((e) => e.expiresAt && Date.parse(e.expiresAt) <= now).map((e) => e.code);
	return {
		subject: state.subject,
		lifecycle: state.facts.lifecycle,
		classification: state.facts.classification,
		activation: evaluate(state, "activation", now),
		operation: evaluate(state, "operation", now),
		retirement: evaluate(state, "retirement", now),
		expiredExceptions,
	};
}

/** Identifier list with derived status for display. */
export function identifierReport(state: EntityState): Array<{ identifier: string; status: IdentifierStatus | "conflict" | "unclaimed"; holder?: string }> {
	return state.identifiers.map((id) => {
		const claim = state.claims.get(formatIdentifier(id)) ?? null;
		if (claim && claim.subject !== state.subject) return { identifier: formatIdentifier(id), status: "conflict" as const, holder: claim.subject };
		if (!claim) return { identifier: formatIdentifier(id), status: "unclaimed" as const };
		return { identifier: formatIdentifier(id), status: identifierStatus(claim, id, state.evidence) };
	});
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Reference selections by field for one entity: live relation edges, with the
 * draft revision's staged selections taking precedence field by field.
 */
export async function referencesOf(reader: ContentReader, entity: Entity): Promise<Record<string, string[]>> {
	const out: Record<string, string[]> = {};
	for (const e of await reader.readPort.edgesTouching([entity.group])) {
		const isParent = e.parent_group === entity.group && e.parent_collection === entity.collection;
		const isChild = e.child_group === entity.group && e.child_collection === entity.collection;
		if (!isParent && !isChild) continue;
		const field = referenceFieldFor(entity.collection, e.relation, isParent ? "parent" : "child");
		if (!field) continue;
		(out[field] ??= []).push(isParent ? e.child_group : e.parent_group);
	}
	for (const [field, groups] of Object.entries(entity.stagedReferences ?? {})) {
		if (Array.isArray(groups)) out[field] = groups.map(String);
	}
	return out;
}

/** Relations whose other end depends on this entity staying in service. */
const DEPENDANT_RELATIONS: Readonly<Partial<Record<EntityCollection, readonly string[]>>> = {
	services: ["services_instances", "products_services", "contracts_services", "projects_services"],
	service_instances: ["projects_service_instances"],
	products: ["clients_products", "contracts_products"],
	clients: ["clients_contracts"],
};

async function dependantsOf(reader: ContentReader, entity: Entity): Promise<Dependant[]> {
	const relations = DEPENDANT_RELATIONS[entity.collection as EntityCollection] ?? [];
	if (relations.length === 0) return [];
	const wanted = new Map<CollectionSlug, Map<string, string>>();
	for (const e of await reader.readPort.edgesTouching([entity.group])) {
		if (!relations.includes(e.relation)) continue;
		const ends = RELATION_ENDS[e.relation];
		if (!ends) continue;
		const self = e.parent_group === entity.group ? "parent" : "child";
		const other = self === "parent" ? ends.child : ends.parent;
		const group = self === "parent" ? e.child_group : e.parent_group;
		if (!wanted.has(other)) wanted.set(other, new Map());
		wanted.get(other)!.set(group, e.relation);
	}
	const out: Dependant[] = [];
	for (const [collection, groups] of wanted) {
		// oxlint-disable-next-line no-await-in-loop -- one query per related collection
		for (const d of await reader.byGroups(collection, [...groups.keys()], "published")) {
			const lifecycle = d.data.lifecycle;
			const active = collection === "projects" ? d.data.project_status === "active" : lifecycle === "active" || lifecycle === "suspended";
			out.push({ collection, key: d.key, title: d.title, active, relation: groups.get(d.group)! });
		}
	}
	return out;
}

export function entityFactsOf(entity: Entity, references: Record<string, string[]>): EntityFacts {
	const collection = entity.collection as EntityCollection;
	return {
		collection,
		key: entity.key ?? entity.id,
		title: entity.title,
		createdAt: entity.createdAt,
		lifecycle: isLifecycle(entity.data.lifecycle) ? entity.data.lifecycle : null,
		classification: isClassification(entity.data.classification) ? entity.data.classification : null,
		data: entity.data,
		references,
	};
}

export async function subjectEvidence(reader: ContentReader, subject: string): Promise<SubjectEvidence[]> {
	return (await reader.byField("evidence", "subject", [subject], "draft", 500)).map((e) => ({
		id: e.id,
		attests: typeof e.data.attests === "string" ? e.data.attests : null,
		identifier: typeof e.data.identifier === "string" ? e.data.identifier : null,
		digestVerified: e.data.digest_status === "server_verified",
		signedBy: typeof e.data.signed_by === "string" ? e.data.signed_by : null,
		createdAt: e.createdAt ?? "",
	}));
}

export async function subjectExceptions(reader: ContentReader, subject: string): Promise<SubjectException[]> {
	return (await reader.byField("exceptions", "subject", [subject], "published", 100)).map((e) => ({
		code: e.key ?? e.id,
		control: String(e.data.control ?? ""),
		expiresAt: typeof e.data.expires_at === "string" ? e.data.expires_at : null,
	}));
}

/**
 * Everything control evaluation needs for one entity. `view` "draft" evaluates
 * what a publish would make live (draft values and staged references).
 */
export async function loadEntityState(
	_ctx: unknown,
	reader: ContentReader,
	collection: string,
	ref: string,
	view: View,
	override?: Record<string, unknown>,
): Promise<EntityState | null> {
	if (!isEntityCollection(collection) || !isPowerfarmCollection(collection)) return null;
	const found = await reader.resolve(collection, ref, view);
	if (!found) return null;
	const entity = override ? { ...found, data: { ...found.data, ...override } } : found;
	const references = await referencesOf(reader, entity);
	const facts = entityFactsOf(entity, references);
	const subject = formatSubject(collection, facts.key);
	const parsed = parseIdentifiers(entity.data.identifiers);
	const [evidence, exceptions, dependants, claimMap] = await Promise.all([
		subjectEvidence(reader, subject),
		subjectExceptions(reader, subject),
		dependantsOf(reader, entity),
		lookupMany(reader, parsed.identifiers),
	]);
	return { entity, facts, subject, identifiers: parsed.identifiers, identifierErrors: parsed.errors, claims: claimMap, evidence, exceptions, dependants };
}

/** True when the classification is at least confidential. */
export function isSensitive(facts: Pick<EntityFacts, "classification">): boolean {
	return classificationRank(facts.classification) >= classificationRank("confidential");
}

export { ENTITY_TYPES };
