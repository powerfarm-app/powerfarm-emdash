/**
 * In-memory stand-in for the parts of EmDash's PluginContext the plugin uses.
 * Semantics follow EmDash's documented storage contract (skills/creating-plugins/
 * references/storage.md): compareAndSet creates only when absent for a null
 * revision, updateIf applies only when the guard matches, revisions change on
 * every write, query supports exact/in/range/startsWith filters and cursors.
 */

type Where = Record<string, unknown>;

function matches(doc: Record<string, unknown>, where: Where | undefined): boolean {
	for (const [key, cond] of Object.entries(where ?? {})) {
		const value = doc[key];
		if (cond && typeof cond === "object" && !Array.isArray(cond)) {
			const c = cond as Record<string, unknown>;
			if ("in" in c && !(c.in as unknown[]).includes(value)) return false;
			if ("startsWith" in c && !(typeof value === "string" && value.startsWith(String(c.startsWith)))) return false;
			if ("gt" in c && !(value !== undefined && value !== null && (value as never) > (c.gt as never))) return false;
			if ("gte" in c && !(value !== undefined && value !== null && (value as never) >= (c.gte as never))) return false;
			if ("lt" in c && !(value !== undefined && value !== null && (value as never) < (c.lt as never))) return false;
			if ("lte" in c && !(value !== undefined && value !== null && (value as never) <= (c.lte as never))) return false;
		} else if (value !== cond) return false;
	}
	return true;
}

let revCounter = 0;
const nextRev = () => `r${++revCounter}`;

export class FakeCollection<T = Record<string, unknown>> {
	rows = new Map<string, { value: T; revision: string }>();
	failNextPut = 0;
	private readonly unique: string[];

	constructor(unique: string[] = []) {
		this.unique = unique;
	}

	private checkUnique(id: string, value: T) {
		for (const field of this.unique) {
			const v = (value as Record<string, unknown>)[field];
			for (const [otherId, row] of this.rows) {
				if (otherId !== id && (row.value as Record<string, unknown>)[field] === v) throw new Error(`UNIQUE constraint failed: ${field}`);
			}
		}
	}

	private maybeFail() {
		if (this.failNextPut > 0) {
			this.failNextPut--;
			throw new Error("simulated storage failure");
		}
	}

	async get(id: string) {
		return structuredClone(this.rows.get(id)?.value ?? null);
	}
	async put(id: string, value: T) {
		this.maybeFail();
		this.checkUnique(id, value);
		this.rows.set(id, { value: structuredClone(value), revision: nextRev() });
	}
	async delete(id: string) {
		return this.rows.delete(id);
	}
	async exists(id: string) {
		return this.rows.has(id);
	}
	async getVersioned(id: string) {
		const row = this.rows.get(id);
		return row ? { value: structuredClone(row.value), revision: row.revision } : null;
	}
	async compareAndSet(id: string, expected: string | null, value: T) {
		this.maybeFail();
		const row = this.rows.get(id);
		if (expected === null ? row : row?.revision !== expected) return { applied: false as const };
		this.checkUnique(id, value);
		const revision = nextRev();
		this.rows.set(id, { value: structuredClone(value), revision });
		return { applied: true as const, revision };
	}
	async compareAndDelete(id: string, expected: string) {
		const row = this.rows.get(id);
		if (!row || row.revision !== expected) return { applied: false };
		this.rows.delete(id);
		return { applied: true };
	}
	async updateIf(id: string, args: { where: Where; set?: Partial<T>; delta?: Record<string, { inc?: number; dec?: number }> }) {
		this.maybeFail();
		const row = this.rows.get(id);
		if (!row || !matches(row.value as Record<string, unknown>, args.where)) return { applied: false as const };
		const next = { ...(row.value as Record<string, unknown>), ...(structuredClone(args.set ?? {}) as Record<string, unknown>) };
		for (const [k, d] of Object.entries(args.delta ?? {})) next[k] = Number(next[k] ?? 0) + (d.inc ?? 0) - (d.dec ?? 0);
		this.rows.set(id, { value: next as T, revision: nextRev() });
		return { applied: true as const, data: structuredClone(next) as T };
	}
	async getMany(ids: string[]) {
		const m = new Map<string, T>();
		for (const id of ids) if (this.rows.has(id)) m.set(id, structuredClone(this.rows.get(id)!.value));
		return m;
	}
	async query(options: { where?: Where; orderBy?: Record<string, "asc" | "desc">; limit?: number; cursor?: string } = {}) {
		let items = [...this.rows.entries()].filter(([, r]) => matches(r.value as Record<string, unknown>, options.where)).map(([id, r]) => ({ id, data: structuredClone(r.value) }));
		const [field, dir] = Object.entries(options.orderBy ?? {})[0] ?? [];
		if (field) {
			items.sort((a, b) => {
				const x = (a.data as Record<string, unknown>)[field] as never;
				const y = (b.data as Record<string, unknown>)[field] as never;
				return (x < y ? -1 : x > y ? 1 : 0) * (dir === "desc" ? -1 : 1);
			});
		}
		const offset = options.cursor ? Number(options.cursor) : 0;
		const limit = Math.min(options.limit ?? 50, 100);
		const page = items.slice(offset, offset + limit);
		const hasMore = offset + limit < items.length;
		return { items: page, hasMore, cursor: hasMore ? String(offset + limit) : undefined };
	}
	async count(where?: Where) {
		return [...this.rows.values()].filter((r) => matches(r.value as Record<string, unknown>, where)).length;
	}
}

