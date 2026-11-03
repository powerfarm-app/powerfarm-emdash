// scripts/release.mjs against the plugin's own release routes (Node's HMAC
// signer against the Worker's WebCrypto verifier), and the edge check's OIDC
// Bypass checks.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";

import { deploy, draft } from "../../scripts/release.mjs";
import { edgeCheck } from "../../scripts/edge-check.mjs";
import { identityRoutes } from "../src/identity-routes.ts";
import { RELEASE_SETTINGS } from "../src/release.ts";
import { ADMIN, makeWorld, type World } from "./entity-world.ts";

let w: World;
const routes = identityRoutes();
const settings = () => (w.ctx as unknown as { settings: { values: Record<string, unknown> } }).settings.values;
const journal = () => [...w.ctx.storage.journal.rows.values()].map((r) => r.value as { type: string });

beforeEach(() => {
	w = makeWorld();
	Object.assign(settings(), {
		[RELEASE_SETTINGS.ciClientId]: "ci",
		[RELEASE_SETTINGS.ciSecret]: "c".repeat(64),
		[RELEASE_SETTINGS.ciAgent]: "agents:AG-0002",
		[RELEASE_SETTINGS.releaseClientId]: "release",
		[RELEASE_SETTINGS.releaseSecret]: "r".repeat(64),
	});
});

/** A fetch that hands the request to the plugin route, the way EmDash would after Access let it through. */
const viaPlugin = (seen: string[]) =>
	(async (url: string, init: RequestInit) => {
		const name = new URL(url).pathname.replace("/_emdash/api/plugins/powerfarm/", "");
		seen.push(`${name} access=${new Headers(init.headers).get("cf-access-client-id")}`);
		const route = routes[name] as unknown as { handler: (ctx: unknown) => Promise<unknown> };
		try {
			const data = await route.handler({ ...w.ctx, input: String(init.body), request: new Request(url, { method: "POST", headers: init.headers }), requestMeta: { ip: null } });
			return Response.json({ success: true, data });
		} catch (e) {
			const err = e as { code?: string; message: string; status?: number };
			return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status ?? 500 });
		}
	}) as typeof fetch;

test("CI drafts, a person approves in EmDash, the release service deploys that exact artifact once and reports it", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pf-rel-"));
	const artifact = path.join(dir, "site.tgz");
	writeFileSync(artifact, "built site v1.4.0");
	const seen: string[] = [];
	const common = { url: "https://powerfarm.example.org", artifact, repo: "powerfarm", commit: "abcdef1234567", version: "1.4.0", env: "production", access: { clientId: "rel.access", clientSecret: "x" }, fetchImpl: viaPlugin(seen) };

	const d = (await draft({ ...common, id: "ci", secret: "c".repeat(64), testsPassed: 178, testsFailed: 0 })) as { id: string };
	const ran: string[][] = [];
	const run = (cmd: string[]) => (ran.push(cmd), { status: 0 });
	await assert.rejects(deploy({ ...common, id: "release", secret: "r".repeat(64) }, ["wrangler", "deploy"], run), /NOT_APPROVED/);
	assert.equal(ran.length, 0, "nothing runs before a person approves");

	assert.equal(await w.publishAs(ADMIN, "releases", d.id), undefined, "a person who is not the author publishes (approves) the release");
	writeFileSync(artifact, "something else");
	await assert.rejects(deploy({ ...common, id: "release", secret: "r".repeat(64) }, ["wrangler", "deploy"], run), /DIGEST_MISMATCH/);
	assert.equal(ran.length, 0, "a different artifact is never deployed");

	writeFileSync(artifact, "built site v1.4.0");
	const r = await deploy({ ...common, id: "release", secret: "r".repeat(64) }, ["wrangler", "deploy"], run);
	assert.equal(r.ok, true);
	assert.deepEqual(ran, [["wrangler", "deploy"]]);
	assert.ok(journal().some((e) => e.type === "release.deployed"));
	assert.ok(seen.every((s) => s.endsWith("access=rel.access")), "every call carries the Access service token");
	await assert.rejects(draft({ ...common, id: "ci", secret: "wrong-but-long-enough-wrong-but-long-enough", testsPassed: 1, testsFailed: 0 }), /BAD_SIGNATURE/);
});

test("edge check --oidc: the provider's paths are open to browsers, the rest of Identity is not", async () => {
	const res = (status: number, body = "", headers: Record<string, string> = {}) => new Response(body, { status, headers });
	const good = (async (url: string) => {
		if (url.endsWith("/oidc/jwks")) return res(200, '{"keys":[{"kty":"RSA","n":"x","e":"AQAB","kid":"k"}]}', { "content-type": "application/json" });
		if (url.endsWith("/oidc/token")) return res(401, '{"error":"invalid_client"}', { "content-type": "application/json" });
		if (url.endsWith("/oidc/continue") || url.endsWith("/_emdash/admin/login")) return res(200, "<!doctype html>", { "content-type": "text/html" });
		return res(302, "", { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" });
	}) as typeof fetch;
	const ok = await edgeCheck({ url: "https://powerfarm.example.org", oidc: true, fetchImpl: good });
	assert.deepEqual(ok.filter(([s]: string[]) => s === "FAIL"), []);
	const closed = (async () => res(302, "", { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" })) as typeof fetch;
	const bad = await edgeCheck({ url: "https://powerfarm.example.org", oidc: true, fetchImpl: closed });
	assert.ok(bad.some(([s, n]: string[]) => s === "FAIL" && /OIDC keys/.test(n)), "a sign-in loop is caught before people hit it");
	const leakyKeys = (async (url: string) => (url.endsWith("/oidc/jwks") ? res(200, '{"keys":[{"d":"secret"}]}') : good(url))) as typeof fetch;
	assert.ok((await edgeCheck({ url: "https://powerfarm.example.org", oidc: true, fetchImpl: leakyKeys })).some(([s, , d]: string[]) => s === "FAIL" && /private key/.test(d)));
});
