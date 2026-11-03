// The bridge reaching EmDash on Cloudflare through Access.
import assert from "node:assert/strict";
import { test } from "node:test";

import { EmDashClient } from "../src/client.mjs";
import { isPermanent } from "../src/outbox.mjs";

const secret = "s".repeat(40);

test("every call carries the Access service token and the bridge signature, and never follows Access's login redirect", async () => {
	let seen;
	const fetchImpl = async (url, init) => ((seen = { url, init }), new Response(JSON.stringify({ data: { job: null } }), { status: 200 }));
	const c = new EmDashClient({ baseUrl: "https://powerfarm.example.com/", bridgeId: "lab-512-bridge", secret, access: { clientId: "id.access", clientSecret: "tok" }, fetchImpl });
	assert.deepEqual(await c.claim({}), { job: null });
	assert.equal(seen.url, "https://powerfarm.example.com/_emdash/api/plugins/powerfarm/bridge/claim");
	assert.equal(seen.init.headers["cf-access-client-id"], "id.access");
	assert.equal(seen.init.headers["cf-access-client-secret"], "tok");
	assert.ok(seen.init.headers["x-powerfarm-signature"]);
	assert.equal(seen.init.redirect, "manual");
});

test("a refusal at Cloudflare's edge is reported as such and kept retryable; EmDash's own refusals are permanent", async () => {
	const login = async () => new Response("", { status: 302, headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" } });
	const c = new EmDashClient({ baseUrl: "https://powerfarm.example.com", bridgeId: "b", secret, fetchImpl: login });
	const edge = await c.claim({}).catch((e) => e);
	assert.match(edge.message, /Cloudflare Access refused/);
	assert.equal(isPermanent(edge), false);
	const html403 = async () => new Response("<html>Forbidden</html>", { status: 403 });
	assert.match((await new EmDashClient({ baseUrl: "https://powerfarm.example.com", bridgeId: "b", secret, fetchImpl: html403 }).claim({}).catch((e) => e)).message, /Cloudflare Access refused/);
	const lease = async () => new Response(JSON.stringify({ error: { code: "LEASE_MISMATCH", message: "x" } }), { status: 409 });
	assert.equal(isPermanent(await new EmDashClient({ baseUrl: "https://powerfarm.example.com", bridgeId: "b", secret, fetchImpl: lease }).claim({}).catch((e) => e)), true);
	const released = async () => new Response(JSON.stringify({ error: { code: "NOT_YOUR_JOB", message: "lease released" } }), { status: 403 });
	assert.equal(isPermanent(await new EmDashClient({ baseUrl: "https://powerfarm.example.com", bridgeId: "b", secret, fetchImpl: released }).claim({}).catch((e) => e)), true, "a lease released during an outage is set aside, not retried forever");
	const disabled = async () => new Response(JSON.stringify({ error: { code: "BRIDGE_DISABLED", message: "off" } }), { status: 403 });
	assert.equal(isPermanent(await new EmDashClient({ baseUrl: "https://powerfarm.example.com", bridgeId: "b", secret, fetchImpl: disabled }).claim({}).catch((e) => e)), false, "a disabled bridge keeps its results until re-enabled");
});

test("plain http is refused for anything but a private address", () => {
	assert.throws(() => new EmDashClient({ baseUrl: "http://powerfarm.example.com", bridgeId: "b", secret }), /https/);
	assert.ok(new EmDashClient({ baseUrl: "http://192.168.64.2:4321", bridgeId: "b", secret }));
});
