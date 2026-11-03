/**
 * EmDash content hooks for 1.2 entities and their supporting collections.
 * Called from policy.ts, which owns hook registration.
 *
 * - Saves: codes allocated, identifiers normalised and checked against the
 *   registry, credentials refused, origin protected, AI limits; people's
 *   decisions on blueprint work items (approvals, attention) checked for role
 *   and separation; identifier transfers limited to administrators.
 * - Publishes are the approval boundary: lifecycle transitions are checked
 *   against the controls each stage requires, identifiers are claimed as
 *   `identifiers` entries (EmDash's unique index decides races), merges are
 *   checked, and a KV marker tells `afterPublish` what happened. `afterPublish`
 *   releases dropped identifiers, moves a merged duplicate's identifiers, and
 *   starts blueprint runs. History is EmDash's revisions and the audit-log plugin.
 */

import type { ContentPolicyDecision, ContentPolicyEvent, PluginContext } from "emdash";
import { ContentSaveRejectedError } from "emdash";

import { validateSteps } from "./blueprints.js";
import type { ContentReader } from "./content.js";
import { blocking, evaluate, loadEntityState } from "./controls.js";
import {
	CLASSIFICATION_MIN_ROLE,
	classificationRank,
	CODE_PREFIXES,
	CONTROL_ATTESTATIONS,
	controlSpec,
	ENTITY_TYPES,
	type EntityCollection,
	findSecretLike,
	formatSubject,
	isClassification,
	isEntityCollection,
	isLifecycle,
	type Lifecycle,
	LIFECYCLE_TRANSITIONS,
	parseSecretRefs,
	parseSubject,
	stageFor,
} from "./entities.js";
import { claimAll, conflicts, formatIdentifier, moveAll, namespaceOf, parseIdentifiers, releaseDropped } from "./identity.js";
import { auditState } from "./journal.js";
import { readSettings } from "./jobs.js";
import { type CollectionSlug, PLUGIN_ID, ROLE } from "./model.js";
import { advanceForSubject, type RunCtx, startRuns, workItemChangeRefusal } from "./onboarding.js";
import { getReader } from "./runtime.js";
import { suspendPrincipal } from "./suspension.js";
import { grantPublishRefusal, grantProblems, refusal as authorityRefusal } from "./authority.js";

/** Principals whose publication (registration, activation, suspension) is identity administration. */
export const PRINCIPAL_COLLECTIONS = new Set(["people", "agents", "organizations"]);

export const SUPPORT_COLLECTIONS = new Set(["blueprints", "work_items", "exceptions", "identifiers", "grants", "policies"]);

export function isEntityOrSupport(collection: string): boolean {
	return isEntityCollection(collection) || SUPPORT_COLLECTIONS.has(collection);
}

function reject(reason: string): never {
	throw new ContentSaveRejectedError(reason.slice(0, 500));
}

function cancel(reason: string): ContentPolicyDecision {
	return { cancel: true, reason: reason.slice(0, 500) };
}

function dataOf(content: Record<string, unknown>): Record<string, unknown> {
	const data = content.data;
	return data && typeof data === "object" ? (data as Record<string, unknown>) : content;
}

async function nextCode(ctx: Pick<PluginContext, "kv">, collection: string, prefix: string): Promise<string> {
	const key = `seq:${collection}`;
	for (let attempt = 0; attempt < 8; attempt++) {
		// oxlint-disable-next-line no-await-in-loop -- bounded CAS retry
		const current = await ctx.kv.getVersioned<number>(key);
		const next = (current?.value ?? 0) + 1;
		// oxlint-disable-next-line no-await-in-loop
		if ((await ctx.kv.compareAndSet(key, current?.revision ?? null, next)).applied) return `${prefix}-${String(next).padStart(4, "0")}`;
	}
	reject("Could not allocate a code; try again.");
}

