/**
 * The only place Powerfarm reads EmDash's internal tables.
 *
 * EmDash's plugin context exposes content reads but not relation edges, staged
 * references or a way to page content by field. The graph needs those, so this
 * module defines a narrow, read-only port and implements it over EmDash's own
 * Kysely handle (`getDb()` from `emdash/runtime`, the handle EmDash's loader uses).
 *
 * Rules for this file:
 * - SELECT only. All writes go through `ctx.content`, `ctx.storage` or `ctx.media`
 *   so EmDash's validation, hooks, revisions and staged-reference promotion apply.
 * - No raw SQL strings and no caller-supplied identifiers reach the query
 *   builder unvalidated: collections must be Powerfarm collections and field
 *   names must exist in EmDash's field registry.
 * - Nothing outside this file imports `emdash/runtime` or knows table names.
 *
 * Tables read (EmDash 1.4.0, commit 981c78d, migrations up to 092):
 *   ec_<collection>               content rows; columns hold live values for collections with drafts
 *   revisions                     draft snapshots (data JSON, including staged `_references`)
 *   _emdash_collections/_fields   schema registry
 *   _emdash_relations             relation definitions (migration 086)
 *   _emdash_content_references    live relation edges between translation groups (043/087)
 * Re-check this file whenever the pinned EmDash revision changes.
 */

import { COLLECTION_SLUGS, isPowerfarmCollection } from "./model.js";

export interface ContentRow {
	id: string;
	slug: string | null;
	status: string;
	locale: string | null;
	translation_group: string | null;
	author_id: string | null;
	created_at: string | null;
	updated_at: string | null;
	published_at: string | null;
	live_revision_id: string | null;
	draft_revision_id: string | null;
	[column: string]: unknown;
}

export interface EdgeRow {
	relation: string;
	parent_collection: string;
	child_collection: string;
	parent_group: string;
	child_group: string;
	sort_order: number;
	created_at: string | null;
}

export interface RowQuery {
	statuses?: readonly string[];
	groups?: readonly string[];
	ids?: readonly string[];
	/** Rows whose `field` equals one of `values` (exact match). */
	equals?: { field: string; values: readonly string[] };
	limit: number;
	offset?: number;
}

export interface EmDashReadPort {
	/** Field slug → field type, per Powerfarm collection that exists. */
	fieldTypes(): Promise<Map<string, Map<string, string>>>;
	rows(collection: string, query: RowQuery): Promise<ContentRow[]>;
	revisionData(ids: readonly string[]): Promise<Map<string, Record<string, unknown>>>;
	/** Live edges where either end is one of `groups`. */
	edgesTouching(groups: readonly string[]): Promise<EdgeRow[]>;
}

const IDENT = /^[a-z][a-z0-9_]*$/;
/**
 * Values per IN list. Cloudflare D1 allows 100 bound parameters per statement;
 * a rows() query binds at most 4 statuses, the list, limit and offset, and
 * edgesTouching binds the list twice. SQLite (Node) has a far higher limit, so
 * one value works on both.
 */
export const MAX_IN = 45;

export function assertCollection(collection: string): void {
	if (!isPowerfarmCollection(collection) || !IDENT.test(collection)) throw new Error(`Not a Powerfarm collection: ${collection}`);
}

function chunk<T>(values: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < values.length; i += MAX_IN) out.push(values.slice(i, i + MAX_IN));
	return out;
}

/** The schema registry changes only on a migration; shared across requests for a minute. */
const FIELD_TYPES_TTL_MS = 60_000;
let fieldTypeCache: { at: number; map: Map<string, Map<string, string>> } | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- EmDash's Kysely types do not include per-site ec_* tables
type Kysely = any;

/** Production adapter over EmDash's Kysely instance. */
export class KyselyReadPort implements EmDashReadPort {
	private readonly db: Kysely;

	constructor(db: Kysely) {
		this.db = db;
	}

	/**
	 * A port over the database handle EmDash uses for *this* request. On
	 * Cloudflare, `getDb()` returns the request's D1 session (read-replica
	 * bookmarks); a handle kept from another request would read stale data or
	 * fail with a cross-request I/O error, so a port is opened per use.
	 */
	static async open(): Promise<KyselyReadPort> {
		const runtime = await import("emdash/runtime");
		return new KyselyReadPort(await runtime.getDb());
	}

