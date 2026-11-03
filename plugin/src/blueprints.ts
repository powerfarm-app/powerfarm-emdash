/**
 * Blueprint step definitions: a fixed, typed action catalogue, validated here
 * before a blueprint can be saved, published, or run.
 *
 * A blueprint is EmDash content (collection `blueprints`). Its `steps` field is
 * JSON that must match this module exactly: unknown actions, unknown keys,
 * forward or missing dependencies, oversized values and anything resembling an
 * expression are refused. There is no way to express code, HTTP, SQL, shell or
 * e-mail in a step. Placeholders are a closed list of subject fields.
 */

import { CONTROL_IDS, ENTITY_COLLECTIONS, isEntityCollection } from "./entities.js";
import { ROLE } from "./model.js";

export const ACTIONS = ["create_record", "create_task", "request_approval", "request_link", "wait_for_control", "record_provenance"] as const;
export type Action = (typeof ACTIONS)[number];
export const TRIGGERS = ["registered", "activated"] as const;
export type Trigger = (typeof TRIGGERS)[number];
export const PILLARS = ["identity", "authority", "security", "maintenance", "general"] as const;

/** Collections a `create_record` step may create (as drafts). */
export const CREATABLE: Readonly<Record<string, { fields: readonly string[]; references: readonly string[] }>> = {
	contracts: {
		fields: ["title", "contract_kind", "description", "notice_days", "classification", "review_cadence_days"],
		references: ["owner", "client", "products", "services"],
	},
	service_instances: {
		fields: ["title", "environment", "region", "description", "classification", "review_cadence_days"],
		references: ["owner", "service", "projects"],
	},
};

/** Placeholders a string may contain. Nothing else is substituted. */
export const PLACEHOLDERS = ["subject.title", "subject.key", "subject.ref", "subject.classification", "subject.collection"] as const;

/** Reference tokens: `$subject` or `$subject.<reference field>`. */
export const REFERENCE_TOKEN = /^\$subject(?:\.([a-z_]{1,40}))?$/;

export interface Condition {
	field?: string;
	reference?: string;
	equals?: string | number | boolean;
	in?: Array<string | number>;
	empty?: boolean;
}

export interface Step {
	id: string;
	action: Action;
	title?: string;
	description?: string;
	pillar?: (typeof PILLARS)[number];
	assignee?: string;
	dueInDays?: number;
	wait?: boolean;
	requiredRole?: number;
	separateFromInitiator?: boolean;
	collection?: string;
	fields?: Record<string, string | number | boolean>;
	references?: Record<string, string[]>;
	control?: string;
	timeoutDays?: number;
	retries?: number;
	dependsOn?: string[];
	when?: Condition;
}

const COMMON = ["id", "action", "dependsOn", "when", "retries"] as const;
const KEYS: Readonly<Record<Action, readonly string[]>> = {
	create_record: [...COMMON, "collection", "fields", "references", "title"],
	create_task: [...COMMON, "title", "description", "pillar", "assignee", "dueInDays", "wait"],
	request_approval: [...COMMON, "title", "description", "requiredRole", "separateFromInitiator", "dueInDays", "assignee"],
	request_link: [...COMMON, "title", "description", "pillar", "assignee", "dueInDays", "wait"],
	wait_for_control: [...COMMON, "control", "timeoutDays"],
	record_provenance: [...COMMON, "title", "description"],
};

