/**
 * Onboarding blueprints, executed as EmDash content.
 *
 * A blueprint is EmDash content (`blueprints`). When an administrator publishes
 * it, EmDash stores that revision; a run reads its steps from exactly that
 * revision (`revisions` table), so editing the blueprint later changes nothing
 * in a started run.
 *
 * A run's state is not kept anywhere else: it is the work items, drafts and
 * notes it created, found by their `origin` (`<run>#<step>`). `origin` is a seed
 * `unique` field, so EmDash's database makes every creation happen once, also
 * when two workers or a retried hook race. Each pass re-derives the state and
 * creates whatever has become ready. KV holds only the run's small descriptor
 * (`onboarding:<run>`) so the cron task can find open runs.
 *
 * People act in EmDash's own editor: they mark tasks done, approve or reject
 * approvals (the save hook checks role and separation), and settle anything
 * that needs attention by choosing a decision on its work item. Publishing,
 * activating, signing and attesting stay with people. The runner
 * (`powerfarm:blueprint-runner`) creates drafts and work items only.
 */

import type { PluginContext } from "emdash";

import { conditionHolds, CREATABLE, fill, REFERENCE_TOKEN, type Step, type Trigger, validateSteps } from "./blueprints.js";
import type { ContentReader, Entity } from "./content.js";
import { evaluateControl, loadEntityState } from "./controls.js";
import { type ControlId, CONTROLS, ENTITY_TYPES, type EntityCollection, formatSubject, isEntityCollection, maxClassification } from "./entities.js";
import { readSettings } from "./jobs.js";
import { type CollectionSlug, ROLE } from "./model.js";
import { REFERENCE_FIELDS, RELATION_ENDS } from "./ontology.js";

export const RUNNER = "powerfarm:blueprint-runner";

export type RunStatus = "running" | "waiting_approval" | "waiting_input" | "succeeded" | "partially_failed" | "failed" | "needs_attention";
export const OPEN_RUN_STATUSES: readonly RunStatus[] = ["running", "waiting_approval", "waiting_input", "needs_attention"];
export type StepStatus = "pending" | "succeeded" | "skipped" | "waiting" | "failed" | "blocked" | "needs_attention";

/** The run descriptor in KV. Everything else is content. */
export interface RunMeta {
	key: string;
	trigger: Trigger;
	blueprintId: string;
	blueprintCode: string;
	templateRevision: string;
	subjectCollection: EntityCollection;
	subjectGroup: string;
	subjectKey: string;
	initiatedBy: string;
	createdAt: string;
	status: RunStatus;
	closedAt: string | null;
}

export interface StepView {
	id: string;
	action: Step["action"];
	status: StepStatus;
	message: string | null;
	ref: { collection: string; id: string; key: string | null } | null;
	attention: number;
}

export interface RunView extends RunMeta {
	steps: StepView[];
	definition: Step[];
}

type ContentWithWrite = NonNullable<PluginContext["content"]> & {
	create?: (collection: string, data: Record<string, unknown>, options?: { references?: Record<string, string[]> }) => Promise<{ id: string; data: Record<string, unknown> }>;
	getVersioned?: (collection: string, id: string) => Promise<{ _rev: string } | null>;
	publish?: (collection: string, id: string, options: { _rev: string }) => Promise<unknown>;
	update?: (collection: string, id: string, data: Record<string, unknown>) => Promise<unknown>;
};
export type RunCtx = Pick<PluginContext, "kv" | "log" | "settings"> & { content: ContentWithWrite };

const META = "onboarding:";

export function runKeyFor(trigger: Trigger, blueprintGroup: string, subjectGroup: string, subjectRevision: string | null): string {
	return trigger === "registered" ? `registered:${blueprintGroup}:${subjectGroup}` : `activated:${blueprintGroup}:${subjectGroup}:${subjectRevision ?? "none"}`;
}

const originOf = (run: string, step: string) => `${run}#${step}`;
const attentionOrigin = (run: string, step: string, n: number) => `${run}#${step}!attention:${n}`;

// ---------------------------------------------------------------------------
// Starting runs
// ---------------------------------------------------------------------------