function parseSubjectRef(value: string): { collection: CollectionSlug; key: string } | null {
	const p = parseSubject(value);
	return p ? { collection: p.collection, key: p.key } : null;
}

async function subjectExists(value: unknown): Promise<string> {
	const subject = parseSubject(value);
	if (!subject) reject(`Subject must look like clients:CL-0001 (collection:KEY).`);
	const reader = await getReader();
	if (!(await reader.resolve(subject.collection, subject.key, "draft"))) reject(`${formatSubject(subject.collection, subject.key)} does not exist.`);
	return formatSubject(subject.collection, subject.key);
}

// ---------------------------------------------------------------------------
// Saves
// ---------------------------------------------------------------------------

type Actor = { id: string; role: number; source?: string } | null | undefined;

export async function beforeSaveEntity(
	event: { collection: string; content: Record<string, unknown>; isNew: boolean; id?: string; actor?: Actor },
	ctx: PluginContext,
): Promise<Record<string, unknown>> {
	const { collection, content, isNew, actor } = event;
	const fromAi = actor?.source === "mcp";
	const reader = await getReader();
	const current = !isNew && event.id ? await reader.resolve(collection as CollectionSlug, event.id, "draft") : null;

	// `origin` marks what a blueprint created; people and AI cannot set or change it.
	if (actor && "origin" in content && String(content.origin ?? "") !== String(current?.data.origin ?? "")) {
		reject("origin is set by Powerfarm blueprints and cannot be edited.");
	}
	const leak = findSecretLike(content);
	if (leak) reject(`${leak}. Store credentials in a password manager or vault and record only where they are (Secret references).`);

	const prefix = CODE_PREFIXES[collection as CollectionSlug];
	if (prefix && typeof content.code === "string" && content.code.trim()) {
		const code = content.code.trim().toUpperCase();
		if (!/^[A-Z0-9][A-Z0-9-]{1,40}$/.test(code)) reject("Codes use capital letters, digits and dashes (for example CL-0001).");
		if (current?.key && current.key !== code && current.status === "published") reject("A published record keeps its code. Register a new record or ask an administrator to merge.");
		content.code = code;
	}
	// 1.4: every principal has a permanent id that no one sets or changes by hand.
	if (isEntityCollection(collection)) {
		const given = typeof content.principal_id === "string" ? content.principal_id : null;
		const existing = typeof current?.data.principal_id === "string" ? current.data.principal_id : null;
		if (given !== null && actor && given !== existing) reject("principal_id is assigned by Powerfarm and never changes.");
		if (isNew && !existing) content.principal_id = crypto.randomUUID();
		else if (existing) content.principal_id = existing;
	}
	const checked = await checkByCollection(collection, content, isNew, actor, current, ctx);
	// Allocate a code last, so a rejected save never consumes one.
	if (prefix && isNew && !(typeof checked.code === "string" && checked.code)) checked.code = await nextCode(ctx, collection, prefix);
	return checked;
}