export class FakeKV {
	store = new FakeCollection<unknown>();
	async get<T>(key: string) {
		return (await this.store.get(key)) as T | null;
	}
	async set(key: string, value: unknown) {
		await this.store.put(key, value);
	}
	async delete(key: string) {
		return this.store.delete(key);
	}
	async list(prefix = "") {
		return [...this.store.rows.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, r]) => ({ key, value: structuredClone(r.value) }));
	}
	async getVersioned<T>(key: string) {
		return (await this.store.getVersioned(key)) as { value: T; revision: string } | null;
	}
	async compareAndSet(key: string, expected: string | null, value: unknown) {
		return this.store.compareAndSet(key, expected, value);
	}
	async compareAndDelete(key: string, expected: string) {
		return this.store.compareAndDelete(key, expected);
	}
}

export interface FakeEntry {
	id: string;
	status: string;
	data: Record<string, unknown>;
	createdAt: string;
	liveRevisionId: string | null;
}

export class FakeContent {
	collections = new Map<string, FakeEntry[]>();
	failCreates = 0;
	creates = 0;
	private seq = 0;

	list_(collection: string) {
		let list = this.collections.get(collection);
		if (!list) this.collections.set(collection, (list = []));
		return list;
	}
	async create(collection: string, data: Record<string, unknown>) {
		if (this.failCreates > 0) {
			this.failCreates--;
			throw new Error("content create failed");
		}
		this.creates++;
		const entry: FakeEntry = { id: `${collection}_${++this.seq}`, status: "draft", data: structuredClone(data), createdAt: new Date().toISOString(), liveRevisionId: null };
		this.list_(collection).push(entry);
		return { id: entry.id, type: collection, status: entry.status, data: entry.data };
	}
	async get(collection: string, id: string) {
		const e = this.list_(collection).find((x) => x.id === id);
		return e ? { id: e.id, type: collection, status: e.status, data: e.data } : null;
	}
	async list(collection: string, options: { where?: { fieldFilters?: Record<string, unknown> }; limit?: number } = {}) {
		const ff = options.where?.fieldFilters ?? {};
		const items = this.list_(collection)
			.filter((e) => Object.entries(ff).every(([k, v]) => e.data[k] === v))
			.slice(0, options.limit ?? 50)
			.map((e) => ({ id: e.id, type: collection, status: e.status, data: e.data }));
		return { items, hasMore: false };
	}
	async getVersioned(collection: string, id: string) {
		const e = this.list_(collection).find((x) => x.id === id);
		return e ? { item: { id: e.id, status: e.status, data: e.data }, _rev: `${e.id}@${e.status}` } : null;
	}
	async publish(collection: string, id: string) {
		const e = this.list_(collection).find((x) => x.id === id)!;
		e.status = "published";
		e.liveRevisionId = `live_${id}_${++this.seq}`;
		return { item: { id: e.id, status: e.status, data: e.data }, _rev: `${e.id}@published` };
	}
}

export class FakeMedia {
	items = new Map<string, { filename: string; contentType: string; bytes: Uint8Array }>();
	private seq = 0;
	async upload(filename: string, contentType: string, bytes: ArrayBuffer) {
		const mediaId = `media_${++this.seq}`;
		this.items.set(mediaId, { filename, contentType, bytes: new Uint8Array(bytes) });
		return { mediaId, storageKey: `${mediaId}-${filename}`, url: `/_emdash/api/media/file/${mediaId}-${filename}` };
	}
	async readBytes(id: string) {
		const m = this.items.get(id);
		if (!m) throw new Error("not found");
		return { bytes: m.bytes, filename: m.filename, mimeType: m.contentType, size: m.bytes.byteLength };
	}
	async get(id: string) {
		const m = this.items.get(id);
		return m ? { id, filename: m.filename, mimeType: m.contentType, size: m.bytes.byteLength, url: "", createdAt: "" } : null;
	}
}

export function fakeCtx(settings: Record<string, unknown> = {}) {
	const logs: Array<{ level: string; message: string; data?: unknown }> = [];
	const content = new FakeContent();
	const storage = {
		jobs: new FakeCollection(),
		bridges: new FakeCollection(),
		reconciliations: new FakeCollection(),
		journal: new FakeCollection(["eventId"]),
		identifiers: new FakeCollection(),
		runs: new FakeCollection(),
		mdm_devices: new FakeCollection(),
		mdm_commands: new FakeCollection(),
		mdm_pushes: new FakeCollection(),
	};
	return {
		plugin: { id: "powerfarm", version: "test" },
		site: { name: "Powerfarm", url: "https://powerfarm.example.org", locale: "en" },
		storage,
		kv: new FakeKV(),
		content,
		media: new FakeMedia(),
		settings: {
			values: { bridgeId: "lab-512-bridge", bridgeSecret: "s".repeat(64), ...settings } as Record<string, unknown>,
			async get<T>(key: string) {
				return (this.values[key] ?? null) as T | null;
			},
			async set(key: string, value: unknown) {
				this.values[key] = value;
			},
		},
		log: {
			info: (message: string, data?: unknown) => logs.push({ level: "info", message, data }),
			warn: (message: string, data?: unknown) => logs.push({ level: "warn", message, data }),
			error: (message: string, data?: unknown) => logs.push({ level: "error", message, data }),
			debug: () => {},
		},
		logs,
	};
}

export type FakeCtx = ReturnType<typeof fakeCtx>;