const MAX_STEPS = 30;
const MAX_TEXT = 1000;
const ID = /^[a-z][a-z0-9_]{0,39}$/;
const EXPRESSION = /\$\{|`|<script|javascript:|=>|\beval\b|\bFunction\(/i;

function checkText(value: unknown, where: string, errors: string[], max = MAX_TEXT): void {
	if (value === undefined) return;
	if (typeof value !== "string") return void errors.push(`${where} must be text.`);
	if (value.length > max) errors.push(`${where} is longer than ${max} characters.`);
	if (EXPRESSION.test(value)) errors.push(`${where} contains something that looks like code; steps hold plain text only.`);
	for (const m of value.matchAll(/\{\{\s*([^}]*?)\s*\}\}/g)) {
		if (!(PLACEHOLDERS as readonly string[]).includes(m[1]!)) errors.push(`${where} uses an unknown placeholder {{${m[1]}}}. Allowed: ${PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}.`);
	}
}

function checkAssignee(value: unknown, where: string, errors: string[]): void {
	if (value === undefined) return;
	if (value !== "$subject.owner") errors.push(`${where} may only be "$subject.owner".`);
}

/** Validate a blueprint's steps for a target collection. Returns the typed steps or the errors. */
export function validateSteps(raw: unknown, targetCollection: unknown): { steps: Step[]; errors: string[] } {
	const errors: string[] = [];
	if (typeof targetCollection !== "string" || !isEntityCollection(targetCollection)) errors.push(`Applies to must be one of ${ENTITY_COLLECTIONS.join(", ")}.`);
	if (!Array.isArray(raw)) return { steps: [], errors: [...errors, "Steps must be a list."] };
	if (raw.length === 0) errors.push("A blueprint needs at least one step.");
	if (raw.length > MAX_STEPS) errors.push(`At most ${MAX_STEPS} steps.`);
	const seen = new Set<string>();
	const steps: Step[] = [];
	raw.slice(0, MAX_STEPS).forEach((item, index) => {
		const at = `Step ${index + 1}`;
		if (!item || typeof item !== "object" || Array.isArray(item)) return void errors.push(`${at} is not an object.`);
		const s = item as Record<string, unknown>;
		const id = s.id;
		if (typeof id !== "string" || !ID.test(id)) return void errors.push(`${at}: id must be lower-case letters, digits and _ (start with a letter).`);
		const where = `Step "${id}"`;
		if (seen.has(id)) errors.push(`${where}: id is used twice.`);
		const action = s.action as Action;
		if (!(ACTIONS as readonly string[]).includes(String(action))) return void errors.push(`${where}: unknown action "${String(s.action)}". Allowed: ${ACTIONS.join(", ")}.`);
		const unknown = Object.keys(s).filter((k) => !KEYS[action].includes(k));
		if (unknown.length) errors.push(`${where}: ${action} does not take ${unknown.join(", ")}.`);
		checkText(s.title, `${where} title`, errors, 200);
		checkText(s.description, `${where} description`, errors);
		checkAssignee(s.assignee, `${where} assignee`, errors);
		if (s.pillar !== undefined && !(PILLARS as readonly string[]).includes(String(s.pillar))) errors.push(`${where}: pillar must be one of ${PILLARS.join(", ")}.`);
		for (const [k, lo, hi] of [["dueInDays", 0, 365], ["timeoutDays", 1, 365], ["retries", 0, 3]] as const) {
			if (s[k] !== undefined && !(Number.isInteger(s[k]) && (s[k] as number) >= lo && (s[k] as number) <= hi)) errors.push(`${where}: ${k} must be a whole number from ${lo} to ${hi}.`);
		}
		for (const k of ["wait", "separateFromInitiator"] as const) if (s[k] !== undefined && typeof s[k] !== "boolean") errors.push(`${where}: ${k} must be true or false.`);
		if (Array.isArray(s.dependsOn)) {
			for (const d of s.dependsOn) if (typeof d !== "string" || !seen.has(d)) errors.push(`${where}: dependsOn "${String(d)}" must name an earlier step.`);
		} else if (s.dependsOn !== undefined) errors.push(`${where}: dependsOn must be a list of earlier step ids.`);
		if (s.when !== undefined) {
			const w = s.when as Record<string, unknown> | null;
			const keys = w && typeof w === "object" ? Object.keys(w) : [];
			if (!w || keys.some((k) => !["field", "reference", "equals", "in", "empty"].includes(k))) errors.push(`${where}: when takes field or reference, with equals, in or empty.`);
			else {
				if (!!w.field === !!w.reference) errors.push(`${where}: when needs exactly one of field or reference.`);
				if ((w.field !== undefined && (typeof w.field !== "string" || !/^[a-z_]{1,40}$/.test(w.field))) || (w.reference !== undefined && (typeof w.reference !== "string" || !/^[a-z_]{1,40}$/.test(w.reference)))) errors.push(`${where}: when names an invalid field.`);
				const tests = ["equals", "in", "empty"].filter((k) => w[k] !== undefined);
				if (tests.length !== 1) errors.push(`${where}: when needs exactly one of equals, in or empty.`);
				if (w.in !== undefined && !(Array.isArray(w.in) && w.in.length <= 20 && w.in.every((v) => typeof v === "string" || typeof v === "number"))) errors.push(`${where}: when.in must be a short list of values.`);
				if (w.empty !== undefined && typeof w.empty !== "boolean") errors.push(`${where}: when.empty must be true or false.`);
				if (w.reference !== undefined && w.equals !== undefined) errors.push(`${where}: a reference condition can only test empty.`);
			}
		}
		switch (action) {
			case "create_record": {
				const spec = typeof s.collection === "string" ? CREATABLE[s.collection] : undefined;
				if (!spec) {
					errors.push(`${where}: collection must be one of ${Object.keys(CREATABLE).join(", ")}.`);
					break;
				}
				const fields = (s.fields ?? {}) as Record<string, unknown>;
				if (typeof fields !== "object" || Array.isArray(fields)) errors.push(`${where}: fields must be an object.`);
				else {
					if (typeof fields.title !== "string") errors.push(`${where}: fields.title is required.`);
					for (const [k, v] of Object.entries(fields)) {
						if (!spec.fields.includes(k)) errors.push(`${where}: ${s.collection}.${k} cannot be set by a blueprint (allowed: ${spec.fields.join(", ")}).`);
						if (typeof v === "string") checkText(v, `${where} fields.${k}`, errors, 500);
						else if (typeof v !== "number" && typeof v !== "boolean") errors.push(`${where}: fields.${k} must be text, a number or true/false.`);
					}
				}
				const refs = (s.references ?? {}) as Record<string, unknown>;
				if (typeof refs !== "object" || Array.isArray(refs)) errors.push(`${where}: references must be an object.`);
				else
					for (const [k, v] of Object.entries(refs)) {
						if (!spec.references.includes(k)) errors.push(`${where}: ${s.collection}.${k} is not a reference a blueprint may set (allowed: ${spec.references.join(", ")}).`);
						if (!Array.isArray(v) || v.length === 0 || v.length > 5 || !v.every((t) => typeof t === "string" && REFERENCE_TOKEN.test(t))) errors.push(`${where}: references.${k} must list "$subject" or "$subject.<field>" tokens.`);
					}
				break;
			}
			case "create_task":
			case "request_link":
			case "request_approval":
				if (typeof s.title !== "string" || !s.title.trim()) errors.push(`${where}: title is required.`);
				if (action === "request_approval" && s.requiredRole !== undefined && s.requiredRole !== ROLE.EDITOR && s.requiredRole !== ROLE.ADMIN) errors.push(`${where}: requiredRole must be 40 (editor) or 50 (administrator).`);
				break;
			case "wait_for_control":
				if (typeof s.control !== "string" || !(CONTROL_IDS as readonly string[]).includes(s.control)) errors.push(`${where}: control must be one of ${CONTROL_IDS.join(", ")}.`);
				break;
			case "record_provenance":
				if (typeof s.title !== "string" || !s.title.trim()) errors.push(`${where}: title is required.`);
				break;
		}
		seen.add(id);
		steps.push(structuredClone(s) as unknown as Step);
	});
	return { steps: errors.length ? [] : steps, errors };
}

/** Substitute the closed placeholder list. Unknown placeholders were refused at validation. */
export function fill(template: string, subject: { title: string; key: string; collection: string; classification: string | null }): string {
	const values: Record<string, string> = {
		"subject.title": subject.title,
		"subject.key": subject.key,
		"subject.ref": `${subject.collection}:${subject.key}`,
		"subject.classification": subject.classification ?? "unclassified",
		"subject.collection": subject.collection,
	};
	return template.replace(/\{\{\s*([^}]*?)\s*\}\}/g, (_m, name: string) => values[name] ?? "");
}

/** Evaluate a step condition against the subject's data and reference selections. */
export function conditionHolds(when: Condition | undefined, data: Record<string, unknown>, references: Record<string, string[]>): boolean {
	if (!when) return true;
	if (when.reference) {
		const n = references[when.reference]?.length ?? 0;
		return when.empty === undefined ? true : when.empty ? n === 0 : n > 0;
	}
	const value = data[when.field!];
	if (when.empty !== undefined) {
		const isEmpty = value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
		return when.empty ? isEmpty : !isEmpty;
	}
	if (when.in) return when.in.some((v) => v === value);
	return value === when.equals;
}
