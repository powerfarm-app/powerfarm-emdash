/**
 * The operational event journal.
 *
 * The journal is the authoritative, ordered record of what happened to jobs and
 * assets. It lives in this plugin's EmDash storage (`journal`), one stream per
 * asset plus a `system` stream. Each entry carries a per-stream sequence number
 * and a SHA-256 hash chained to the previous entry, so later edits, deletions or
 * reordering are detectable by `verifyChain`. That is tamper-evident, not
 * tamper-proof: whoever administers the database can rewrite a chain from the
 * start. Off-host backups of the journal are what make a rewrite noticeable.
 *
 * The human-readable, searchable copy is the `events` content collection. It is
 * a projection: every journal entry has an outbox state, is projected right
 * after it is appended, and is retried by the `outbox` cron task until it
 * succeeds. A failed append is never swallowed: it throws, and it switches the
 * platform into an "audit degraded" state that blocks verification and trust
 * until a person acknowledges it.
 */

import type { PluginContext, StorageCollection } from "emdash";

export const JOURNAL_STORAGE = {
	journal: {
		indexes: ["stream", "seq", "type", "jobId", "assetTag", "opCode", "at", "projectionStatus", ["stream", "seq"], ["projectionStatus", "at"]],
		uniqueIndexes: ["eventId"],
	},
};

export const GENESIS = "0".repeat(64);
const DEGRADED_KEY = "audit:degraded";
const MAX_PROJECTION_ATTEMPTS = 20;

export interface JournalInput {
	type: string;
	/** Usually `asset:<TAG>`; `system` for platform-wide events. */
	stream: string;
	actor: string;
	source: "policy" | "bridge" | "reconcile" | "admin" | "evidence" | "system";
	title: string;
	assetTag?: string | null;
	opCode?: string | null;
	jobId?: string | null;
	payload?: Record<string, unknown> | null;
	/** Stable key that makes the append idempotent (for example `job:<id>:status:running`). */
	idempotencyKey?: string;
	evidenceIds?: string[];
}

export interface JournalEntry {
	eventId: string;
	stream: string;
	seq: number;
	type: string;
	at: string;
	actor: string;
	source: JournalInput["source"];
	title: string;
	assetTag: string | null;
	opCode: string | null;
	jobId: string | null;
	payload: Record<string, unknown> | null;
	evidenceIds: string[];
	prevHash: string;
	hash: string;
	projectionStatus: "pending" | "projected" | "failed";
	projection: { contentId: string | null; attempts: number; lastError: string | null; lastAttemptAt: string | null };
}

type Ctx = Pick<PluginContext, "storage" | "kv" | "content" | "log">;

function journalOf(ctx: Ctx): StorageCollection<JournalEntry> {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- declared in JOURNAL_STORAGE
	return (ctx.storage as Record<string, StorageCollection<JournalEntry>>).journal!;
}

export function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const keys = Object.keys(value as Record<string, unknown>).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function entryHash(entry: Omit<JournalEntry, "hash" | "projectionStatus" | "projection">): Promise<string> {
	return sha256(
		canonical({
			eventId: entry.eventId,
			stream: entry.stream,
			seq: entry.seq,
			type: entry.type,
			at: entry.at,
			actor: entry.actor,
			source: entry.source,
			title: entry.title,
			assetTag: entry.assetTag,
			opCode: entry.opCode,
			jobId: entry.jobId,
			payload: entry.payload,
			evidenceIds: entry.evidenceIds,
			prevHash: entry.prevHash,
		}),
	);
}

function entryKey(stream: string, seq: number): string {
	return `${stream}#${String(seq).padStart(10, "0")}`;
}

export function streamForAsset(assetTag: string | null | undefined): string {
	return assetTag ? `asset:${assetTag.toUpperCase()}` : "system";
}

export class JournalError extends Error {
	override readonly name = "JournalError";
}

async function findByEventId(ctx: Ctx, eventId: string): Promise<JournalEntry | null> {
	const page = await journalOf(ctx).query({ where: { eventId }, limit: 1 });
	return page.items[0]?.data ?? null;
}

/**
 * Append an entry. Idempotent on `idempotencyKey`. Throws `JournalError` (and
 * marks the audit as degraded) if the entry cannot be stored.
 */
