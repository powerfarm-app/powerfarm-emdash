/**
 * Test world for 1.2: the real plugin hooks over a SQLite database built from the
 * seed, with a content API that behaves like EmDash's plugin content access:
 *
 * - `create(collection, data, { references })` runs `content:beforeSave` with no
 *   actor (plugin origin), enforces seed `unique` fields and required reference
 *   fields, checks reference targets against the relation, and writes real
 *   `_emdash_content_references` edges (patch 0002 semantics).
 * - `publish` runs `content:beforePublish` with origin `plugin` and then
 *   `content:afterPublish`.
 * - People publish through `publishAs`, which runs the hooks with origin `api`
 *   (or `mcp`) and the actor, exactly as EmDash's publish pipeline would.
 */

import { afterChange, afterPublish, beforeDelete, beforePublish, beforeSave, beforeUnpublish } from "../src/policy.ts";
import { setReadPortFactory } from "../src/runtime.ts";
import { clearGraphCache } from "../src/graph.ts";
import { fakeCtx } from "./fake-ctx.ts";
import { TestDb } from "./sqlite-port.ts";

export const ADMIN = { id: "admin-1", role: 50 };
export const ADMIN2 = { id: "admin-2", role: 50 };
export const EDITOR = { id: "editor-1", role: 40 };
export const CONTRIBUTOR = { id: "contrib-1", role: 20 };
export const AI = { id: "ai-1", role: 40 };

export class CodedError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

type Row = Record<string, unknown> & { id: string; status: string; translation_group: string; live_revision_id: string | null };