/** Called from afterPublish (registration or activation). Creates the descriptor, then one pass. */
export async function startRuns(
	ctx: RunCtx,
	reader: ContentReader,
	input: { collection: EntityCollection; subject: Entity; trigger: Trigger; initiatedBy: string },
): Promise<string[]> {
	const blueprints = (await reader.byField("blueprints", "target_collection", [input.collection], "published", 50)).filter((b) => b.data.trigger === input.trigger);
	const started: string[] = [];
	for (const bp of blueprints) {
		if (!bp.liveRevisionId) continue;
		const meta: RunMeta = {
			key: runKeyFor(input.trigger, bp.group, input.subject.group, input.subject.liveRevisionId),
			trigger: input.trigger,
			blueprintId: bp.id,
			blueprintCode: bp.key ?? bp.id,
			templateRevision: bp.liveRevisionId,
			subjectCollection: input.collection,
			subjectGroup: input.subject.group,
			subjectKey: input.subject.key ?? input.subject.id,
			initiatedBy: input.initiatedBy,
			createdAt: new Date().toISOString(),
			status: "running",
			closedAt: null,
		};
		// oxlint-disable-next-line no-await-in-loop -- one CAS per blueprint: a repeated event starts nothing
		if (!(await ctx.kv.compareAndSet(META + meta.key, null, meta)).applied) continue;
		started.push(meta.key);
		// oxlint-disable-next-line no-await-in-loop
		await advanceRun(ctx, reader, meta.key).catch((error) => ctx.log.error("Onboarding pass failed; the scheduled task will retry", { run: meta.key, error: String(error) }));
	}
	return started;
}

export async function runMeta(ctx: Pick<PluginContext, "kv">, key: string): Promise<RunMeta | null> {
	return ctx.kv.get<RunMeta>(META + key);
}

export async function allRuns(ctx: Pick<PluginContext, "kv">): Promise<RunMeta[]> {
	return (await ctx.kv.list(META)).map((e) => e.value as RunMeta).filter((m) => m && typeof m.key === "string");
}

// ---------------------------------------------------------------------------
// Reading a run
// ---------------------------------------------------------------------------

/** The steps of the exact published blueprint revision the run started from. */
export async function stepsOf(reader: ContentReader, meta: RunMeta): Promise<{ steps: Step[]; error?: string }> {
	const revision = (await reader.readPort.revisionData([meta.templateRevision])).get(meta.templateRevision);
	if (!revision) return { steps: [], error: `Blueprint revision ${meta.templateRevision} is not in EmDash's revisions.` };
	const raw = typeof revision.steps === "string" ? safeJson(revision.steps) : revision.steps;
	const { steps, errors } = validateSteps(raw, revision.target_collection ?? meta.subjectCollection);
	return errors.length ? { steps: [], error: `Blueprint revision does not validate: ${errors[0]}` } : { steps };
}

function safeJson(v: string): unknown {
	try {
		return JSON.parse(v);
	} catch {
		return v;
	}
}

interface Items {
	byOrigin: Map<string, Entity>;
	attention: Map<string, Entity[]>;
}

async function itemsOf(reader: ContentReader, meta: RunMeta, steps: Step[]): Promise<Items> {
	const byOrigin = new Map<string, Entity>();
	const attention = new Map<string, Entity[]>();
	for (const w of await reader.byField("work_items", "run_id", [meta.key], "draft", 500)) {
		const origin = String(w.data.origin ?? "");
		const at = origin.indexOf("!attention:");
		if (at >= 0) {
			const step = origin.slice(meta.key.length + 1, at);
			(attention.get(step) ?? attention.set(step, []).get(step)!).push(w);
		} else byOrigin.set(origin, w);
	}
	for (const s of steps.filter((x) => x.action === "create_record")) {
		const [hit] = await reader.byField(s.collection as CollectionSlug, "origin", [originOf(meta.key, s.id)], "draft", 1);
		if (hit) byOrigin.set(originOf(meta.key, s.id), hit);
	}
	for (const list of attention.values()) list.sort((a, b) => attentionIndex(a) - attentionIndex(b));
	return { byOrigin, attention };
}

const attentionIndex = (e: Entity) => Number(String(e.data.origin).split("!attention:")[1] ?? 0);

