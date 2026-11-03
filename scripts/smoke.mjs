#!/usr/bin/env node
// Integration smoke test against a RUNNING Powerfarm EmDash instance.
//
//   POWERFARM_URL=https://powerfarm.example.com POWERFARM_TOKEN=ec_pat_... \
//   POWERFARM_ACCESS_CLIENT_ID=... POWERFARM_ACCESS_CLIENT_SECRET=... node scripts/smoke.mjs
//
// On Cloudflare the site is behind Cloudflare Access: give a service token
// allowed by the Access policy (the same kind of token the bridge uses). The
// checks then prove EmDash's own authentication behind Access, not Access itself;
// scripts/edge-check.mjs proves Access.
//
// The token should belong to an Editor user and carry: content:read, schema:read,
// content:write and mcp:tools:powerfarm (content:write is needed to prove that a
// draft can be prepared but not published over MCP). Every check prints PASS/FAIL.
// It does not touch any device and creates one draft operation and one draft client, which it names.
const base = (process.env.POWERFARM_URL ?? "http://127.0.0.1:4321").replace(/\/+$/, "");
const token = process.env.POWERFARM_TOKEN;
if (!token) {
	console.error("Set POWERFARM_TOKEN (a personal access token for an Editor user).");
	process.exit(2);
}

const accessHeaders = process.env.POWERFARM_ACCESS_CLIENT_ID ? { "cf-access-client-id": process.env.POWERFARM_ACCESS_CLIENT_ID, "cf-access-client-secret": process.env.POWERFARM_ACCESS_CLIENT_SECRET ?? "" } : {};
/** fetch through Cloudflare Access (service token), never following Access's login redirect. */
function pf(url, init = {}) {
	return fetch(url, { ...init, redirect: "manual", headers: { ...accessHeaders, ...(init.headers ?? {}) } });
}

let id = 0;
async function mcp(method, params) {
	const res = await pf(`${base}/_emdash/api/mcp`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
	});
	const text = await res.text();
	const json = text.trim().startsWith("{") ? JSON.parse(text) : JSON.parse(text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) ?? "{}");
	if (json.error) throw new Error(`${method}: ${json.error.message}`);
	return json.result;
}
async function tool(name, args = {}) {
	const r = await mcp("tools/call", { name, arguments: args });
	if (r.isError) throw new Error(r.content?.[0]?.text ?? "tool error");
	return r.structuredContent ?? JSON.parse(r.content?.[0]?.text ?? "null");
}

const results = [];
async function check(name, fn) {
	try {
		const detail = await fn();
		results.push(["PASS", name, detail ?? ""]);
	} catch (e) {
		results.push(["FAIL", name, e.message]);
	}
}
const expect = (cond, message) => {
	if (!cond) throw new Error(message);
};