export async function appendJournal(ctx: Ctx, input: JournalInput): Promise<JournalEntry> {
	const eventId = input.idempotencyKey ?? `evt_${crypto.randomUUID()}`;
	try {
		const existing = await findByEventId(ctx, eventId);
		if (existing) return existing;

		const headKey = `journal:head:${input.stream}`;
		for (let attempt = 0; attempt < 10; attempt++) {
			// oxlint-disable-next-line no-await-in-loop -- bounded CAS retry
			const head = await ctx.kv.getVersioned<{ seq: number; hash: string }>(headKey);
			const seq = (head?.value.seq ?? 0) + 1;
			const base = {
				eventId,
				stream: input.stream,
				seq,
				type: input.type,
				at: new Date().toISOString(),
				actor: input.actor,
				source: input.source,
				title: input.title.slice(0, 200),
				assetTag: input.assetTag ?? null,
				opCode: input.opCode ?? null,
				jobId: input.jobId ?? null,
				payload: input.payload ?? null,
				evidenceIds: input.evidenceIds ?? [],
				prevHash: head?.value.hash ?? GENESIS,
			};
			// oxlint-disable-next-line no-await-in-loop
			const hash = await entryHash(base);
			// The head CAS is the linearisation point: exactly one writer gets each sequence number.
			// oxlint-disable-next-line no-await-in-loop
			const advanced = await ctx.kv.compareAndSet(headKey, head?.revision ?? null, { seq, hash });
			if (!advanced.applied) continue;
			const entry: JournalEntry = {
				...base,
				hash,
				projectionStatus: "pending",
				projection: { contentId: null, attempts: 0, lastError: null, lastAttemptAt: null },
			};
			// oxlint-disable-next-line no-await-in-loop
			const stored = await journalOf(ctx).compareAndSet(entryKey(input.stream, seq), null, entry);
			if (!stored.applied) throw new JournalError(`Journal slot ${entryKey(input.stream, seq)} was already taken`);
			return entry;
		}
		throw new JournalError(`Journal stream ${input.stream} is under contention`);
	} catch (error) {
		await markDegraded(ctx, `Journal append failed for ${input.type}: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
		throw error instanceof JournalError ? error : new JournalError(error instanceof Error ? error.message : String(error));
	}
}

/** Append, then try to project immediately. Projection failure is left for the outbox task. */
export async function record(ctx: Ctx, input: JournalInput): Promise<JournalEntry> {
	const entry = await appendJournal(ctx, input);
	await projectEntry(ctx, entry).catch((error) =>
		ctx.log.warn("Event projection deferred to outbox", { eventId: entry.eventId, error: error instanceof Error ? error.message : String(error) }),
	);
	return entry;
}

/**
 * Project one entry into the `events` collection. Idempotent: the content entry
 * carries the journal id, so a retry after a lost response finds it.
 */
export async function projectEntry(ctx: Ctx, entry: JournalEntry): Promise<string> {
	const key = entryKey(entry.stream, entry.seq);
	const content = ctx.content;
	const attempt = async () => {
		if (!content?.create || !content.list) throw new Error("content:write is not granted");
		const found = await content.list("events", { where: { fieldFilters: { journal_id: entry.eventId } }, limit: 1 });
		let id = found.items[0]?.id;
		if (!id) {
			const created = await content.create("events", {
				title: entry.title,
				event_type: entry.type,
				occurred_at: entry.at,
				stream: entry.stream,
				sequence: entry.seq,
				journal_id: entry.eventId,
				entry_hash: entry.hash,
				asset_tag: entry.assetTag,
				op_code: entry.opCode,
				job_id: entry.jobId,
				actor: entry.actor,
				source: entry.source,
				payload: entry.payload,
			});
			id = created.id;
		}
		if (content.getVersioned && content.publish) {
			const versioned = await content.getVersioned("events", id);
			if (versioned && versioned.item.status !== "published") await content.publish("events", id, { _rev: versioned._rev });
		}
		return id;
	};
	const now = new Date().toISOString();
	try {
		const contentId = await attempt();
		await journalOf(ctx).updateIf(key, {
			where: { eventId: entry.eventId },
			set: { projectionStatus: "projected", projection: { contentId, attempts: entry.projection.attempts + 1, lastError: null, lastAttemptAt: now } },
		});
		return contentId;
	} catch (error) {
		const message = error instanceof Error ? error.message.slice(0, 500) : String(error);
		await journalOf(ctx).updateIf(key, {
			where: { eventId: entry.eventId },
			set: {
				projectionStatus: "failed",
				projection: { contentId: null, attempts: entry.projection.attempts + 1, lastError: message, lastAttemptAt: now },
			},
		});
		throw error;
	}
}

/** Outbox task: retry entries whose projection is pending or failed. */
export async function drainOutbox(ctx: Ctx, limit = 50): Promise<{ projected: number; failed: number; exhausted: number }> {
	let projected = 0;
	let failed = 0;
	let exhausted = 0;
	const page = await journalOf(ctx).query({ where: { projectionStatus: { in: ["pending", "failed"] } }, orderBy: { at: "asc" }, limit });
	for (const { data: entry } of page.items) {
		if (entry.projection.attempts >= MAX_PROJECTION_ATTEMPTS) {
			exhausted++;
			continue;
		}
		try {
			// oxlint-disable-next-line no-await-in-loop -- sequential retries keep order
			await projectEntry(ctx, entry);
			projected++;
		} catch {
			failed++;
		}
	}
	if (exhausted > 0) await markDegraded(ctx, `${exhausted} journal entries could not be projected after ${MAX_PROJECTION_ATTEMPTS} attempts`);
	return { projected, failed, exhausted };
}

export async function streamEntries(ctx: Ctx, stream: string, limit = 100, cursor?: string): Promise<{ entries: JournalEntry[]; cursor?: string }> {
	const page = await journalOf(ctx).query({ where: { stream }, orderBy: { seq: "desc" }, limit: Math.min(limit, 100), cursor });
	return { entries: page.items.map((i) => i.data), cursor: page.hasMore ? page.cursor : undefined };
}

export async function entriesFor(ctx: Ctx, where: { jobId?: string; opCode?: string; assetTag?: string }, limit = 100): Promise<JournalEntry[]> {
	const page = await journalOf(ctx).query({ where: where as Record<string, string>, orderBy: { at: "desc" }, limit: Math.min(limit, 100) });
	return page.items.map((i) => i.data);
}

/** Recompute the hash chain of one stream. */
export async function verifyChain(ctx: Ctx, stream: string): Promise<{ ok: boolean; checked: number; problem?: string }> {
	let expectedPrev = GENESIS;
	let expectedSeq = 1;
	let checked = 0;
	let cursor: string | undefined;
	do {
		// oxlint-disable-next-line no-await-in-loop -- cursor pagination
		const page = await journalOf(ctx).query({ where: { stream }, orderBy: { seq: "asc" }, limit: 100, cursor });
		for (const { data: entry } of page.items) {
			if (entry.seq !== expectedSeq) return { ok: false, checked, problem: `Missing or reordered entry: expected seq ${expectedSeq}, found ${entry.seq}` };
			if (entry.prevHash !== expectedPrev) return { ok: false, checked, problem: `Chain broken at seq ${entry.seq}` };
			// oxlint-disable-next-line no-await-in-loop
			const recomputed = await entryHash(entry);
			if (recomputed !== entry.hash) return { ok: false, checked, problem: `Entry ${entry.seq} was modified` };
			expectedPrev = entry.hash;
			expectedSeq++;
			checked++;
		}
		cursor = page.hasMore ? page.cursor : undefined;
	} while (cursor);
	const head = await ctx.kv.get<{ seq: number; hash: string }>(`journal:head:${stream}`);
	if (head && (head.seq !== expectedSeq - 1 || head.hash !== expectedPrev)) {
		return { ok: false, checked, problem: `Stream head is at seq ${head.seq} but the stored chain ends at ${expectedSeq - 1}` };
	}
	return { ok: true, checked };
}

export async function knownStreams(ctx: Ctx): Promise<string[]> {
	return (await ctx.kv.list("journal:head:")).map((e) => e.key.slice("journal:head:".length));
}

export interface AuditState {
	degraded: boolean;
	since: string | null;
	reasons: string[];
}

export async function markDegraded(ctx: Pick<PluginContext, "kv">, reason: string): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt++) {
		// oxlint-disable-next-line no-await-in-loop
		const current = await ctx.kv.getVersioned<AuditState>(DEGRADED_KEY);
		const next: AuditState = {
			degraded: true,
			since: current?.value.since ?? new Date().toISOString(),
			reasons: [...(current?.value.reasons ?? []), `${new Date().toISOString()} ${reason}`].slice(-50),
		};
		// oxlint-disable-next-line no-await-in-loop
		if ((await ctx.kv.compareAndSet(DEGRADED_KEY, current?.revision ?? null, next)).applied) return;
	}
}

export async function auditState(ctx: Pick<PluginContext, "kv">): Promise<AuditState> {
	return (await ctx.kv.get<AuditState>(DEGRADED_KEY)) ?? { degraded: false, since: null, reasons: [] };
}

/** A person clears the degraded state after checking. Refused while any chain still fails. */
export async function acknowledgeDegraded(ctx: Ctx, by: string): Promise<{ cleared: boolean; problems: string[] }> {
	const problems: string[] = [];
	for (const stream of await knownStreams(ctx)) {
		// oxlint-disable-next-line no-await-in-loop
		const result = await verifyChain(ctx, stream);
		if (!result.ok) problems.push(`${stream}: ${result.problem}`);
	}
	const backlog = await journalOf(ctx).count({ projectionStatus: { in: ["pending", "failed"] } });
	if (backlog > 0) problems.push(`${backlog} entries are not yet projected into Events`);
	if (problems.length > 0) return { cleared: false, problems };
	await ctx.kv.delete(DEGRADED_KEY);
	await appendJournal(ctx, { type: "audit.acknowledged", stream: "system", actor: by, source: "admin", title: "Audit degraded state acknowledged and cleared" });
	return { cleared: true, problems };
}