function viewOf(meta: RunMeta, steps: Step[], items: Items): StepView[] {
	const out: StepView[] = [];
	const status = new Map<string, StepStatus>();
	for (const step of steps) {
		const attention = items.attention.get(step.id) ?? [];
		const latest = attention.at(-1);
		const item = items.byOrigin.get(originOf(meta.key, step.id));
		const ref = item ? { collection: item.collection, id: item.id, key: item.key } : latest ? { collection: "work_items", id: latest.id, key: latest.key } : null;
		let s: StepStatus = "pending";
		let message: string | null = null;
		if (item) {
			const ws = String(item.data.work_status ?? "");
			if (item.collection !== "work_items") s = "succeeded";
			else if (ws === "skipped") s = "skipped";
			else if (step.action === "request_approval" || step.action === "wait_for_control" || step.wait) {
				s = ws === "done" ? "succeeded" : ws === "rejected" || ws === "cancelled" ? "failed" : "waiting";
			} else s = ws === "cancelled" ? "failed" : "succeeded";
			message = typeof item.data.resolution === "string" ? item.data.resolution : null;
		}
		// An open attention item always wins; a person's closing decision settles a step that did not complete.
		if (latest) {
			const ws = String(latest.data.work_status ?? "open");
			const decision = String(latest.data.decision ?? "");
			if (ws === "open") {
				s = "needs_attention";
				message = typeof latest.data.description === "string" ? latest.data.description : "Needs attention";
			} else if (decision === "done_by_hand") {
				s = "succeeded";
				message = typeof latest.data.resolution === "string" ? latest.data.resolution : message;
			} else if (decision === "give_up") {
				s = "failed";
				message = typeof latest.data.resolution === "string" ? latest.data.resolution : message;
			} else if (!item) s = "pending"; // retry: run it again (a created record keeps its own status; advanceRun re-checks it)
		}
		if (s === "pending") {
			const deps = (step.dependsOn ?? []).map((d) => status.get(d));
			if (deps.some((d) => d === "failed" || d === "blocked")) {
				s = "blocked";
				message = "A step it depends on did not succeed.";
			}
		}
		status.set(step.id, s);
		out.push({ id: step.id, action: step.action, status: s, message, ref, attention: attention.length });
	}
	return out;
}

export function summarise(steps: readonly Pick<StepView, "status" | "action">[]): RunStatus {
	if (steps.some((s) => s.status === "needs_attention")) return "needs_attention";
	if (steps.every((s) => ["succeeded", "skipped", "failed", "blocked"].includes(s.status))) {
		if (!steps.some((s) => s.status === "failed" || s.status === "blocked")) return "succeeded";
		return steps.some((s) => s.status === "succeeded") ? "partially_failed" : "failed";
	}
	const waiting = steps.filter((s) => s.status === "waiting");
	if (waiting.length > 0) return waiting.some((w) => w.action === "request_approval") ? "waiting_approval" : "waiting_input";
	return "running";
}

export async function viewRun(ctx: Pick<PluginContext, "kv">, reader: ContentReader, key: string): Promise<RunView | null> {
	const meta = await runMeta(ctx, key);
	if (!meta) return null;
	const { steps } = await stepsOf(reader, meta);
	const items = await itemsOf(reader, meta, steps);
	return { ...meta, steps: viewOf(meta, steps, items), definition: steps };
}

