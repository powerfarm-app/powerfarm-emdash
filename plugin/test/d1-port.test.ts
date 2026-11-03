// The production read port against D1's limit of 100 bound parameters per
// statement: long lists are split, results merged, nothing silently dropped.
import assert from "node:assert/strict";
import { test } from "node:test";

import { KyselyReadPort, MAX_IN } from "../src/emdash-port.ts";

const D1_LIMIT = 100;

/** Just enough of Kysely's builder to run KyselyReadPort, binding parameters like D1 would. */
function fakeDb(rows: Array<Record<string, unknown>>, edges: Array<Record<string, unknown>>) {
	const statements: number[] = [];
	function builder(source: "rows" | "fields" | "edges") {
		const filters: Array<(r: Record<string, unknown>) => boolean> = [];
		let params = 0;
		let lim = Infinity;
		let off = 0;
		const b = {
			selectAll: () => b,
			select: () => b,
			innerJoin: () => b,
			orderBy: () => b,
			where(field: unknown, op?: string, value?: unknown) {
				if (typeof field === "function") {
					// eb.or([eb(a, "in", xs), eb(b, "in", ys)])
					const parts: Array<[string, unknown[]]> = [];
					const eb = Object.assign((f: string, _o: string, v: unknown[]) => (parts.push([f, v]), null), { or: () => null });
					field(eb);
					params += parts.reduce((n, [, v]) => n + v.length, 0);
					filters.push((r) => parts.some(([f, v]) => v.includes(r[f.replace(/^r\./, "")])));
					return b;
				}
				if (op === "in") {
					params += (value as unknown[]).length;
					filters.push((r) => (value as unknown[]).includes(r[field as string]));
				} else if (op === "is") filters.push(() => true);
				else {
					params += 1;
					filters.push((r) => r[field as string] === value);
				}
				return b;
			},
			limit(n: number) {
				lim = n;
				params += 1;
				return b;
			},
			offset(n: number) {
				off = n;
				params += 1;
				return b;
			},
			async execute() {
				statements.push(params);
				if (params > D1_LIMIT) throw new Error(`D1_ERROR: too many SQL variables (${params})`);
				if (source === "fields") return [{ collection: "clients", slug: "title", type: "string" }, { collection: "clients", slug: "code", type: "string" }];
				const base = source === "rows" ? rows : edges;
				return base.filter((r) => filters.every((f) => f(r))).slice(off, off + lim);
			},
		};
		return b;
	}
	return {
		statements,
		selectFrom: (table: string) => builder(table.startsWith("ec_") ? "rows" : table.startsWith("_emdash_fields") ? "fields" : "edges"),
	};
}

test("long id, group and field lists stay within D1's parameter limit and return every row", async () => {
	const rows = Array.from({ length: 300 }, (_, i) => ({ id: `c${String(i).padStart(3, "0")}`, translation_group: `g${i}`, code: `CL-${i}`, status: "published" }));
	const db = fakeDb(rows, []);
	const port = new KyselyReadPort(db as never);
	const ids = rows.map((r) => r.id as string);
	assert.equal((await port.rows("clients", { ids, statuses: ["published", "draft"], limit: 1000 })).length, 300);
	assert.equal((await port.rows("clients", { groups: rows.map((r) => r.translation_group as string), limit: 1000 })).length, 300);
	assert.equal((await port.rows("clients", { equals: { field: "code", values: rows.map((r) => r.code as string) }, limit: 250 })).length, 250, "the overall limit still applies");
	const merged = await port.rows("clients", { ids: [...ids].reverse(), limit: 1000 });
	assert.deepEqual(merged.map((r) => r.id), ids, "merged in id order, as one statement would return them");
	assert.ok(db.statements.every((n) => n <= D1_LIMIT), `largest statement bound ${Math.max(...db.statements)} parameters`);
	assert.ok(MAX_IN * 2 + 2 <= D1_LIMIT);
});

test("edges for many groups are read in chunks that fit D1", async () => {
	const edges = Array.from({ length: 200 }, (_, i) => ({ relation: "clients_products", parent_collection: "clients", child_collection: "products", parent_group: `g${i}`, child_group: `p${i}` }));
	const db = fakeDb([], edges);
	const port = new KyselyReadPort(db as never);
	const found = await port.edgesTouching(edges.map((e) => e.parent_group));
	assert.equal(found.length, 200);
	assert.ok(db.statements.every((n) => n <= D1_LIMIT));
});