export function makeWorld() {
	clearGraphCache();
	const db = new TestDb();
	setReadPortFactory(async () => db.port());
	const ctx = fakeCtx();
	let rev = 0;
	const creates: Record<string, number> = {};
	const failCreates: Record<string, number> = {};

	const fieldsOf = (collection: string) => db.seed.collections.find((c) => c.slug === collection)!.fields as Array<{ slug: string; type: string; required?: boolean; unique?: boolean; validation?: Record<string, unknown> }>;
	const row = (collection: string, id: string) => db.db.prepare(`select * from "ec_${collection}" where id = ?`).get(id) as Row | undefined;
	const groupOf = (collection: string, id: string) => row(collection, id)?.translation_group ?? null;

	function link(collection: string, group: string, field: string, targetIds: string[]) {
		const f = fieldsOf(collection).find((x) => x.slug === field);
		if (!f || f.type !== "reference") throw new CodedError("VALIDATION_ERROR", `${collection}.${field} is not a reference field`);
		const relation = String(f.validation!.relation);
		const side = f.validation!.relationSide === "child" ? "child" : "parent";
		const rel = db.seed.relations.find((r) => r.slug === relation)!;
		const target = side === "parent" ? rel.childCollection : rel.parentCollection;
		for (const id of targetIds) {
			const g = groupOf(target, id);
			if (!g) throw new CodedError("REFERENCE_NOT_FOUND", `${field}: ${id} is not an entry of ${target}`);
			if (side === "parent") db.link(relation, group, g);
			else db.link(relation, g, group);
		}
	}

	function insert(collection: string, data: Record<string, unknown>, status: string, authorId?: string) {
		const fields = fieldsOf(collection);
		for (const f of fields) {
			const v = data[f.slug];
			if (f.unique && v !== undefined && v !== null && v !== "") {
				const clash = db.db.prepare(`select id from "ec_${collection}" where "${f.slug}" = ?`).get(v as string);
				if (clash) throw new CodedError("CONFLICT", `UNIQUE constraint failed: ${collection}.${f.slug}`);
			}
		}
		const plain = Object.fromEntries(Object.entries(data).filter(([k]) => fields.some((f) => f.slug === k && f.type !== "reference")));
		return db.insert(collection, plain, { status, authorId });
	}

	const content = {
		async create(collection: string, data: Record<string, unknown>, options?: { references?: Record<string, string[]> }) {
			if ((failCreates[collection] ?? 0) > 0) {
				failCreates[collection]!--;
				throw new Error("database is locked");
			}
			const processed = (await beforeSave({ collection, content: { ...data }, isNew: true } as never, ctx as never)) as Record<string, unknown>;
			const fields = fieldsOf(collection);
			for (const f of fields) {
				if (f.type === "reference" && f.required && !options?.references?.[f.slug]?.length) throw new CodedError("VALIDATION_ERROR", `Field '${f.slug}' is required and must reference at least one entry.`);
			}
			const created = insert(collection, processed, "draft");
			for (const [field, ids] of Object.entries(options?.references ?? {})) link(collection, created.group, field, ids);
			creates[collection] = (creates[collection] ?? 0) + 1;
			return { id: created.id, type: collection, status: "draft", data: processed };
		},
		async get(collection: string, id: string) {
			const r = row(collection, id);
			return r ? { id, type: collection, status: r.status, data: r } : null;
		},
		async list(collection: string, options: { where?: { fieldFilters?: Record<string, unknown> }; limit?: number } = {}) {
			const ff = Object.entries(options.where?.fieldFilters ?? {});
			const where = ff.map(([k]) => `"${k}" = ?`).join(" and ") || "1=1";
			const rows = db.db.prepare(`select * from "ec_${collection}" where ${where} limit ?`).all(...(ff.map(([, v]) => v) as string[]), options.limit ?? 50) as Row[];
			return { items: rows.map((r) => ({ id: r.id, type: collection, status: r.status, data: r })), hasMore: false };
		},
		async getVersioned(collection: string, id: string) {
			const r = row(collection, id);
			return r ? { item: { id, status: r.status, data: r }, _rev: `${id}@${r.status}@${r.live_revision_id}` } : null;
		},
		async publish(collection: string, id: string) {
			const r = row(collection, id)!;
			const decision = await beforePublish({ collection, content: { id, data: r }, origin: { source: "plugin", pluginId: "powerfarm" } } as never, ctx as never);
			if (decision) throw new CodedError("PUBLISH_CANCELLED", String((decision as { reason: string }).reason));
			const live = `rev_${++rev}`;
			db.db.prepare(`update "ec_${collection}" set status='published', live_revision_id=?, draft_revision_id=?, published_at=? where id=?`).run(live, live, new Date().toISOString(), id);
			await afterPublish({ collection, content: { id, liveRevisionId: live, data: row(collection, id)! } }, ctx as never);
			return { item: { id, status: "published" }, _rev: live };
		},
		/** Plugin unpublish runs beforeUnpublish with origin plugin, like EmDash's. */
		async unpublish(collection: string, id: string) {
			const decision = await beforeUnpublish({ collection, content: { id, data: row(collection, id)! }, origin: { source: "plugin", pluginId: "powerfarm" } } as never, ctx as never);
			if (decision) throw new CodedError("UNPUBLISH_CANCELLED", String((decision as { reason: string }).reason));
			db.db.prepare(`update "ec_${collection}" set status='draft', live_revision_id=null where id=?`).run(id);
			return { item: { id, status: "draft" }, _rev: `${id}@draft` };
		},
		/** Plugin delete moves to the trash and runs no hooks, as in EmDash's plugin content access. */
		async delete(collection: string, id: string) {
			const r = row(collection, id);
			if (!r) return false;
			db.db.prepare(`update "ec_${collection}" set deleted_at = ? where id = ?`).run(new Date().toISOString(), id);
			return true;
		},
		async update(collection: string, id: string, data: Record<string, unknown>) {
			const sets = Object.keys(data).map((k) => `"${k}" = ?`).join(", ");
			db.db.prepare(`update "ec_${collection}" set ${sets} where id = ?`).run(...(Object.values(data).map((v) => (v !== null && typeof v === "object" ? JSON.stringify(v) : v)) as string[]), id);
			return { id, data };
		},
	};
	(ctx as unknown as { content: typeof content }).content = content;

	/** A person (or an AI client) saves a draft through EmDash's REST API: hooks run with the actor. */
	async function draftAs(actor: { id: string; role: number }, collection: string, data: Record<string, unknown>, references: Record<string, string[]> = {}, source = "api") {
		const processed = (await beforeSave({ collection, content: { ...data }, isNew: true, actor: { ...actor, source } } as never, ctx as never)) as Record<string, unknown>;
		const created = insert(collection, processed, "draft", actor.id);
		for (const [field, ids] of Object.entries(references)) link(collection, created.group, field, ids);
		await afterChange({ collection, content: { id: created.id, ...processed } }, ctx as never);
		return { id: created.id, group: created.group, data: processed };
	}

	const supportsDrafts = (collection: string) => ((db.seed.collections.find((c) => c.slug === collection) as { supports?: string[] }).supports ?? []).includes("drafts");
	const pendingDraft = (collection: string, id: string): Record<string, unknown> | null => {
		const r = row(collection, id)!;
		if (!r.draft_revision_id || r.draft_revision_id === r.live_revision_id) return null;
		const rev = db.db.prepare("select data from revisions where id = ?").get(r.draft_revision_id as string) as { data: string } | undefined;
		return rev ? (JSON.parse(rev.data) as Record<string, unknown>) : null;
	};

	/**
	 * Save changes to an existing record as a person (hooks run with the actor).
	 * Like EmDash, edits to a published entry of a collection with drafts are staged
	 * in a draft revision; live values change only when it is published.
	 */
	async function editAs(actor: { id: string; role: number }, collection: string, id: string, changes: Record<string, unknown>, source = "api") {
		const processed = (await beforeSave({ collection, content: { ...changes }, isNew: false, id, actor: { ...actor, source } } as never, ctx as never)) as Record<string, unknown>;
		const r = row(collection, id)!;
		if (r.status === "published" && supportsDrafts(collection)) {
			const merged = { ...(pendingDraft(collection, id) ?? {}), ...processed };
			const draftId = `rev_draft_${++rev}`;
			db.db.prepare("insert into revisions values (?, ?, ?, ?, ?, ?)").run(draftId, collection, id, JSON.stringify(merged), actor.id, new Date().toISOString());
			db.db.prepare(`update "ec_${collection}" set draft_revision_id=? where id=?`).run(draftId, id);
		} else await content.update(collection, id, processed);
		await afterChange({ collection, content: { id, ...row(collection, id)!, ...processed } }, ctx as never);
		return processed;
	}

	/** A person moves an entry to the trash through EmDash: beforeDelete may refuse. */
	async function trashAs(collection: string, id: string): Promise<boolean> {
		if (!(await beforeDelete({ collection, id, permanent: false } as never, ctx as never))) return false;
		return content.delete(collection, id);
	}

	/** A published blueprint, with the revision row EmDash keeps for the live version. */
	function publishedBlueprint(steps: unknown[], code = "BP-CLIENT-ONBOARDING", target = "clients", trigger = "registered") {
		const data = { title: code, code, target_collection: target, trigger, steps };
		const bp = db.insert("blueprints", data, { status: "published" });
		db.db.prepare("insert into revisions values (?, ?, ?, ?, ?, ?)").run(bp.liveRevisionId, "blueprints", bp.id, JSON.stringify(data), "admin-1", new Date().toISOString());
		return bp;
	}

	/** Publish as a person: beforePublish with the actor, then the draft goes live, then afterPublish. */
	async function publishAs(actor: { id: string; role: number }, collection: string, id: string, source = "api"): Promise<string | undefined> {
		const r = row(collection, id)!;
		const draft = pendingDraft(collection, id) ?? {};
		const columns = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^[[{]/.test(v) ? safeJson(v) : v]));
		const data = { ...columns, ...draft };
		const decision = await beforePublish({ collection, content: { id, authorId: r.author_id, data }, origin: { source }, actor: { ...actor, source } } as never, ctx as never);
		if (decision) return String((decision as { reason: string }).reason);
		if (Object.keys(draft).length) await content.update(collection, id, draft);
		const live = `rev_${++rev}`;
		db.db.prepare(`update "ec_${collection}" set status='published', live_revision_id=?, draft_revision_id=?, published_at=coalesce(published_at, ?) where id=?`).run(live, live, new Date().toISOString(), id);
		await afterPublish({ collection, content: { id, liveRevisionId: live, data } }, ctx as never);
		return undefined;
	}

	/** Unpublish as a person: like EmDash, the live revision is dropped and published_at is kept. */
	async function unpublishAs(actor: { id: string; role: number }, collection: string, id: string, source = "api"): Promise<string | undefined> {
		const decision = await beforeUnpublish({ collection, content: { id, data: row(collection, id) }, origin: { source }, actor: { ...actor, source } } as never, ctx as never);
		if (decision) return String((decision as { reason: string }).reason);
		db.db.prepare(`update "ec_${collection}" set status='draft', live_revision_id=null where id=?`).run(id);
		return undefined;
	}

	/** Record an attestation as a person, through the evidence hooks. */
	async function attest(actor: { id: string; role: number }, subject: string, attests: string, extra: Record<string, unknown> = {}) {
		return draftAs(actor, "evidence", { title: `${attests} for ${subject}`, evidence_type: "attestation", attests, subject, ...extra });
	}

	function setLiveColumns(collection: string, id: string, data: Record<string, unknown>) {
		return content.update(collection, id, data);
	}

	return { db, ctx, content, creates, failCreates, draftAs, editAs, publishAs, unpublishAs, trashAs, publishedBlueprint, attest, row, groupOf, link, setLiveColumns, insert };
}

function safeJson(v: string): unknown {
	try {
		return JSON.parse(v);
	} catch {
		return v;
	}
}

export type World = ReturnType<typeof makeWorld>;

/** A person with a people record, for owner and assignee references. */
export function person(w: World, title = "Ana Owner") {
	return w.db.insert("people", { title }, { status: "published" });
}