await check("EmDash health", async () => {
	const r = await pf(`${base}/_emdash/api/health`);
	expect(r.ok, `status ${r.status}`);
});
await check("media files require authentication (patch 0001 + EMDASH_PRIVATE_MEDIA=1)", async () => {
	const r = await pf(`${base}/_emdash/api/media/file/powerfarm-smoke-missing.png`);
	expect(r.status === 401 || r.status === 403, `unauthenticated request got ${r.status}; media is public`);
	return String(r.status);
});
await check("unsigned bridge requests are refused", async () => {
	const r = await pf(`${base}/_emdash/api/plugins/powerfarm/bridge/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
	expect(r.status === 401 || r.status === 503 || r.status === 403, `got ${r.status}`);
	return String(r.status);
});
let tools = [];
await check("Powerfarm MCP tools are registered", async () => {
	tools = (await mcp("tools/list", {})).tools.map((t) => t.name);
	const mine = tools.filter((t) => t.startsWith("powerfarm__"));
	expect(mine.length >= 30, `found ${mine.length}: ${mine.join(", ")}. Enable the plugin's MCP tools in the admin.`);
	return `${mine.length} tools`;
});
await check("collections from the seed exist", async () => {
	const r = await tool("schema_list_collections");
	const slugs = JSON.stringify(r);
	for (const s of ["missions", "assets", "procedures", "recovery_operations", "events", "evidence", "software", "projects", "requirements", "decisions", "tests", "releases", "research", "people", "clients", "products", "services", "service_instances", "contracts", "blueprints", "work_items", "exceptions", "identifiers", "incidents", "mdm_profiles"]) expect(slugs.includes(`"${s}"`), `missing ${s}`);
	return "25 collections";
});
await check("fleet is seeded exactly, LAB 001 out of scope, nothing trusted yet", async () => {
	const f = await tool("powerfarm__get_fleet");
	const titles = f.assets.map((a) => a.title).sort();
	expect(JSON.stringify(titles) === JSON.stringify(["LAB 001", "LAB 256", "LAB 512", "LAB 8GB", "iPhone 13 RED", "iPhone 14 PURPLE", "iPhone 15 BLACK"].sort()), JSON.stringify(titles));
	expect(f.assets.find((a) => a.title === "LAB 001").status === "out_of_scope", "LAB 001 status");
	expect(f.targets === 6, `targets ${f.targets}`);
	expect(f.trusted === 0, `trusted ${f.trusted}`);
	return `${f.assets.length} assets`;
});
await check("graph: mission scopes six assets; identifiers masked", async () => {
	const s = await tool("powerfarm__graph_search", { query: "M001" });
	expect(s.results?.[0]?.type === "mission", "mission not found");
	const n = await tool("powerfarm__graph_get_neighbours", { node: s.results[0].id, edgeTypes: ["scopes"] });
	expect(n.total === 6, `scopes ${n.total}`);
});
await check("an AI client can draft an operation but not publish it", async () => {
	const d = await tool("powerfarm__prepare_recovery_operation", { assetTag: "IPHONE-13-RED", procedureCode: "P-INVENTORY", rationale: "Powerfarm smoke test: verify drafts cannot be published over MCP.", dryRun: true });
	expect(d.status === "draft", `status ${d.status}`);
	let published = false;
	try {
		await tool("content_publish", { collection: "recovery_operations", id: d.id });
		published = true;
	} catch {
		/* expected */
	}
	expect(!published, "content_publish over MCP succeeded: the approval boundary is broken");
	return `draft ${d.opCode} left for you to delete`;
});
await check("1.2: the control catalogue and registration check answer", async () => {
	const c = await tool("powerfarm__get_control_catalogue");
	expect(c.controls && c.controls.owner_assigned, "no control catalogue");
	const r = await tool("powerfarm__check_registration", { collection: "clients", title: `Smoke ${Date.now()}`, identifiers: [{ namespace: "vat", value: "PT999999990" }] });
	expect(Array.isArray(r.duplicates), "no duplicates list");
	return r.ok ? "no duplicates" : `${r.duplicates.length} duplicate(s)`;
});
await check("1.2: an AI client can propose an entity but not register (publish) it", async () => {
	const d = await tool("powerfarm__propose_entity", { collection: "clients", title: "Powerfarm smoke test client (delete me)", fields: { client_kind: "organization" } });
	expect(d.status === "draft", `status ${d.status}`);
	let published = false;
	try {
		await tool("content_publish", { collection: "clients", id: d.id });
		published = true;
	} catch {
		/* expected */
	}
	expect(!published, "content_publish of a client over MCP succeeded: the approval boundary is broken");
	let lifecycle = false;
	try {
		await tool("powerfarm__propose_entity", { collection: "clients", title: "x", fields: { lifecycle: "active" } });
		lifecycle = true;
	} catch {
		/* expected */
	}
	expect(!lifecycle, "an AI proposal set a lifecycle");
	return `draft ${d.code} left for you to delete`;
});
await check("scheduled tasks have run", async () => {
	const s = await tool("powerfarm__get_status");
	const ran = Object.entries(s.tasks).filter(([, t]) => t && t.ok).map(([n]) => n);
	expect(ran.length > 0, "no task has run yet; wait a few minutes after first start");
	return ran.join(", ");
});

for (const [status, name, detail] of results) console.log(`${status} ${name}${detail ? ` — ${detail}` : ""}`);
process.exitCode = results.some(([s]) => s === "FAIL") ? 1 : 0;
