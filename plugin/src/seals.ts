/**
 * Record seals: a SHA-256 over a canonical form of each published institutional
 * record (fields, the relations it has, the revision), written to the journal.
 *
 * EmDash runs Powerfarm's `afterPublish` with `errorPolicy: "continue"`, so a
 * seal written only there could fail silently while the publish succeeds.
 * Therefore:
 *   1. `beforePublish`, once a publish is allowed, writes a seal-pending marker;
 *   2. `afterPublish` seals and removes the marker;
 *   3. the `seals` task seals whatever is still pending after two minutes, and
 *      records an abandoned marker when the publish did not happen after all;
 *   4. a record whose current published form no longer matches its last seal
 *      is reported (`records/seal` route, vigilance).
 *
 * Media fields are sealed by their media ids; the bytes of evidence files are
 * hashed when they are uploaded (evidence.ts), not here.
 */

import type { ContentReader, Entity } from "./content.js";
import { canonical, record, streamEntries } from "./journal.js";
import type { CollectionSlug } from "./model.js";

export const SEALED_COLLECTIONS = new Set(["policies", "grants", "decisions", "procedures", "releases", "mdm_profiles", "requirements"]);
const PENDING = "seal:pending:";
const GRACE_MS = 2 * 60_000;

type Ctx = Parameters<typeof record>[0];

interface Marker {
	collection: string;
	id: string;
	approverUserId: string | null;
	at: string;
}

async function sha256(text: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The canonical form a seal covers. */
export async function sealOf(reader: ContentReader, collection: string, entity: Entity): Promise<{ sha256: string; revision: string | null; relations: number }> {
	const edges = (await reader.readPort.edgesTouching([entity.group]))
		.map((e) => ({ relation: e.relation, parent: `${e.parent_collection}:${e.parent_group}`, child: `${e.child_collection}:${e.child_group}` }))
		.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
	const body = canonical({ collection, group: entity.group, key: entity.key, revision: entity.liveRevisionId, data: entity.data, relations: edges });
	return { sha256: await sha256(body), revision: entity.liveRevisionId, relations: edges.length };
}

export async function markPending(ctx: Ctx, collection: string, id: string, approverUserId: string | null): Promise<void> {
	if (!SEALED_COLLECTIONS.has(collection)) return;
	await ctx.kv.set(`${PENDING}${collection}:${id}`, { collection, id, approverUserId, at: new Date().toISOString() } satisfies Marker);
}

/** Seal the published record now. Idempotent per revision. */
export async function seal(ctx: Ctx, reader: ContentReader, collection: string, id: string): Promise<{ sealed: boolean; sha256?: string; reason?: string }> {
	if (!SEALED_COLLECTIONS.has(collection)) return { sealed: false, reason: "not a sealed collection" };
	const marker = await ctx.kv.get<Marker>(`${PENDING}${collection}:${id}`);
	const entity = await reader.resolve(collection as CollectionSlug, id, "published");
	if (!entity) return { sealed: false, reason: "not published" };
	const s = await sealOf(reader, collection, entity);
	await record(ctx, {
		type: "record.sealed",
		stream: `record:${collection}`,
		actor: marker?.approverUserId ? `user:${marker.approverUserId}` : "powerfarm",
		source: "policy",
		title: `Sealed ${collection} ${entity.key ?? entity.id} at revision ${s.revision ?? "?"}`,
		payload: { collection, id: entity.id, key: entity.key, revision: s.revision, sha256: s.sha256, relations: s.relations, approverUserId: marker?.approverUserId ?? null },
		idempotencyKey: `seal:${collection}:${entity.id}:${s.revision ?? "none"}`,
	});
	await ctx.kv.delete(`${PENDING}${collection}:${id}`);
	return { sealed: true, sha256: s.sha256 };
}

/** The `seals` task: finish seals whose afterPublish did not complete. */
export async function reconcileSeals(ctx: Ctx, reader: ContentReader, now = Date.now()): Promise<{ sealed: number; abandoned: number; failed: number }> {
	let sealed = 0;
	let abandoned = 0;
	let failed = 0;
	for (const { key, value } of await ctx.kv.list(PENDING)) {
		const m = value as Marker;
		if (!m?.at || now - Date.parse(m.at) < GRACE_MS) continue;
		try {
			// oxlint-disable-next-line no-await-in-loop -- few markers
			const r = await seal(ctx, reader, m.collection, m.id);
			if (r.sealed) sealed++;
			else {
				// oxlint-disable-next-line no-await-in-loop
				await record(ctx, { type: "record.seal_abandoned", stream: `record:${m.collection}`, actor: "powerfarm", source: "reconcile", title: `${m.collection} ${m.id}: publish did not complete; nothing to seal`, payload: { ...m }, idempotencyKey: `seal-abandoned:${key}:${m.at}` });
				// oxlint-disable-next-line no-await-in-loop
				await ctx.kv.delete(key);
				abandoned++;
			}
		} catch {
			failed++;
		}
	}
	return { sealed, abandoned, failed };
}

/** Is the record still what was last sealed? */
export async function sealStatus(ctx: Ctx & { storage: unknown }, reader: ContentReader, collection: string, ref: string): Promise<{ state: "intact" | "changed" | "unsealed" | "not_published"; sealed?: string; current?: string; revision?: string | null }> {
	const entity = await reader.resolve(collection as CollectionSlug, ref, "published");
	if (!entity) return { state: "not_published" };
	const current = await sealOf(reader, collection, entity);
	const seals = (await streamEntries(ctx as never, `record:${collection}`, 100)).entries.filter((e) => e.type === "record.sealed" && (e.payload as { id?: string })?.id === entity.id);
	const last = seals[0]?.payload as { sha256?: string; revision?: string } | undefined;
	if (!last) return { state: "unsealed", current: current.sha256, revision: current.revision };
	return { state: last.sha256 === current.sha256 ? "intact" : "changed", sealed: last.sha256, current: current.sha256, revision: current.revision };
}