export async function runsForSubject(ctx: Pick<PluginContext, "kv">, reader: ContentReader, subjectGroup: string): Promise<RunView[]> {
	const out: RunView[] = [];
	for (const m of (await allRuns(ctx)).filter((r) => r.subjectGroup === subjectGroup)) {
		// oxlint-disable-next-line no-await-in-loop
		const v = await viewRun(ctx, reader, m.key);
		if (v) out.push(v);
	}
	return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---------------------------------------------------------------------------
// Advancing a run
// ---------------------------------------------------------------------------

interface Subject {
	entity: Entity;
	references: Record<string, string[]>;
	collection: EntityCollection;
	key: string;
	classification: string | null;
}

function textOf(subject: Subject, template: string | undefined, fallback: string): string {
	return fill(template ?? fallback, { title: subject.entity.title, key: subject.key, collection: subject.collection, classification: subject.classification }).slice(0, 500);
}

function targetOf(collection: string, field: string): CollectionSlug | null {
	const spec = REFERENCE_FIELDS[`${collection}.${field}`];
	const ends = spec ? RELATION_ENDS[spec.relation] : undefined;
	if (!spec || !ends) return null;
	return spec.side === "parent" ? ends.child : ends.parent;
}

/** Resolve `$subject` / `$subject.<field>` to entry ids, checking target collections. */
export async function resolveReferenceTokens(reader: ContentReader, subject: Subject, createdCollection: string, field: string, tokens: readonly string[]): Promise<{ ids: string[]; error?: string }> {
	const target = targetOf(createdCollection, field);
	if (!target) return { ids: [], error: `${createdCollection}.${field} is not a reference field.` };
	const ids: string[] = [];
	for (const token of tokens) {
		const m = REFERENCE_TOKEN.exec(token);
		if (!m) return { ids: [], error: `Unknown token ${token}` };
		if (!m[1]) {
			if (subject.collection !== target) return { ids: [], error: `${createdCollection}.${field} points at ${target}, but the subject is a ${subject.collection} record.` };
			ids.push(subject.entity.id);
			continue;
		}
		const source = targetOf(subject.collection, m[1]);
		if (!source) return { ids: [], error: `${subject.collection} has no reference field ${m[1]}.` };
		if (source !== target) return { ids: [], error: `${createdCollection}.${field} points at ${target}, but ${token} holds ${source}.` };
		// oxlint-disable-next-line no-await-in-loop -- at most five tokens
		for (const e of await reader.byGroups(target, subject.references[m[1]] ?? [], "published")) ids.push(e.id);
	}
	return { ids: [...new Set(ids)] };
}

/** Reference fields whose requested edges are not in EmDash's relation table after a create. */
async function missingReferences(reader: ContentReader, collection: CollectionSlug, id: string, refs: Record<string, string[]>): Promise<string[]> {
	if (Object.keys(refs).length === 0) return [];
	const rows = await reader.readPort.rows(collection, { ids: [id], limit: 1 });
	const group = rows[0]?.translation_group ?? rows[0]?.id;
	if (!group) return Object.keys(refs);
	const edges = await reader.readPort.edgesTouching([group]);
	return Object.keys(refs).filter((field) => {
		const spec = REFERENCE_FIELDS[`${collection}.${field}`];
		return !spec || !edges.some((e) => e.relation === spec.relation && (spec.side === "parent" ? e.parent_group === group : e.child_group === group));
	});
}

async function publishEntry(ctx: RunCtx, collection: string, id: string): Promise<void> {
	if (!ctx.content.getVersioned || !ctx.content.publish) return;
	const v = await ctx.content.getVersioned(collection, id);
	if (v) await ctx.content.publish(collection, id, { _rev: v._rev });
}

class StepError extends Error {}

/** Create once: EmDash's unique `origin` index makes a racing or repeated create fail; the winner is looked up. */
async function createOnce(ctx: RunCtx, reader: ContentReader, collection: CollectionSlug, origin: string, data: Record<string, unknown>, references: Record<string, string[]>, publish: boolean): Promise<Entity> {
	const find = async () => (await reader.byField(collection, "origin", [origin], "draft", 1))[0] ?? null;
	const refs0 = Object.fromEntries(Object.entries(references).filter(([, ids]) => ids.length > 0));
	const existing = await find();
	if (existing) {
		// Created before (a retry, or another worker): it must still carry the links it asked for.
		const missing = await missingReferences(reader, collection, existing.id, refs0);
		if (missing.length) throw new StepError(`The ${collection} draft ${existing.key ?? existing.id} lacks ${missing.join(", ")}. Link it in the editor, then retry; or apply upstream/patches/0002.`);
		return existing;
	}
	if (!ctx.content.create) throw new StepError("content:write is not granted to Powerfarm.");
	const refs = Object.fromEntries(Object.entries(references).filter(([, ids]) => ids.length > 0));
	let createdId: string;
	try {
		createdId = (await ctx.content.create(collection, { ...data, origin }, Object.keys(refs).length ? { references: refs } : undefined)).id;
	} catch (error) {
		const winner = await find();
		if (winner) return winner;
		throw error;
	}
	// An EmDash without upstream/patches/0002 accepts the call but drops the references.
	const missing = await missingReferences(reader, collection, createdId, refs);
	if (missing.length) throw new StepError(`EmDash did not record ${missing.join(", ")} on the created ${collection} draft. Apply upstream/patches/0002, then link it by hand in the editor.`);
	if (publish) await publishEntry(ctx, collection, createdId);
	return (await find())!;
}

function workItemData(meta: RunMeta, step: Step, subject: Subject, extra: Record<string, unknown>): Record<string, unknown> {
	return {
		title: textOf(subject, step.title, step.id),
		work_kind: "task",
		pillar: step.pillar ?? "general",
		work_status: "open",
		subject: formatSubject(subject.collection, subject.key),
		due_at: step.dueInDays !== undefined ? new Date(Date.now() + step.dueInDays * 86_400_000).toISOString() : null,
		description: step.description ? textOf(subject, step.description, "") : null,
		run_id: meta.key,
		step_id: step.id,
		blueprint_code: meta.blueprintCode,
		blueprint_revision: meta.templateRevision,
		initiated_by: meta.initiatedBy,
		...extra,
	};
}

async function execute(ctx: RunCtx, reader: ContentReader, meta: RunMeta, step: Step, subject: Subject, settings: { requireSecondPerson: boolean }): Promise<void> {
	const origin = originOf(meta.key, step.id);
	if (!conditionHolds(step.when, subject.entity.data, subject.references)) {
		await createOnce(ctx, reader, "work_items", origin, workItemData(meta, step, subject, { title: `Skipped: ${textOf(subject, step.title, step.id)}`, work_kind: "note", work_status: "skipped", resolution: "Condition not met for this record." }), {}, true);
		return;
	}
	const assignee = async (): Promise<Record<string, string[]>> => {
		if (step.assignee !== "$subject.owner") return {};
		const r = await resolveReferenceTokens(reader, subject, "work_items", "assignee", ["$subject.owner"]);
		return r.ids.length ? { assignee: r.ids.slice(0, 1) } : {};
	};
	switch (step.action) {
		case "create_task":
		case "request_link":
			await createOnce(ctx, reader, "work_items", origin, workItemData(meta, step, subject, { work_kind: step.action === "request_link" ? "link_request" : "task" }), await assignee(), true);
			return;
		case "request_approval":
			await createOnce(
				ctx,
				reader,
				"work_items",
				origin,
				workItemData(meta, step, subject, { work_kind: "approval", pillar: step.pillar ?? "authority", required_role: step.requiredRole ?? ROLE.ADMIN, separate_from_initiator: !!step.separateFromInitiator || settings.requireSecondPerson }),
				await assignee(),
				true,
			);
			return;
		case "wait_for_control": {
			const state = await loadEntityState(null, reader, subject.collection, subject.entity.group, "published");
			const result = state ? evaluateControl(state, step.control as ControlId) : null;
			const met = result?.status === "met" || result?.status === "waived";
			await createOnce(
				ctx,
				reader,
				"work_items",
				origin,
				workItemData(meta, step, subject, {
					title: `${CONTROLS[step.control as ControlId].label}: ${subject.entity.title}`,
					work_kind: "control",
					pillar: CONTROLS[step.control as ControlId].pillar,
					control: step.control,
					work_status: met ? "done" : "open",
					resolution: met ? `Already ${result!.status}: ${result!.detail}` : null,
					resolved_by: met ? RUNNER : null,
					resolved_at: met ? new Date().toISOString() : null,
					description: `Closes by itself when the control is met (${result?.detail ?? "not evaluated"}).`,
				}),
				{},
				true,
			);
			return;
		}
		case "create_record": {
			const collection = step.collection as "contracts" | "service_instances";
			if (!CREATABLE[collection]) throw new StepError(`${collection} cannot be created by a blueprint.`);
			const fields: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(step.fields ?? {})) fields[k] = typeof v === "string" ? textOf(subject, v, "") : v;
			fields.classification = maxClassification(maxClassification(fields.classification, subject.classification), ENTITY_TYPES[collection].defaultClassification);
			fields.lifecycle = "intake";
			const references: Record<string, string[]> = {};
			for (const [field, tokens] of Object.entries(step.references ?? {})) {
				// oxlint-disable-next-line no-await-in-loop -- few reference fields
				const r = await resolveReferenceTokens(reader, subject, collection, field, tokens);
				if (r.error) throw new StepError(r.error);
				references[field] = r.ids;
			}
			await createOnce(ctx, reader, collection, origin, fields, references, false);
			return;
		}
		case "record_provenance":
			await createOnce(ctx, reader, "work_items", origin, workItemData(meta, step, subject, { work_kind: "note", work_status: "done", resolution: step.description ? textOf(subject, step.description, "") : "Recorded", resolved_by: RUNNER, resolved_at: new Date().toISOString() }), {}, true);
			return;
	}
}

