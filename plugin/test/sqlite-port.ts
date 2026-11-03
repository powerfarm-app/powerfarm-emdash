/**
 * A real SQLite database shaped like EmDash 1.4.0's tables, built from the
 * Powerfarm seed, with an EmDashReadPort adapter over node:sqlite.
 *
 * Tables and columns mirror EmDash migrations: ec_<collection> (system columns
 * from schema/registry.ts createContentTable), revisions, _emdash_collections,
 * _emdash_fields, _emdash_relations (086) and _emdash_content_references (043/087).
 */

import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { ContentRow, EdgeRow, EmDashReadPort, RowQuery } from "../src/emdash-port.ts";

const IDENT = /^[a-z][a-z0-9_]*$/;
function ident(name: string): string {
	if (!IDENT.test(name)) throw new Error(`bad identifier ${name}`);
	return `"${name}"`;
}

interface SeedField {
	slug: string;
	type: string;
	validation?: Record<string, unknown>;
}
interface SeedCollection {
	slug: string;
	fields: SeedField[];
}
export interface Seed {
	collections: SeedCollection[];
	relations: Array<{ slug: string; parentCollection: string; childCollection: string; parentLabel: string; childLabel: string }>;
	content?: Record<string, Array<{ id: string; slug?: string; status?: string; data: Record<string, unknown> }>>;
}

export function loadSeed(): Seed {
	return JSON.parse(readFileSync(new URL("../../site/seed/seed.json", import.meta.url), "utf8")) as Seed;
}

const JSON_TYPES = new Set(["json", "multiSelect", "portableText", "repeater", "blocks", "image", "file"]);

export class TestDb {
	readonly db = new DatabaseSync(":memory:");
	readonly seed: Seed;
	private seq = 0;
	private readonly fieldTypes = new Map<string, Map<string, string>>();

	constructor(seed: Seed = loadSeed()) {
		this.seed = seed;
		const d = this.db;
		d.exec(`create table _emdash_collections (id text primary key, slug text not null unique)`);
		d.exec(`create table _emdash_fields (id text primary key, collection_id text not null, slug text not null, type text not null, validation text)`);
		d.exec(`create table revisions (id text primary key, collection text not null, entry_id text not null, data text not null, author_id text, created_at text)`);
		d.exec(`create table _emdash_relations (id text primary key, slug text not null unique, parent_collection text not null, child_collection text not null, parent_label text not null, child_label text not null)`);
		d.exec(`create table _emdash_content_references (id text primary key, relation_id text not null, parent_group text not null, child_group text not null, sort_order integer not null default 0, created_at text)`);
		for (const c of seed.collections) {
			const cid = `col_${c.slug}`;
			d.prepare(`insert into _emdash_collections values (?, ?)`).run(cid, c.slug);
			const types = new Map<string, string>();
			const columns: string[] = [];
			for (const f of c.fields) {
				d.prepare(`insert into _emdash_fields values (?, ?, ?, ?, ?)`).run(`fld_${c.slug}_${f.slug}`, cid, f.slug, f.type, JSON.stringify(f.validation ?? null));
				types.set(f.slug, f.type);
				const storageless = f.type === "reference" && typeof f.validation?.relation === "string";
				if (!storageless) columns.push(`${ident(f.slug)} ${f.type === "integer" || f.type === "boolean" ? "integer" : f.type === "number" ? "real" : "text"}`);
			}
			this.fieldTypes.set(c.slug, types);
			d.exec(`create table ${ident(`ec_${c.slug}`)} (
				id text primary key, slug text, status text default 'draft', author_id text, primary_byline_id text,
				created_at text, updated_at text, published_at text, scheduled_at text, deleted_at text, version integer default 1,
				live_revision_id text, draft_revision_id text, locale text not null default 'en', translation_group text
				${columns.length ? "," + columns.join(",") : ""})`);
		}
		for (const r of seed.relations) {
			d.prepare(`insert into _emdash_relations values (?, ?, ?, ?, ?, ?)`).run(`rel_${r.slug}`, r.slug, r.parentCollection, r.childCollection, r.parentLabel, r.childLabel);
		}
	}