async function checkByCollection(
	collection: string,
	content: Record<string, unknown>,
	isNew: boolean,
	actor: Actor,
	current: Awaited<ReturnType<Awaited<ReturnType<typeof getReader>>["resolve"]>>,
	ctx: PluginContext,
): Promise<Record<string, unknown>> {
	const fromAi = actor?.source === "mcp";
	if (isEntityCollection(collection)) {
		const spec = ENTITY_TYPES[collection];
		if (isNew) {
			if (content.lifecycle === undefined || content.lifecycle === null) content.lifecycle = "intake";
			if (content.classification === undefined || content.classification === null) content.classification = spec.defaultClassification;
		}
		if (content.lifecycle !== undefined && !isLifecycle(content.lifecycle)) reject(`Lifecycle must be intake, active, suspended or retired.`);
		if (content.classification !== undefined && !isClassification(content.classification)) reject("Classification must be public, internal, confidential or restricted.");
		if (actor && "merged_into" in content && String(content.merged_into ?? "") !== String(current?.data.merged_into ?? "")) {
			if (fromAi || actor.role < ROLE.ADMIN) reject("Only an administrator merges records.");
			if (content.merged_into) content.merged_into = String(content.merged_into).trim().toUpperCase();
		}
		if (fromAi) {
			content.prepared_by_ai = true;
			if (!isNew && "lifecycle" in content && content.lifecycle !== current?.data.lifecycle) reject("AI clients cannot change a lifecycle. A person does that by publishing.");
			if (!isNew && "classification" in content && classificationRank(content.classification) < classificationRank(current?.data.classification)) {
				reject("AI clients cannot lower a classification.");
			}
		}
		if ("identifiers" in content) {
			const parsed = parseIdentifiers(content.identifiers);
			if (parsed.errors.length) reject(parsed.errors.join(" "));
			content.identifiers = parsed.identifiers;
			const reader = await getReader();
			const taken = await conflicts(reader, current?.key ? formatSubject(collection, current.key) : null, parsed.identifiers);
			if (taken.length) {
				const t = taken[0]!;
				reject(`${formatIdentifier(t.identifier)} already identifies ${t.holder.subject}. Open that record instead of registering a duplicate, or ask an administrator to transfer or merge.`);
			}
		}
		if (collection === "service_instances" && "secret_refs" in content) {
			const refs = parseSecretRefs(content.secret_refs);
			if (refs.errors.length) reject(refs.errors.join(" "));
		}
		return content;
	}

	if (collection === "work_items") {
		if (fromAi) reject("Work items are created by people and blueprints, not by AI clients.");
		if (actor && isNew) {
			const kind = String(content.work_kind ?? "task");
			if (!["task", "review", "link_request"].includes(kind)) reject("Approvals, control checks, notes and attention items are created by blueprint runs.");
			for (const f of ["run_id", "step_id", "blueprint_code", "blueprint_revision", "initiated_by", "separate_from_initiator", "required_role", "control", "resolved_by", "resolved_at"]) {
				if (content[f] !== undefined && content[f] !== null && content[f] !== "") reject(`${f} is maintained by Powerfarm.`);
			}
		}
		if (actor && !isNew && current) {
			const refusal = workItemChangeRefusal(current.data, content, actor as { id: string; role: number; source?: string }, await readSettings(ctx));
			if (refusal) reject(refusal);
			const to = "work_status" in content ? String(content.work_status) : String(current.data.work_status ?? "open");
			if (to !== String(current.data.work_status ?? "open")) {
				content.resolved_by = `user:${actor.id}`;
				content.resolved_at = new Date().toISOString();
			}
		}
		if (content.subject) content.subject = await subjectExists(content.subject);
		return content;
	}

	if (collection === "identifiers") {
		// Entries are written by Powerfarm from records' Identifiers fields. People only transfer.
		if (!actor) return content;
		if (fromAi) reject("AI clients cannot change the identity registry.");
		if (actor.role < ROLE.ADMIN) reject("Only an administrator changes the identity registry.");
		if (isNew) reject("Add identifiers on the record itself; Powerfarm registers them when it is published.");
		for (const f of ["identifier", "namespace", "value"]) {
			if (f in content && String(content[f] ?? "") !== String(current?.data[f] ?? "")) reject(`${f} cannot change; an entry is one identifier.`);
		}
		if ("subject" in content && String(content.subject) !== String(current?.data.subject ?? "")) {
			if (namespaceOf(String(current?.data.namespace ?? ""))?.readOnly) reject("Mission 001 identifiers follow the asset records and cannot be transferred.");
			const target = await subjectExists(content.subject);
			const reader = await getReader();
			const parsed = parseSubjectRef(target);
			if (!parsed || !(await reader.resolve(parsed.collection, parsed.key, "published"))) reject("Transfer to a published record.");
			if (String(content.rationale ?? "").trim().length < 20) reject("Give a rationale for the transfer (at least 20 characters).");
			const denied = await authorityRefusal(ctx as never, reader, { actor, capability: "identity.admin", scope: String(current?.data.subject ?? target), what: `transfer ${String(current?.data.identifier ?? "")} to ${target}` });
			if (denied) reject(denied);
			content.subject = target;
			content.source = "transfer";
		}
		return content;
	}

	if (collection === "exceptions") {
		if (fromAi) content.prepared_by_ai = true;
		if (content.subject !== undefined || isNew) content.subject = await subjectExists(content.subject);
		if (content.control !== undefined || isNew) {
			const spec = controlSpec(String(content.control ?? ""));
			if (!spec) reject("Choose the control this exception waives.");
			if (!spec.waivable) reject(`${spec.label} cannot be waived by an exception.`);
		}
		if (content.rationale !== undefined && String(content.rationale).trim().length < 20) reject("Explain the risk and compensating measures (at least 20 characters).");
		if (content.expires_at !== undefined) {
			const t = Date.parse(String(content.expires_at));
			if (!Number.isFinite(t)) reject("Expires must be a date.");
		}
		return content;
	}

	if (collection === "grants") {
		if (!actor) return content;
		if (fromAi) reject("AI clients cannot draft grants.");
		if (actor.role < ROLE.EDITOR) reject("Editors and administrators draft grants; publishing one needs authority.grant.");
		const merged = { ...(current?.data ?? {}), ...content };
		const problems = grantProblems(merged);
		if (problems.length) reject(problems.join(" "));
		content.principal = String(merged.principal).trim();
		return content;
	}

	if (collection === "policies") {
		if (!actor) return content;
		if (fromAi) reject("AI clients cannot draft policies.");
		if (actor.role < ROLE.EDITOR) reject("Editors and administrators draft policies.");
		const merged = { ...(current?.data ?? {}), ...content };
		if (!/^people:[A-Z0-9-]{2,40}$/.test(String(merged.owner_principal ?? ""))) reject("The policy's owner is a person (people:PE-…).");
		if (merged.policy_state === "enforced" && String(merged.enforced_by ?? "").trim().length < 20) reject("Say which mechanism enforces this policy and how that was verified (at least 20 characters) before marking it enforced.");
		return content;
	}

	if (collection === "blueprints") {
		if ("steps" in content || "target_collection" in content || isNew) {
			const target = content.target_collection ?? current?.data.target_collection;
			const steps = "steps" in content ? content.steps : current?.data.steps;
			const { errors } = validateSteps(steps, target);
			if (errors.length) reject(`Blueprint steps are not valid: ${errors.slice(0, 4).join(" ")}`);
		}
		return content;
	}
	return content;
}