async function raiseAttention(ctx: RunCtx, reader: ContentReader, meta: RunMeta, step: Step, subject: Subject | null, n: number, message: string): Promise<void> {
	const title = `Needs attention: ${meta.blueprintCode} · ${step.id}`;
	await createOnce(
		ctx,
		reader,
		"work_items",
		attentionOrigin(meta.key, step.id, n),
		{
			title,
			work_kind: "attention",
			pillar: "general",
			work_status: "open",
			subject: subject ? formatSubject(subject.collection, subject.key) : formatSubject(meta.subjectCollection, meta.subjectKey),
			required_role: ROLE.ADMIN,
			description: `${message.slice(0, 900)}\nChoose a decision: retry (after fixing the cause), done_by_hand, or give_up.`,
			run_id: meta.key,
			step_id: step.id,
			blueprint_code: meta.blueprintCode,
			blueprint_revision: meta.templateRevision,
			initiated_by: meta.initiatedBy,
		},
		{},
		true,
	);
}

/**
 * One pass: derive the state from content, close control items whose control is
 * now met, create every step that has become ready, and repeat until nothing
 * changes. Safe to run concurrently and repeatedly.
 */
export async function advanceRun(ctx: RunCtx, reader: ContentReader, key: string, now = Date.now()): Promise<RunView | null> {
	const meta = await runMeta(ctx, key);
	if (!meta) return null;
	const { steps, error } = await stepsOf(reader, meta);
	const settings = await readSettings(ctx as never);
	const state = await loadEntityState(null, reader, meta.subjectCollection, meta.subjectGroup, "published");
	const subject: Subject | null = state ? { entity: state.entity, references: state.facts.references, collection: meta.subjectCollection, key: state.facts.key, classification: state.facts.classification } : null;
	if (error || !subject) {
		ctx.log.warn("Onboarding run cannot proceed", { run: key, reason: error ?? "subject not published" });
		await ctx.kv.set(META + key, { ...meta, status: "needs_attention" });
		return { ...meta, status: "needs_attention", steps: [], definition: steps };
	}

	for (let pass = 0; pass <= steps.length; pass++) {
		const items = await itemsOf(reader, meta, steps);
		const view = viewOf(meta, steps, items);
		let changed = false;
		for (const step of steps) {
			const v = view.find((x) => x.id === step.id)!;
			// Close a waiting control item once its control is met (or raise attention on timeout).
			if (step.action === "wait_for_control" && v.status === "waiting" && v.ref && state) {
				const result = evaluateControl(state, step.control as ControlId, now);
				if (result.status === "met" || result.status === "waived") {
					await ctx.content.update?.("work_items", v.ref.id, { work_status: "done", resolution: `${result.status}: ${result.detail}`, resolved_by: RUNNER, resolved_at: new Date(now).toISOString() });
					changed = true;
				} else if (step.timeoutDays !== undefined) {
					const item = items.byOrigin.get(originOf(meta.key, step.id));
					const since = item?.createdAt ? Date.parse(item.createdAt) : now;
					if (now - since > step.timeoutDays * 86_400_000 && v.attention === 0) {
						await raiseAttention(ctx, reader, meta, step, subject, 1, `${CONTROLS[step.control as ControlId].label} still not met after ${step.timeoutDays} days.`);
						changed = true;
					}
				}
				continue;
			}
			// Retried after a person linked a draft by hand: check the links are really there now.
			if (step.action === "create_record" && v.status === "succeeded" && v.attention > 0) {
				const latest = items.attention.get(step.id)!.at(-1)!;
				const item = items.byOrigin.get(originOf(meta.key, step.id));
				if (item && latest.data.work_status !== "open" && latest.data.decision === "retry") {
					try {
						await execute(ctx, reader, meta, step, subject, settings);
					} catch (e) {
						await raiseAttention(ctx, reader, meta, step, subject, v.attention + 1, e instanceof Error ? e.message : String(e));
						changed = true;
					}
				}
				continue;
			}
			if (v.status !== "pending") continue;
			const deps = (step.dependsOn ?? []).map((d) => view.find((x) => x.id === d)!.status);
			if (!deps.every((d) => d === "succeeded" || d === "skipped")) continue;
			const attempts = 1 + (step.retries ?? 1);
			let last: unknown = null;
			for (let attempt = 0; attempt < attempts; attempt++) {
				try {
					// oxlint-disable-next-line no-await-in-loop -- retries of one step
					await execute(ctx, reader, meta, step, subject, settings);
					last = null;
					break;
				} catch (e) {
					last = e;
					if (e instanceof StepError) break;
				}
			}
			if (last) await raiseAttention(ctx, reader, meta, step, subject, v.attention + 1, last instanceof Error ? last.message : String(last));
			changed = true;
		}
		if (!changed) break;
	}
	const final = await viewRun(ctx, reader, key);
	if (final) {
		const status = summarise(final.steps);
		const closed = !OPEN_RUN_STATUSES.includes(status);
		await ctx.kv.set(META + key, { ...meta, status, closedAt: closed ? (meta.closedAt ?? new Date(now).toISOString()) : null });
		return { ...final, status, closedAt: closed ? (meta.closedAt ?? new Date(now).toISOString()) : null };
	}
	return final;
}