	insert(
		collection: string,
		data: Record<string, unknown>,
		options: { id?: string; status?: string; locale?: string; group?: string; authorId?: string; createdAt?: string; draft?: Record<string, unknown> } = {},
	): { id: string; group: string; liveRevisionId: string | null } {
		const id = options.id ?? `${collection}_${++this.seq}`;
		const group = options.group ?? `grp_${id}`;
		const types = this.fieldTypes.get(collection)!;
		const cols: string[] = [];
		const vals: Array<string | number | null> = [];
		for (const [k, v] of Object.entries(data)) {
			const type = types.get(k);
			if (!type) throw new Error(`${collection}.${k} is not a seed field`);
			if (type === "reference") continue;
			cols.push(ident(k));
			vals.push(v === null || v === undefined ? null : JSON_TYPES.has(type) ? JSON.stringify(v) : type === "boolean" ? (v ? 1 : 0) : (v as string | number));
		}
		const status = options.status ?? "published";
		const live = status === "published" ? `rev_live_${id}` : null;
		let draftId: string | null = null;
		if (options.draft) {
			draftId = `rev_draft_${id}_${++this.seq}`;
			this.db.prepare(`insert into revisions values (?, ?, ?, ?, ?, ?)`).run(draftId, collection, id, JSON.stringify(options.draft), options.authorId ?? null, new Date().toISOString());
		}
		const now = options.createdAt ?? new Date().toISOString();
		this.db
			.prepare(
				`insert into ${ident(`ec_${collection}`)} (id, slug, status, author_id, created_at, updated_at, published_at, live_revision_id, draft_revision_id, locale, translation_group${cols.length ? "," + cols.join(",") : ""})
				 values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${vals.map(() => ", ?").join("")})`,
			)
			.run(id, id, status, options.authorId ?? null, now, now, status === "published" ? now : null, live, draftId ?? live, options.locale ?? "en", group, ...vals);
		return { id, group, liveRevisionId: live };
	}

	link(relation: string, parentGroup: string, childGroup: string) {
		this.db.prepare(`insert into _emdash_content_references values (?, ?, ?, ?, 0, ?)`).run(`ref_${++this.seq}`, `rel_${relation}`, parentGroup, childGroup, new Date().toISOString());
	}

	port(): EmDashReadPort {
		const db = this.db;
		const types = this.fieldTypes;
		return {
			async fieldTypes() {
				return types;
			},
			async rows(collection: string, q: RowQuery): Promise<ContentRow[]> {
				if (!types.has(collection)) return [];
				const where = ["deleted_at is null"];
				const params: Array<string | number> = [];
				const inList = (col: string, values: readonly string[]) => {
					where.push(`${col} in (${values.map(() => "?").join(",")})`);
					params.push(...values);
				};
				if (q.statuses) inList("status", q.statuses);
				if (q.groups) {
					if (q.groups.length === 0) return [];
					inList("translation_group", q.groups);
				}
				if (q.ids) {
					if (q.ids.length === 0) return [];
					inList("id", q.ids);
				}
				if (q.equals) {
					if (!types.get(collection)!.has(q.equals.field)) throw new Error("unknown field");
					if (q.equals.values.length === 0) return [];
					inList(ident(q.equals.field), q.equals.values);
				}
				params.push(q.limit, q.offset ?? 0);
				return db.prepare(`select * from ${ident(`ec_${collection}`)} where ${where.join(" and ")} order by id limit ? offset ?`).all(...params) as unknown as ContentRow[];
			},
			async revisionData(ids: readonly string[]) {
				const out = new Map<string, Record<string, unknown>>();
				if (ids.length === 0) return out;
				for (const row of db.prepare(`select id, data from revisions where id in (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: string; data: string }>) {
					out.set(row.id, JSON.parse(row.data));
				}
				return out;
			},
			async edgesTouching(groups: readonly string[]): Promise<EdgeRow[]> {
				if (groups.length === 0) return [];
				const marks = groups.map(() => "?").join(",");
				return db
					.prepare(
						`select d.slug as relation, d.parent_collection, d.child_collection, r.parent_group, r.child_group, r.sort_order, r.created_at
						 from _emdash_content_references r join _emdash_relations d on d.id = r.relation_id
						 where r.parent_group in (${marks}) or r.child_group in (${marks})`,
					)
					.all(...groups, ...groups) as unknown as EdgeRow[];
			},
		};
	}
}