/** Extra checks for evidence that names an entity subject (called from policy.prepareEvidence). */
export async function prepareSubjectEvidence(content: Record<string, unknown>, actor: { id: string; role: number }): Promise<void> {
	const attests = typeof content.attests === "string" ? content.attests : null;
	const control = attests ? CONTROL_ATTESTATIONS[attests] : undefined;
	if (control && !content.subject) reject(`${attests} attestations need a subject (for example clients:CL-0001).`);
	if (!content.subject) return;
	content.subject = await subjectExists(content.subject);
	if (control) {
		if (actor.role < control.minRole) reject(`Only ${control.minRole >= ROLE.ADMIN ? "an administrator" : "an editor"} can record ${attests}.`);
	}
	if (content.identifier !== undefined && content.identifier !== null && content.identifier !== "") {
		const raw = String(content.identifier);
		const at = raw.indexOf(":");
		const parsed = parseIdentifiers([{ namespace: raw.slice(0, at), value: raw.slice(at + 1) }]);
		if (at <= 0 || parsed.errors.length) reject(`Identifier must be namespace:value, for example vat:PT123456789.`);
		const subject = parseSubject(content.subject)!;
		const reader = await getReader();
		const entity = await reader.resolve(subject.collection, subject.key, "published");
		const onRecord = parseIdentifiers(entity?.data.identifiers).identifiers.map(formatIdentifier);
		const name = formatIdentifier(parsed.identifiers[0]!);
		if (!onRecord.includes(name)) reject(`${name} is not a published identifier of ${formatSubject(subject.collection, subject.key)}.`);
		content.identifier = name;
	}
}

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