/** Re-advance the runs of a subject after a person changed something (work item, evidence, record). */
export async function advanceForSubject(ctx: RunCtx, reader: ContentReader, subjectGroupOrRef: { group?: string; subject?: string }): Promise<number> {
	let n = 0;
	for (const m of await allRuns(ctx)) {
		if (m.closedAt && m.status !== "needs_attention") continue;
		const matches = subjectGroupOrRef.group ? m.subjectGroup === subjectGroupOrRef.group : formatSubject(m.subjectCollection, m.subjectKey) === subjectGroupOrRef.subject;
		if (!matches) continue;
		// oxlint-disable-next-line no-await-in-loop
		await advanceRun(ctx, reader, m.key);
		n++;
	}
	return n;
}

/** The `blueprints` cron task: advance every open run. */
export async function processRuns(ctx: RunCtx, reader: ContentReader, budgetMs = 40_000): Promise<{ advanced: number; open: number }> {
	const started = Date.now();
	const open = (await allRuns(ctx)).filter((m) => !m.closedAt || m.status === "needs_attention");
	let advanced = 0;
	for (const m of open) {
		if (Date.now() - started > budgetMs) break;
		// oxlint-disable-next-line no-await-in-loop
		await advanceRun(ctx, reader, m.key);
		advanced++;
	}
	return { advanced, open: open.length };
}

