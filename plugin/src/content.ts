/**
 * Content entities: EmDash rows decoded into stable, locale-independent graph
 * entities, with published and draft views kept apart.
 *
 * - Identity is `<collection>:<translation group>`. When a group has several
 *   locales, the default locale's row is chosen, then the lowest locale code;
 *   never "whichever row the database returned last".
 * - The published view returns only `status = published` rows and their column
 *   values, which for collections with drafts are the live (published) values.
 * - The draft view additionally returns unpublished rows and, where a draft
 *   revision exists, the draft values and any staged reference selections
 *   (`_references` in the draft revision, see EmDash references/staged.ts).
 */

import type { ContentRow, EmDashReadPort } from "./emdash-port.js";
import { COLLECTIONS, type CollectionSlug } from "./model.js";

export type View = "published" | "draft";

export interface Entity {
	nodeId: string;
	collection: CollectionSlug;
	/** Row id of the chosen locale. */
	id: string;
	group: string;
	key: string | null;
	title: string;
	status: string;
	locale: string | null;
	/** `draft` when the values shown come from an unpublished row or draft revision. */
	state: "published" | "draft";
	hasPendingDraft: boolean;
	authorId: string | null;
	liveRevisionId: string | null;
	draftRevisionId: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	publishedAt: string | null;
	data: Record<string, unknown>;
	/** Staged (proposed) reference selections from the draft revision, by field. Draft view only. */
	stagedReferences: Record<string, string[]> | null;
}

const JSON_TYPES = new Set(["json", "multiSelect", "portableText", "repeater", "blocks", "image", "file"]);
const SYSTEM = new Set([
	"id",
	"slug",
	"status",
	"author_id",
	"primary_byline_id",
	"created_at",
	"updated_at",
	"published_at",
	"scheduled_at",
	"deleted_at",
	"version",
	"live_revision_id",
	"draft_revision_id",
	"locale",
	"translation_group",
]);

export function nodeIdOf(collection: string, group: string): string {
	return `${collection}:${group}`;
}

export function parseNodeId(nodeId: string): { type: string; id: string } | null {
	const at = nodeId.indexOf(":");
	if (at <= 0 || at === nodeId.length - 1) return null;
	return { type: nodeId.slice(0, at), id: nodeId.slice(at + 1) };
}

function decode(type: string | undefined, value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (type === "boolean") return value === 1 || value === true || value === "1";
	if (type && JSON_TYPES.has(type) && typeof value === "string") {
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	return value;
}

export class ContentReader {
	private readonly port: EmDashReadPort;
	private readonly defaultLocale: string;

	constructor(port: EmDashReadPort, defaultLocale = "en") {
		this.port = port;
		this.defaultLocale = defaultLocale;
	}

	get readPort(): EmDashReadPort {
		return this.port;
	}

	private async toEntities(collection: CollectionSlug, rows: ContentRow[], view: View): Promise<Entity[]> {
		const types = (await this.port.fieldTypes()).get(collection) ?? new Map<string, string>();
		// Group by translation group and choose one row per group deterministically.
		const groups = new Map<string, ContentRow[]>();
		for (const row of rows) {
			const group = row.translation_group ?? row.id;
			const list = groups.get(group);
			if (list) list.push(row);
			else groups.set(group, [row]);
		}
		const chosen = [...groups.entries()].map(([group, list]) => {
			const sorted = [...list].sort((a, b) => String(a.locale ?? "").localeCompare(String(b.locale ?? "")));
			return { group, row: sorted.find((r) => r.locale === this.defaultLocale) ?? sorted[0]! };
		});

		const draftIds =
			view === "draft"
				? chosen.map((c) => c.row.draft_revision_id).filter((id): id is string => !!id && id !== null)
				: [];
		const drafts = draftIds.length ? await this.port.revisionData(draftIds) : new Map<string, Record<string, unknown>>();

		return chosen.map(({ group, row }) => {
			const data: Record<string, unknown> = {};
			for (const [column, value] of Object.entries(row)) {
				if (!SYSTEM.has(column)) data[column] = decode(types.get(column), value);
			}
			const pending = !!row.draft_revision_id && row.draft_revision_id !== row.live_revision_id;
			let state: "published" | "draft" = row.status === "published" ? "published" : "draft";
			let staged: Record<string, string[]> | null = null;
			if (view === "draft" && pending) {
				const draft = drafts.get(row.draft_revision_id!);
				if (draft) {
					for (const [key, value] of Object.entries(draft)) {
						if (!key.startsWith("_")) data[key] = value;
					}
					const refs = draft._references;
					if (refs && typeof refs === "object") staged = refs as Record<string, string[]>;
					state = "draft";
				}
			}
			const keyField = COLLECTIONS[collection].key;
			const key = keyField && typeof data[keyField] === "string" && data[keyField] ? String(data[keyField]) : null;
			return {
				nodeId: nodeIdOf(collection, group),
				collection,
				id: row.id,
				group,
				key,
				title: typeof data.title === "string" && data.title ? data.title : (key ?? row.slug ?? row.id),
				status: row.status,
				locale: row.locale,
				state,
				hasPendingDraft: pending,
				authorId: row.author_id,
				liveRevisionId: row.live_revision_id,
				draftRevisionId: row.draft_revision_id,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				publishedAt: row.published_at,
				data,
				stagedReferences: staged,
			};
		});
	}

	private statuses(view: View): readonly string[] | undefined {
		return view === "published" ? ["published"] : undefined;
	}

	async byGroups(collection: CollectionSlug, groups: readonly string[], view: View): Promise<Entity[]> {
		if (groups.length === 0) return [];
		const rows = await this.port.rows(collection, { groups, statuses: this.statuses(view), limit: groups.length * 8 });
		return this.toEntities(collection, rows, view);
	}

	async byField(collection: CollectionSlug, field: string, values: readonly string[], view: View, limit = 200): Promise<Entity[]> {
		const types = (await this.port.fieldTypes()).get(collection);
		if (!types?.has(field) || values.length === 0) return [];
		const rows = await this.port.rows(collection, { equals: { field, values }, statuses: this.statuses(view), limit });
		return this.toEntities(collection, rows, view);
	}

	/** Resolve a business key, entry id, slug or translation group to one entity. */
	async resolve(collection: CollectionSlug, ref: string, view: View): Promise<Entity | null> {
		const keyField = COLLECTIONS[collection].key;
		const candidates: Entity[] = [];
		if (keyField) {
			candidates.push(...(await this.byField(collection, keyField, [ref, ref.toUpperCase()], view, 4)));
		}
		if (candidates.length === 0) {
			const rows = await this.port.rows(collection, { ids: [ref], statuses: this.statuses(view), limit: 1 });
			const byGroup = rows.length ? rows : await this.port.rows(collection, { groups: [ref], statuses: this.statuses(view), limit: 8 });
			candidates.push(...(await this.toEntities(collection, byGroup, view)));
		}
		return candidates[0] ?? null;
	}

	async list(collection: CollectionSlug, view: View, limit = 200, offset = 0): Promise<Entity[]> {
		const rows = await this.port.rows(collection, { statuses: this.statuses(view), limit, offset });
		return this.toEntities(collection, rows, view);
	}
}