export interface PublishMarker {
	collection: string;
	id: string;
	group: string;
	key: string;
	from: Lifecycle | null;
	to: Lifecycle;
	actorId: string;
	role: number;
	at: string;
	identifiers: Array<{ namespace: string; value: string }>;
	mergedInto: string | null;
	mergeRationale: string | null;
}

export async function beforePublishEntity(event: ContentPolicyEvent, ctx: PluginContext): Promise<ContentPolicyDecision> {
	const { collection } = event;
	const origin = event.origin.source;
	if (origin === "mcp") return cancel(`${collection} can only be published by a person in the EmDash admin. AI clients may prepare drafts.`);

	if (collection === "work_items" || collection === "identifiers") {
		if (origin === "plugin" && event.origin.pluginId === PLUGIN_ID) return;
		if (!event.actor) return cancel(`${collection} are published by a person or by Powerfarm.`);
		if (collection === "identifiers" && event.actor.role < ROLE.ADMIN) return cancel("Only an administrator changes the identity registry.");
		if (collection === "identifiers") {
			const d = dataOf(event.content);
			const denied = await authorityRefusal(ctx as never, await getReader(), { actor: { id: event.actor.id, role: event.actor.role }, capability: "identity.admin", scope: String(d.subject ?? "identifiers"), what: `registry entry ${String(d.identifier ?? "")}` });
			if (denied) return cancel(denied);
		}
		return;
	}
	if (!event.actor) return cancel(`${collection} must be published by a signed-in person.`);
	const actor = { id: event.actor.id, role: event.actor.role };
	const data = dataOf(event.content);
	const id = String(event.content.id);
	const settings = await readSettings(ctx);
	const reader = await getReader();

	if (collection === "grants") {
		const denied = await grantPublishRefusal(ctx as never, reader, { ...actor, source: origin }, data, typeof event.content.authorId === "string" ? event.content.authorId : null, settings.requireSecondPerson);
		return denied ? cancel(denied) : undefined;
	}
	if (collection === "policies") {
		if (data.policy_state === "enforced" && String(data.enforced_by ?? "").trim().length < 20) return cancel("A policy marked enforced must say which mechanism enforces it and how that was verified.");
		const authorId = typeof event.content.authorId === "string" ? event.content.authorId : null;
		if (settings.requireSecondPerson && authorId === actor.id) return cancel("A second person must publish this policy: its author cannot.");
		const denied = await authorityRefusal(ctx as never, reader, { actor, capability: "policy.publish", scope: `policies:${String(data.code ?? id)}`, what: "publish policy" });
		return denied ? cancel(denied) : undefined;
	}
	if (collection === "blueprints") {
		if (actor.role < ROLE.ADMIN) return cancel("Only an administrator can activate a blueprint.");
		const { errors } = validateSteps(data.steps, data.target_collection);
		if (errors.length) return cancel(`Blueprint steps are not valid: ${errors.slice(0, 4).join(" ")}`);
		return;
	}

	if (collection === "exceptions") {
		if (actor.role < ROLE.ADMIN) return cancel("Only an administrator can accept a risk.");
		const authorId = typeof event.content.authorId === "string" ? event.content.authorId : null;
		if (settings.requireSecondPerson && (!authorId || authorId === actor.id)) return cancel("A second person must approve this exception: its author cannot.");
		const subject = parseSubject(data.subject);
		if (!subject || !(await reader.resolve(subject.collection, subject.key, "published"))) return cancel("The exception's subject must be a published record.");
		const spec = controlSpec(String(data.control ?? ""));
		if (!spec?.waivable) return cancel("That control cannot be waived.");
		const expires = Date.parse(String(data.expires_at ?? ""));
		if (!Number.isFinite(expires) || expires <= Date.now()) return cancel("An exception needs an expiry date in the future.");
		if (expires - Date.now() > 366 * 86_400_000) return cancel("Exceptions last at most one year; set an earlier expiry and review it then.");
		if (String(data.rationale ?? "").trim().length < 20) return cancel("Explain the risk and compensating measures (at least 20 characters).");
		return;
	}

	if (!isEntityCollection(collection)) return;
	const spec = ENTITY_TYPES[collection];
	if (PRINCIPAL_COLLECTIONS.has(collection)) {
		const denied = await authorityRefusal(ctx as never, reader, { actor, capability: "identity.admin", scope: `${collection}:${String(data.code ?? id)}`, what: `publish ${collection} (lifecycle ${String(data.lifecycle ?? "intake")})` });
		if (denied) return cancel(denied);
	}
	const live = await reader.resolve(collection, id, "published");
	const from: Lifecycle | null = live && isLifecycle(live.data.lifecycle) ? live.data.lifecycle : live ? "intake" : null;
	const to: Lifecycle = isLifecycle(data.lifecycle) ? data.lifecycle : "intake";
	if (!LIFECYCLE_TRANSITIONS[from ?? "none"].includes(to)) {
		return cancel(from === null ? "Register new records as intake first; activate them once their controls are met." : `A ${from} record cannot become ${to}.${from === "retired" ? " Retired is final: register a new record." : ""}`);
	}
	const classification = isClassification(data.classification) ? data.classification : null;
	if (!classification) return cancel("Set a classification.");
	if (actor.role < CLASSIFICATION_MIN_ROLE[classification]) return cancel(`You cannot publish ${classification} records.`);
	if (live && classificationRank(classification) < classificationRank(live.data.classification) && actor.role < ROLE.ADMIN) {
		return cancel("Only an administrator can lower a classification.");
	}

	// Evaluate what this publish would make live: draft values and staged references.
	const state = await loadEntityState(ctx, reader, collection, id, "draft", data);
	if (!state) return cancel("Record not found.");
	if (state.identifierErrors.length) return cancel(state.identifierErrors.join(" "));
	const stage = stageFor(from, to);
	// A merge: an administrator retires a duplicate into the record that survives.
	const mergingInto = typeof data.merged_into === "string" && data.merged_into && data.merged_into !== live?.data.merged_into ? data.merged_into.toUpperCase() : null;
	if (mergingInto) {
		if (actor.role < ROLE.ADMIN) return cancel("Only an administrator merges records.");
		if (to !== "retired") return cancel("A merged record is retired in the same publish: set Lifecycle to retired.");
		if (String(data.merge_rationale ?? "").trim().length < 20) return cancel("Explain the merge in Why it was merged (at least 20 characters).");
		const survivor = await reader.resolve(collection, mergingInto, "published");
		if (!survivor || survivor.group === state.entity.group) return cancel(`${mergingInto} is not another published ${collection.replace(/s$/, "").replace(/_/g, " ")}.`);
		if (survivor.data.merged_into) return cancel(`${mergingInto} was itself merged into ${String(survivor.data.merged_into)}; merge into that record.`);
	}
	if (mergingInto) {
		const blockers = await mergeBlockers(reader, collection, state.entity.group, state.subject);
		if (blockers.length) return cancel(`Before merging, point these at ${mergingInto} (or close them): ${blockers.slice(0, 8).join("; ")}${blockers.length > 8 ? `; and ${blockers.length - 8} more` : ""}.`);
	}
	// An ordinary edit of an active record must not take away a control it has now.
	if (from === "active" && to === "active" && live) {
		const before = await loadEntityState(ctx, reader, collection, id, "published");
		const missingBefore = new Set(before ? blocking(evaluate(before, "activation")).map((m) => m.control) : []);
		const lost = blocking(evaluate(state, "activation")).filter((m) => !missingBefore.has(m.control));
		if (lost.length) return cancel(`This change would leave an active record without: ${lost.map((m) => `${m.label} (${m.detail})`).join("; ")}. Keep them, or suspend the record first.`);
	}
	if (stage === "activation" || stage === "retirement") {
		const needed = stage === "retirement" ? ROLE.ADMIN : Math.max(spec.activationMinRole, classification === "restricted" ? ROLE.ADMIN : 0);
		if (actor.role < needed) return cancel(`${stage === "retirement" ? "Retiring" : "Activating"} this ${collection.replace(/s$/, "").replace(/_/g, " ")} needs ${needed >= ROLE.ADMIN ? "an administrator" : "an editor"}.`);
		if (stage === "activation") {
			if ((await auditState(ctx)).degraded) return cancel("The audit journal is degraded. Nothing is activated until an administrator acknowledges it.");
			const authorId = typeof event.content.authorId === "string" ? event.content.authorId : null;
			if (settings.requireSecondPerson && authorId === actor.id) return cancel("A second person must activate this record: its author cannot.");
		}
		// The administrator's merge, with its rationale, is the retirement approval.
		const missing = blocking(evaluate(state, stage)).filter((m) => !(mergingInto && m.control === "retirement_approved"));
		if (missing.length) return cancel(`Not ready for ${stage}: ${missing.map((m) => `${m.label} (${m.detail})`).join("; ")}`);
	}

	// Claim identifiers now, as `identifiers` entries: EmDash's unique index makes them unique across types.
	// A merged duplicate keeps its entries until afterPublish moves them to the survivor.
	if (!mergingInto) {
		const claimed = await claimAll(ctx, reader, state.subject, state.identifiers);
		if (!claimed.ok) {
			const c = claimed.conflicts[0]!;
			return cancel(`${formatIdentifier(c.identifier)} already identifies ${c.holder.subject}${c.holder.source === "transfer" ? " (transferred by an administrator); remove it from this record" : ""}.`);
		}
	}
	const marker: PublishMarker = { collection, id, group: state.entity.group, key: state.facts.key, from, to, actorId: actor.id, role: actor.role, at: new Date().toISOString(), identifiers: state.identifiers, mergedInto: mergingInto, mergeRationale: mergingInto ? String(data.merge_rationale) : null };
	await ctx.kv.set(`publish:${collection}:${id}`, marker);
}