// ---------------------------------------------------------------------------
// People's decisions, enforced in EmDash's save hook (see entity-policy.ts)
// ---------------------------------------------------------------------------

/** Why a person may not make this change to a blueprint-created work item, or null. */
export function workItemChangeRefusal(
	current: Record<string, unknown>,
	change: Record<string, unknown>,
	actor: { id: string; role: number; source?: string },
	settings: { requireSecondPerson: boolean },
): string | null {
	if (actor.source === "mcp") return "AI clients cannot change work items.";
	const kind = String(current.work_kind ?? "task");
	for (const f of ["run_id", "step_id", "blueprint_code", "blueprint_revision", "initiated_by", "separate_from_initiator", "required_role", "control", "work_kind", "subject", "origin", "resolved_by", "resolved_at"]) {
		if (f in change && String(change[f] ?? "") !== String(current[f] ?? "")) return `${f} is maintained by Powerfarm.`;
	}
	const from = String(current.work_status ?? "open");
	const to = "work_status" in change ? String(change.work_status) : from;
	const decision = "decision" in change ? String(change.decision ?? "") : String(current.decision ?? "");
	const note = String(("resolution" in change ? change.resolution : current.resolution) ?? "").trim();
	if (from !== "open" && to !== from) return "This work item is closed.";
	if (from === to) return null;
	switch (kind) {
		case "approval": {
			const required = Number(current.required_role ?? ROLE.ADMIN);
			if (actor.role < required) return `This approval needs ${required >= ROLE.ADMIN ? "an administrator" : "an editor"}.`;
			const separate = current.separate_from_initiator === true || current.separate_from_initiator === 1 || settings.requireSecondPerson;
			if (separate && current.initiated_by === `user:${actor.id}`) return "The person who approved the registration cannot also give this approval.";
			if (!((to === "done" && decision === "approve") || (to === "rejected" && decision === "reject"))) return "Approve: set Decision to approve and Status to done. Reject: Decision reject, Status rejected.";
			if (note.length < 5) return "Give a reason in Resolution note (at least 5 characters).";
			return null;
		}
		case "attention":
			if (actor.role < ROLE.ADMIN) return "Only an administrator settles a step that needs attention.";
			if (to !== "done" || !["retry", "done_by_hand", "give_up"].includes(decision)) return "Choose a Decision (retry, done_by_hand or give_up) and set Status to done.";
			if (note.length < 10) return "Describe what you checked in Resolution note (at least 10 characters).";
			return null;
		case "control":
			return "This closes by itself when the control is met. Record the attestation instead, or settle the run's attention item.";
		case "note":
			return "Notes are a record; they are not changed.";
		default:
			if (actor.role < ROLE.EDITOR) return "Editors and administrators close work items.";
			if (!["done", "cancelled"].includes(to)) return "Set Status to done or cancelled.";
			return null;
	}
}