	async fieldTypes(): Promise<Map<string, Map<string, string>>> {
		if (fieldTypeCache && Date.now() - fieldTypeCache.at < FIELD_TYPES_TTL_MS) return fieldTypeCache.map;
		const rows: Array<{ collection: string; slug: string; type: string }> = await this.db
			.selectFrom("_emdash_fields as f")
			.innerJoin("_emdash_collections as c", "c.id", "f.collection_id")
			.select(["c.slug as collection", "f.slug as slug", "f.type as type"])
			.where("c.slug", "in", COLLECTION_SLUGS)
			.execute();
		const map = new Map<string, Map<string, string>>();
		for (const row of rows) {
			let fields = map.get(row.collection);
			if (!fields) map.set(row.collection, (fields = new Map()));
			fields.set(row.slug, row.type);
		}
		fieldTypeCache = { at: Date.now(), map };
		return map;
	}

	async rows(collection: string, query: RowQuery): Promise<ContentRow[]> {
		assertCollection(collection);
		const types = await this.fieldTypes();
		if (!types.has(collection)) return [];
		if (query.equals && !types.get(collection)!.has(query.equals.field)) throw new Error(`Unknown field ${collection}.${query.equals.field}`);
		if ((query.groups && query.groups.length === 0) || (query.ids && query.ids.length === 0) || (query.equals && query.equals.values.length === 0)) return [];
		const lists = [query.groups ? "groups" : null, query.ids ? "ids" : null, query.equals ? "equals" : null].filter(Boolean);
		if (lists.length > 1) throw new Error("rows() takes one of groups, ids or equals");
		const limit = Math.min(query.limit, 1000);
		const values = query.groups ?? query.ids ?? query.equals?.values ?? null;
		if (!values || values.length <= MAX_IN) return this.rowsOnce(collection, query, limit, query.offset ?? 0);
		// Long lists: one statement per chunk (D1's parameter limit), merged in id order.
		if (query.offset) throw new Error("rows() cannot page a list of more than MAX_IN values");
		const out: ContentRow[] = [];
		for (const part of chunk(values)) {
			const q: RowQuery = query.groups ? { ...query, groups: part } : query.ids ? { ...query, ids: part } : { ...query, equals: { field: query.equals!.field, values: part } };
			// oxlint-disable-next-line no-await-in-loop -- bounded chunks
			out.push(...(await this.rowsOnce(collection, q, limit, 0)));
		}
		return out.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)).slice(0, limit);
	}

	private rowsOnce(collection: string, query: RowQuery, limit: number, offset: number): Promise<ContentRow[]> {
		let q = this.db.selectFrom(`ec_${collection}`).selectAll().where("deleted_at", "is", null);
		if (query.statuses) q = q.where("status", "in", [...query.statuses]);
		if (query.groups) q = q.where("translation_group", "in", [...query.groups]);
		if (query.ids) q = q.where("id", "in", [...query.ids]);
		if (query.equals) q = q.where(query.equals.field, "in", [...query.equals.values]);
		return q.orderBy("id", "asc").limit(limit).offset(offset).execute();
	}

	async revisionData(ids: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
		const out = new Map<string, Record<string, unknown>>();
		for (const part of chunk(ids)) {
			if (part.length === 0) continue;
			// oxlint-disable-next-line no-await-in-loop -- bounded chunks
			const rows: Array<{ id: string; data: string }> = await this.db.selectFrom("revisions").select(["id", "data"]).where("id", "in", part).execute();
			for (const row of rows) {
				try {
					out.set(row.id, JSON.parse(row.data));
				} catch {
					// unreadable snapshot: treat as absent
				}
			}
		}
		return out;
	}

	async edgesTouching(groups: readonly string[]): Promise<EdgeRow[]> {
		const out: EdgeRow[] = [];
		for (const part of chunk(groups)) {
			if (part.length === 0) continue;
			// oxlint-disable-next-line no-await-in-loop -- bounded chunks
			const rows: EdgeRow[] = await this.db
				.selectFrom("_emdash_content_references as r")
				.innerJoin("_emdash_relations as d", "d.id", "r.relation_id")
				.select([
					"d.slug as relation",
					"d.parent_collection as parent_collection",
					"d.child_collection as child_collection",
					"r.parent_group as parent_group",
					"r.child_group as child_group",
					"r.sort_order as sort_order",
					"r.created_at as created_at",
				])
				.where((eb: Kysely) => eb.or([eb("r.parent_group", "in", part), eb("r.child_group", "in", part)]))
				.execute();
			out.push(...rows);
		}
		return out.filter((e) => isPowerfarmCollection(e.parent_collection) && isPowerfarmCollection(e.child_collection));
	}
}