export async function afterPublishEntity(event: { content: Record<string, unknown>; collection: string }, ctx: PluginContext): Promise<void> {
	const { collection } = event;
	if (!isEntityCollection(collection)) return;
	const id = String(event.content.id);
	const marker = await ctx.kv.get<PublishMarker>(`publish:${collection}:${id}`);
	await handlePublished(ctx, collection, id, marker);
}

/** Shared by afterPublish and reconciliation (a marker left behind means afterPublish did not finish). */
export async function handlePublished(ctx: PluginContext, collection: EntityCollection, id: string, marker: PublishMarker | null): Promise<void> {
	const reader = await getReader();
	const entity = await reader.resolve(collection, id, "published");
	if (!entity) return;
	const subject = formatSubject(collection, entity.key ?? entity.id);
	// Without the marker beforePublish wrote, what changed is unknown: change nothing, trigger nothing.
	if (!marker) {
		ctx.log.warn("Entity published without a Powerfarm publish marker; nothing triggered", { collection, id });
		return;
	}
	if (marker.mergedInto) {
		await moveAll(ctx, reader, subject, formatSubject(collection, marker.mergedInto), marker.mergeRationale ?? "");
	} else {
		await releaseDropped(ctx, reader, subject, parseIdentifiers(entity.data.identifiers).identifiers);
	}
	const from = marker.from;
	const to = isLifecycle(entity.data.lifecycle) ? entity.data.lifecycle : "intake";
	const triggers = [from === null ? "registered" : null, to === "active" && from !== "active" ? "activated" : null].filter((t): t is "registered" | "activated" => !!t);
	for (const trigger of triggers) {
		// oxlint-disable-next-line no-await-in-loop -- at most two triggers
		await startRuns(ctx as unknown as RunCtx, reader, { collection, subject: entity, trigger, initiatedBy: `user:${marker.actorId}` });
	}
	// 1.4: a person or agent leaving active status loses everything at once.
	if ((collection === "people" || collection === "agents") && (to === "suspended" || to === "retired") && from !== to) {
		await suspendPrincipal(ctx, reader, subject, to);
	}
	await ctx.kv.delete(`publish:${collection}:${id}`);
}