// ---------------------------------------------------------------------------
// Preview (simulation): reads only, writes nothing, counts for nothing
// ---------------------------------------------------------------------------

export interface PreviewStep {
	id: string;
	action: Step["action"];
	outcome: "would_run" | "would_skip" | "would_wait" | "would_fail";
	detail: string;
	dependsOn: string[];
}

export async function previewRun(reader: ContentReader, blueprint: Entity, subjectCollection: string, subjectRef: string) {
	const { steps, errors } = validateSteps(blueprint.data.steps, blueprint.data.target_collection);
	const base = { simulated: true as const, blueprint: blueprint.key ?? blueprint.id, templateRevision: blueprint.liveRevisionId };
	if (!isEntityCollection(subjectCollection) || blueprint.data.target_collection !== subjectCollection) {
		return { ...base, subject: subjectRef, errors: [...errors, `This blueprint applies to ${String(blueprint.data.target_collection)}.`], steps: [] as PreviewStep[] };
	}
	const state = await loadEntityState(null, reader, subjectCollection, subjectRef, "draft");
	if (!state) return { ...base, subject: subjectRef, errors: [...errors, "Subject not found."], steps: [] as PreviewStep[] };
	const subject: Subject = { entity: state.entity, references: state.facts.references, collection: subjectCollection, key: state.facts.key, classification: state.facts.classification };
	const out: PreviewStep[] = [];
	for (const step of steps) {
		const deps = step.dependsOn ?? [];
		if (!conditionHolds(step.when, state.entity.data, state.facts.references)) {
			out.push({ id: step.id, action: step.action, outcome: "would_skip", detail: "Condition not met for this record.", dependsOn: deps });
			continue;
		}
		switch (step.action) {
			case "create_record": {
				const problems: string[] = [];
				const refs: string[] = [];
				for (const [field, tokens] of Object.entries(step.references ?? {})) {
					// oxlint-disable-next-line no-await-in-loop
					const r = await resolveReferenceTokens(reader, subject, step.collection!, field, tokens);
					if (r.error) problems.push(r.error);
					else refs.push(`${field}: ${r.ids.length} selected`);
				}
				const cls = maxClassification(maxClassification(step.fields?.classification, subject.classification), ENTITY_TYPES[step.collection as "contracts"].defaultClassification);
				out.push(problems.length ? { id: step.id, action: step.action, outcome: "would_fail", detail: problems.join(" "), dependsOn: deps } : { id: step.id, action: step.action, outcome: "would_run", detail: `Draft ${step.collection} "${textOf(subject, String(step.fields?.title ?? ""), "")}" (intake, ${cls}); ${refs.join(", ") || "no references"}`, dependsOn: deps });
				break;
			}
			case "create_task":
			case "request_link":
				out.push({ id: step.id, action: step.action, outcome: step.wait ? "would_wait" : "would_run", detail: `Work item "${textOf(subject, step.title, step.id)}"${step.wait ? ", then wait until it is done" : ""}`, dependsOn: deps });
				break;
			case "request_approval":
				out.push({ id: step.id, action: step.action, outcome: "would_wait", detail: `Approval "${textOf(subject, step.title, step.id)}" by ${(step.requiredRole ?? ROLE.ADMIN) >= ROLE.ADMIN ? "an administrator" : "an editor"}`, dependsOn: deps });
				break;
			case "wait_for_control": {
				const result = evaluateControl(state, step.control as ControlId);
				const met = result.status === "met" || result.status === "waived";
				out.push({ id: step.id, action: step.action, outcome: met ? "would_run" : "would_wait", detail: `${result.label}: ${result.status}`, dependsOn: deps });
				break;
			}
			case "record_provenance":
				out.push({ id: step.id, action: step.action, outcome: "would_run", detail: `Note: "${textOf(subject, step.title, step.id)}"`, dependsOn: deps });
				break;
		}
	}
	return { ...base, subject: formatSubject(subjectCollection, state.facts.key), errors, steps: out };
}