/**
 * After a person saves a work item, evidence or record, the runs of that subject
 * may move on (an approval given, a control met). Bounded and idempotent; the
 * `blueprints` cron task is the safety net.
 */
export async function afterSaveEntity(event: { collection: string; content: Record<string, unknown> }, ctx: PluginContext): Promise<void> {
	const { collection, content } = event;
	const data = dataOf(content);
	const reader = await getReader();
	if (collection === "work_items" || collection === "evidence" || collection === "exceptions") {
		const subject = typeof data.subject === "string" ? data.subject : null;
		if (subject) await advanceForSubject(ctx as unknown as RunCtx, reader, { subject });
	} else if (isEntityCollection(collection) && typeof content.id === "string") {
		const entity = await reader.resolve(collection, content.id, "draft");
		if (entity) await advanceForSubject(ctx as unknown as RunCtx, reader, { group: entity.group });
	}
}

/**
 * What still points at a duplicate that is about to be merged: live relations
 * with other records (its own owner aside) and open work about it. Those must be
 * re-pointed at the survivor by a person, in the editor, first — Powerfarm does
 * not rewrite other records' links. Closed work, evidence and history keep
 * naming the duplicate: that is what happened.
 */
export async function mergeBlockers(reader: ContentReader, collection: EntityCollection, group: string, subject: string): Promise<string[]> {
	const out: string[] = [];
	for (const e of await reader.readPort.edgesTouching([group])) {
		const mine = e.parent_group === group && e.parent_collection === collection;
		const otherCollection = mine ? e.child_collection : e.parent_collection;
		const otherGroup = mine ? e.child_group : e.parent_group;
		if (otherCollection === "people") continue; // the duplicate's owner
		// oxlint-disable-next-line no-await-in-loop -- a handful of edges
		const other = (await reader.byGroups(otherCollection as CollectionSlug, [otherGroup], "draft"))[0];
		out.push(`${otherCollection.replace(/_/g, " ")} ${other?.key ?? other?.title ?? otherGroup} (${e.relation})`);
	}
	for (const w of await reader.byField("work_items", "subject", [subject], "draft", 100)) {
		if (w.data.work_status === "open") out.push(`open work item ${w.key ?? w.title}`);
	}
	return out;
}

/** Registered records leave by retirement, never by deletion; anything a blueprint produced stays as history. */
export async function beforeDeleteEntity(event: { collection: string; id: string }): Promise<boolean> {
	// The registry keeps its history: an identifier moves by transfer, never by deleting it.
	if (event.collection === "identifiers") return false;
	const reader = await getReader();
	if (isEntityCollection(event.collection) || event.collection === "exceptions" || event.collection === "blueprints") {
		// EmDash keeps published_at when a record is unpublished, so "was ever published" survives an unpublish.
		const row = await reader.resolve(event.collection as CollectionSlug, event.id, "draft");
		if (row && (row.state === "published" || row.publishedAt)) return false;
	}
	if (event.collection === "work_items" || isEntityCollection(event.collection)) {
		const row = await reader.resolve(event.collection as CollectionSlug, event.id, "draft");
		if (row?.data.origin) return false;
	}
	return true;
}
