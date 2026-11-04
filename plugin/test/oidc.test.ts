// Powerfarm Identity through its EmDash routes: the OIDC provider Cloudflare
// Access trusts (authorize → site page → continue → token, PKCE, single use,
// suspension wins), the published keys, whoami behind Access, the Access logs
// task, and the signed release routes.
//
// These call the route handlers with EmDash's route context shape. They do not
// run EmDash's dispatcher, Cloudflare Access or a browser (docs/IDENTITY.md,
// live checks).
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { AUTHORITY_SETTING } from "../src/authority.ts";
import { canonicalString, HEADER, sha256Hex, sign } from "../src/bridge-auth.ts";
import { accessLogsTask, CF_SETTINGS } from "../src/cloudflare.ts";
import { identityRoutes } from "../src/identity-routes.ts";
import { b64url, generateSigningKey, publicJwk, signJwt, verifyJwt } from "../src/jwt.ts";
import { RELEASE_SETTINGS } from "../src/release.ts";
import { ADMIN, EDITOR, makeWorld, type World } from "./entity-world.ts";

let w: World;
let orgId: string | null = null;
const routes = identityRoutes();
const settings = () => (w.ctx as unknown as { settings: { values: Record<string, unknown> } }).settings.values;
const journal = () => [...w.ctx.storage.journal.rows.values()].map((r) => r.value as { type: string; payload?: Record<string, unknown> });
const ORIGIN = "https://powerfarm.example.org";
const REDIRECT = "https://team.cloudflareaccess.com/cdn-cgi/access/callback";

beforeEach(() => {
	w = makeWorld();
	orgId = null;
});

type Handler = (ctx: unknown) => Promise<unknown>;
async function call(name: string, opts: { input?: unknown; user?: { id: string; role: number; email?: string; emailVerified?: boolean } | null; headers?: Record<string, string>; url?: string } = {}) {
	const route = routes[name] as unknown as { handler: Handler; input?: { parse(v: unknown): unknown } };
	const input = route.input ? route.input.parse(opts.input ?? {}) : opts.input;
	const request = new Request(opts.url ?? `${ORIGIN}/_emdash/api/plugins/powerfarm/${name}`, { headers: opts.headers ?? {} });
	return route.handler({ ...w.ctx, input, user: opts.user ?? undefined, request, requestMeta: { ip: null } });
}
const raw = (r: unknown) => r as { status: number; headers: Array<[string, string]>; body: { kind: string; value: string } | null };
const header = (r: unknown, name: string) => raw(r).headers.find(([k]) => k === name)?.[1];
const bodyOf = (r: unknown) => JSON.parse(raw(r).body!.value);

async function activePerson(user: { id: string }, title: string, extra: Record<string, unknown> = {}) {
	orgId ??= w.db.insert("organizations", { title: "Powerfarm", code: "OR-0001", lifecycle: "active", classification: "internal" }, { status: "published" }).id;
	const d = await w.draftAs(ADMIN, "people", { title, identifiers: [{ namespace: "emdash_user", value: user.id }], ...extra }, { owner: [orgId] });
	assert.equal(await w.publishAs(ADMIN, "people", d.id), undefined);
	await w.editAs(ADMIN, "people", d.id, { lifecycle: "active" });
	assert.equal(await w.publishAs(ADMIN, "people", d.id), undefined);
	return { id: d.id, subject: `people:${String(w.row("people", d.id)!.code)}`, principalId: String(w.row("people", d.id)!.principal_id) };
}

async function setUpProvider() {
	const key = (await call("identity/oidc/rotate-key", { user: ADMIN })) as { kid: string };
	const client = (await call("identity/oidc/client", { user: ADMIN, input: { client_id: "cloudflare-access", redirect_uris: [REDIRECT], name: "Cloudflare Access" } })) as { client_id: string; client_secret: string };
	return { kid: key.kid, secret: client.client_secret };
}

async function pkce() {
	const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	return { verifier, challenge };
}

async function authorizeAndContinue(user: { id: string; role: number; email?: string; emailVerified?: boolean }, challenge: string) {
	const q = { client_id: "cloudflare-access", redirect_uri: REDIRECT, response_type: "code", scope: "openid email profile groups", state: "st-123", nonce: "n-456", code_challenge: challenge, code_challenge_method: "S256" };
	const start = await call("oidc/authorize", { input: q });
	assert.equal(raw(start).status, 302);
	const next = new URL(header(start, "location")!, ORIGIN);
	assert.equal(next.origin, ORIGIN, "authorize only ever sends the browser to the same origin");
	assert.equal(next.pathname, "/oidc/continue");
	const rid = next.searchParams.get("rid")!;
	const done = (await call("oidc/continue", { user, input: { rid } })) as { location: string };
	return new URL(done.location);
}

function tokenForm(fields: Record<string, string>) {
	return { entries: Object.entries(fields).map(([name, value]) => ({ name, kind: "text", value })) };
}
const basic = (id: string, secret: string) => `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`;

test("sign-in: authorize → continue (signed-in, active person) → token with PKCE; the ID token verifies against the published keys", async () => {
	const dan = await activePerson(ADMIN, "Dan", { contact_email: "Dan@Example.org", access_groups: ["administrators", "not-a-group"] });
	const { secret, kid } = await setUpProvider();
	const { verifier, challenge } = await pkce();
	const back = await authorizeAndContinue(ADMIN, challenge);
	assert.equal(back.origin + back.pathname, REDIRECT);
	assert.equal(back.searchParams.get("state"), "st-123");
	const code = back.searchParams.get("code")!;
	assert.ok(code);

	const tok = await call("oidc/token", { input: tokenForm({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }), headers: { authorization: basic("cloudflare-access", secret) } });
	assert.equal(raw(tok).status, 200, raw(tok).body?.value);
	const idToken = bodyOf(tok).id_token as string;
	const keys = bodyOf(await call("oidc/jwks")).keys;
	assert.equal(keys[0].kid, kid);
	assert.equal(keys[0].d, undefined, "the private part is never published");
	const claims = await verifyJwt(idToken, keys, { issuer: `${ORIGIN}/_emdash/api/plugins/powerfarm/oidc`, audiences: ["cloudflare-access"] });
	assert.equal(claims.sub, dan.principalId, "sub is the permanent principal id, not the e-mail or the EmDash user id");
	assert.equal(claims.email, "dan@example.org");
	assert.equal(claims.nonce, "n-456");
	assert.deepEqual(claims.groups, ["administrators"], "only known access groups are sent; grants never are");
	assert.ok(journal().some((e) => e.type === "oidc.issued"));

	const again = await call("oidc/token", { input: tokenForm({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }), headers: { authorization: basic("cloudflare-access", secret) } });
	assert.equal(raw(again).status, 400);
	assert.equal(bodyOf(again).error, "invalid_grant", "a code works once");

	const disc = bodyOf(await call("oidc/openid-configuration"));
	assert.equal(disc.issuer, claims.iss);
	assert.deepEqual(disc.code_challenge_methods_supported, ["S256"]);
});

test("refusals: unknown client or redirect, wrong secret, wrong PKCE verifier, no session, no person, a person suspended before the token", async () => {
	await activePerson(ADMIN, "Dan", { contact_email: "dan@example.org" });
	const { secret } = await setUpProvider();
	const bad = await call("oidc/authorize", { input: { client_id: "cloudflare-access", redirect_uri: "https://evil.example/cb", response_type: "code", scope: "openid", state: "s" } });
	assert.equal(raw(bad).status, 400, "an unregistered redirect is refused, never followed");
	assert.equal(header(bad, "location"), undefined);
	const dup = await call("oidc/authorize", { input: { client_id: "cloudflare-access", redirect_uri: [REDIRECT, "https://evil.example/cb"], response_type: "code", scope: "openid", state: "s" } });
	assert.equal(raw(dup).status, 400, "a repeated parameter is invalid, not first-wins");

	const { verifier, challenge } = await pkce();
	const code = (await authorizeAndContinue(ADMIN, challenge)).searchParams.get("code")!;
	const wrongSecret = await call("oidc/token", { input: tokenForm({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }), headers: { authorization: basic("cloudflare-access", "nope") } });
	assert.equal(raw(wrongSecret).status, 401);
	const wrongVerifier = await call("oidc/token", { input: tokenForm({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: "x".repeat(43) }), headers: { authorization: basic("cloudflare-access", secret) } });
	assert.equal(bodyOf(wrongVerifier).error, "invalid_grant");

	await assert.rejects(call("oidc/continue", { user: null, input: { rid: "a".repeat(32) } }), (e: { status?: number }) => e.status === 401, "continue needs an EmDash session");
	await assert.rejects(call("oidc/continue", { user: ADMIN, input: { rid: "a".repeat(32) }, headers: { authorization: "Bearer ec_pat_x" } }), /only available in the EmDash admin/, "and never an API token");

	const stranger = await authorizeAndContinue(EDITOR, challenge);
	assert.equal(stranger.searchParams.get("error"), "access_denied", "an EmDash user without a Powerfarm person gets no code");
	assert.equal(stranger.searchParams.get("code"), null);

	// Suspended between sign-in and token exchange: the suspension wins.
	const p2 = await pkce();
	const code2 = (await authorizeAndContinue(ADMIN, p2.challenge)).searchParams.get("code")!;
	const dan = w.db.db.prepare("select id from ec_people where title = 'Dan'").get() as { id: string };
	await w.editAs(ADMIN, "people", dan.id, { lifecycle: "suspended" });
	assert.equal(await w.publishAs(ADMIN, "people", dan.id), undefined);
	const late = await call("oidc/token", { input: tokenForm({ grant_type: "authorization_code", code: code2, redirect_uri: REDIRECT, code_verifier: p2.verifier }), headers: { authorization: basic("cloudflare-access", secret) } });
	assert.equal(bodyOf(late).error, "invalid_grant");
	const p3 = await pkce();
	assert.equal((await authorizeAndContinue(ADMIN, p3.challenge)).searchParams.get("error"), "access_denied", "and no new sign-in starts");
});

test("key rotation and client registration are governed: refused without idp.keys / idp.config once enforced; clients never live in settings", async () => {
	await activePerson(ADMIN, "Dan");
	settings()[AUTHORITY_SETTING] = "idp.keys,idp.config";
	await assert.rejects(call("identity/oidc/rotate-key", { user: ADMIN }), /Not authorised/);
	await assert.rejects(call("identity/oidc/client", { user: ADMIN, input: { client_id: "cloudflare-access", redirect_uris: [REDIRECT] } }), /Not authorised/);
	await assert.rejects(call("identity/oidc/rotate-key", { user: ADMIN, headers: { authorization: "Bearer ec_pat_x" } }), /only available in the EmDash admin/);
	assert.ok(journal().some((e) => e.type === "authority.denied"));
	settings()[AUTHORITY_SETTING] = "";
	const first = (await call("identity/oidc/rotate-key", { user: ADMIN })) as { kid: string };
	const second = (await call("identity/oidc/rotate-key", { user: ADMIN })) as { kid: string; previousKid: string };
	assert.equal(second.previousKid, first.kid);
	assert.deepEqual(bodyOf(await call("oidc/jwks")).keys.map((k: { kid: string }) => k.kid), [second.kid, first.kid], "the previous key stays published");
	await call("identity/oidc/client", { user: ADMIN, input: { client_id: "cloudflare-access", redirect_uris: [REDIRECT] } });
	assert.ok(!Object.keys(settings()).some((k) => /client/i.test(k)), "registered clients are in plugin KV, out of the settings screen's reach");
	assert.ok(!JSON.stringify(journal()).includes("client_secret\":\""), "the client secret is never journalled");
});

test("whoami behind Access: the person is found by the pf_principal_id claim Cloudflare copies from Powerfarm's ID token, never by e-mail; inactive is refused", async () => {
	const dan = await activePerson(ADMIN, "Dan", { contact_email: "dan@example.org" });
	const ana = await activePerson(EDITOR, "Ana", { contact_email: "ana@example.org" });
	const team = "team.cloudflareaccess.com";
	settings()[CF_SETTINGS.teamDomain] = team;
	settings()[CF_SETTINGS.audiences] = "aud-free-zone";
	const accessKey = await generateSigningKey();
	const now = Math.floor(Date.now() / 1000);
	await w.ctx.kv.set(`access:certs:${team}`, { at: now, keys: [publicJwk(accessKey)] });
	const assertion = (claims: Record<string, unknown>) => signJwt({ iss: `https://${team}`, aud: ["aud-free-zone"], iat: now, exp: now + 300, sub: "cf-user-1", email: "dan@example.org", ...claims }, accessKey);
	const who = async (claims: Record<string, unknown>) => call("identity/whoami-access", { headers: { "cf-access-jwt-assertion": await assertion(claims) } });

	assert.equal(raw(await who({})).status, 404, "no pf_principal_id: a break-glass PIN or another IdP is not a Powerfarm principal");
	const ok = await who({ oidc_fields: { pf_principal_id: dan.principalId } });
	assert.equal(raw(ok).status, 200, raw(ok).body?.value);
	assert.equal(bodyOf(ok).principal.principalId, dan.principalId);

	// Identity continuity: the claim decides, the e-mail does not.
	const reassigned = await who({ email: "dan@example.org", oidc_fields: { pf_principal_id: ana.principalId } });
	assert.equal(bodyOf(reassigned).principal.principalId, ana.principalId, "an e-mail that once was Dan's never makes someone Dan");
	assert.equal(raw(await who({ oidc_fields: { pf_principal_id: "00000000-0000-4000-8000-000000000000" } })).status, 404);
	assert.equal(raw(await who({ oidc_fields: { pf_principal_id: "people:PE-0001" } })).status, 404, "only a principal id, not a code or an e-mail");

	assert.equal(raw(await who({ aud: ["another-app"], oidc_fields: { pf_principal_id: dan.principalId } })).status, 401);
	assert.equal(raw(await who({ email: undefined, oidc_fields: { pf_principal_id: dan.principalId } })).status, 401, "service tokens carry no person");
	assert.equal(raw(await who({ exp: now - 3600, oidc_fields: { pf_principal_id: dan.principalId } })).status, 401);
	const forged = await signJwt({ iss: `https://${team}`, aud: ["aud-free-zone"], exp: now + 300, sub: "x", email: "dan@example.org", oidc_fields: { pf_principal_id: dan.principalId } }, await generateSigningKey());
	assert.equal(raw(await call("identity/whoami-access", { headers: { "cf-access-jwt-assertion": forged } })).status, 401, "a token not signed by the team's key is refused");
	assert.equal(raw(await call("identity/whoami-access")).status, 401);

	// A suspended person keeps a Cloudflare session until it expires or is revoked; Powerfarm refuses it at once.
	await w.editAs(ADMIN, "people", ana.id, { lifecycle: "suspended" });
	assert.equal(await w.publishAs(ADMIN, "people", ana.id), undefined);
	const refused = await who({ oidc_fields: { pf_principal_id: ana.principalId } });
	assert.equal(raw(refused).status, 403);
	assert.equal(bodyOf(refused).error, "principal_inactive");

	const me = (await call("identity/whoami", { user: ADMIN })) as { principal: { subject: string } };
	assert.equal(me.principal.subject, dan.subject);
});

test("PKCE is mandatory: no challenge, plain, a malformed challenge or verifier are refused; a wrong verifier does not burn the code", async () => {
	await activePerson(ADMIN, "Dan", { contact_email: "dan@example.org" });
	const { secret } = await setUpProvider();
	const base = { client_id: "cloudflare-access", redirect_uri: REDIRECT, response_type: "code", scope: "openid email", state: "s" };
	assert.match(bodyOf(await call("oidc/authorize", { input: base })).error_description, /code_challenge is required/);
	assert.match(bodyOf(await call("oidc/authorize", { input: { ...base, code_challenge: "x".repeat(43) } })).error_description, /Only S256/, "a missing method is not S256");
	assert.match(bodyOf(await call("oidc/authorize", { input: { ...base, code_challenge: "x".repeat(43), code_challenge_method: "plain" } })).error_description, /Only S256/);
	assert.match(bodyOf(await call("oidc/authorize", { input: { ...base, code_challenge: "short", code_challenge_method: "S256" } })).error_description, /Invalid S256/);

	const { verifier, challenge } = await pkce();
	const code = (await authorizeAndContinue(ADMIN, challenge)).searchParams.get("code")!;
	const exchange = (v: string | undefined) => call("oidc/token", { input: tokenForm({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, ...(v === undefined ? {} : { code_verifier: v }) }), headers: { authorization: basic("cloudflare-access", secret) } });
	assert.match(bodyOf(await exchange(undefined)).error_description, /Invalid PKCE code_verifier/);
	assert.match(bodyOf(await exchange("too-short")).error_description, /Invalid PKCE code_verifier/);
	assert.match(bodyOf(await exchange("a".repeat(43) + "!")).error_description, /Invalid PKCE code_verifier/);
	assert.match(bodyOf(await exchange("b".repeat(64))).error_description, /PKCE verification failed/);
	const good = await exchange(verifier);
	assert.equal(raw(good).status, 200, "the right client still redeems its code after an attacker's wrong verifiers");
	assert.equal(bodyOf(await exchange(verifier)).error, "invalid_grant", "and only once");
});

test("two simultaneous exchanges of one code: exactly one ID token", async () => {
	await activePerson(ADMIN, "Dan", { contact_email: "dan@example.org" });
	const { secret } = await setUpProvider();
	const { verifier, challenge } = await pkce();
	const code = (await authorizeAndContinue(ADMIN, challenge)).searchParams.get("code")!;
	const one = () => call("oidc/token", { input: tokenForm({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }), headers: { authorization: basic("cloudflare-access", secret) } });
	const results = await Promise.all([one(), one(), one()]);
	assert.equal(results.filter((r) => raw(r).status === 200).length, 1);
});

test("email_verified only when EmDash verified the account's address and it is the person's Powerfarm address; claims carry pf_principal_id", async () => {
	const dan = await activePerson(ADMIN, "Dan", { contact_email: "Dan@Example.org" });
	const { secret } = await setUpProvider();
	const keys = async () => bodyOf(await call("oidc/jwks")).keys;
	const claimsFor = async (user: { id: string; role: number; email?: string; emailVerified?: boolean }) => {
		const { verifier, challenge } = await pkce();
		const code = (await authorizeAndContinue(user, challenge)).searchParams.get("code")!;
		const tok = await call("oidc/token", { input: tokenForm({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }), headers: { authorization: basic("cloudflare-access", secret) } });
		return verifyJwt(bodyOf(tok).id_token, await keys(), { issuer: `${ORIGIN}/_emdash/api/plugins/powerfarm/oidc`, audiences: ["cloudflare-access"] });
	};
	const passkeyOnly = await claimsFor({ ...ADMIN, email: "dan@example.org", emailVerified: false });
	assert.equal(passkeyOnly.email_verified, false, "a passkey account's address was never verified");
	assert.equal(passkeyOnly.pf_principal_id, dan.principalId);
	assert.equal(passkeyOnly.sub, dan.principalId);
	assert.equal((await claimsFor({ ...ADMIN, email: "DAN@example.org", emailVerified: true })).email_verified, true, "verified by EmDash and the same address (case-insensitive)");
	assert.equal((await claimsFor({ ...ADMIN, email: "other@example.org", emailVerified: true })).email_verified, false, "verified, but not the address on the person record");
	assert.equal((await claimsFor({ ...ADMIN })).email_verified, false, "unknown verification state is not verification");

	// The person's address changes between sign-in and token: the old verification does not carry over.
	const { verifier, challenge } = await pkce();
	const code = (await authorizeAndContinue({ ...ADMIN, email: "dan@example.org", emailVerified: true }, challenge)).searchParams.get("code")!;
	await w.editAs(ADMIN, "people", dan.id, { contact_email: "dan@new.example.org" });
	assert.equal(await w.publishAs(ADMIN, "people", dan.id), undefined);
	const tok = await call("oidc/token", { input: tokenForm({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier }), headers: { authorization: basic("cloudflare-access", secret) } });
	const changed = await verifyJwt(bodyOf(tok).id_token, await keys(), { issuer: `${ORIGIN}/_emdash/api/plugins/powerfarm/oidc`, audiences: ["cloudflare-access"] });
	assert.equal(changed.email, "dan@new.example.org");
	assert.equal(changed.email_verified, false);
	assert.equal(changed.pf_principal_id, dan.principalId, "the principal never changes with the address");
});

test("one canonical issuer from EmDash's site URL, whatever hostname a request arrives on; none without it", async () => {
	await activePerson(ADMIN, "Dan", { contact_email: "dan@example.org" });
	const viaAlias = bodyOf(await call("oidc/openid-configuration", { url: "https://alias.example.net/_emdash/api/plugins/powerfarm/oidc/openid-configuration" }));
	assert.equal(viaAlias.issuer, `${ORIGIN}/_emdash/api/plugins/powerfarm/oidc`);
	assert.deepEqual(viaAlias.code_challenge_methods_supported, ["S256"]);
	assert.ok(viaAlias.claims_supported.includes("pf_principal_id"));
	const site = (w.ctx as unknown as { site: { url: string } }).site;
	site.url = "";
	assert.equal(raw(await call("oidc/openid-configuration")).status, 503, "no EMDASH_SITE_URL, no issuer");
	site.url = "http://powerfarm.example.org";
	assert.equal(raw(await call("oidc/openid-configuration")).status, 503, "production issuers are https");
	site.url = "https://powerfarm.example.org/sub";
	assert.equal(raw(await call("oidc/openid-configuration")).status, 503);
});

test("Access logs: refused sign-ins and a first sign-in from a new country become incidents; nothing is read without a token", async () => {
	const ctx = w.ctx as unknown as Parameters<typeof accessLogsTask>[0];
	assert.deepEqual(await accessLogsTask(ctx), { skipped: 1 });
	settings()[CF_SETTINGS.accountId] = "acc123";
	settings()[CF_SETTINGS.apiToken] = "t".repeat(40);
	const calls: string[] = [];
	const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
	const rows = [
		{ user_email: "dan@example.org", allowed: true, country: "BR", ip_address: "1.1.1.1", created_at: at(40) },
		{ user_email: "dan@example.org", allowed: true, country: "BR", created_at: at(30) },
		{ user_email: "dan@example.org", allowed: true, country: "RO", ip_address: "5.5.5.5", created_at: at(20) },
		{ user_email: "eve@example.org", allowed: false, country: "XX", app_domain: "powerfarm.example.org", created_at: at(10) },
	];
	(ctx as unknown as { http: unknown }).http = { fetch: async (url: string, init?: RequestInit) => (calls.push(`${url} ${new Headers(init?.headers).get("authorization")?.slice(0, 7)}`), Response.json({ result: rows })) };
	const r = await accessLogsTask(ctx);
	assert.deepEqual(r, { read: 4, refused: 1, newCountry: 1 });
	assert.match(calls[0]!, /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/acc123\/access\/logs\/access_requests\?since=/);
	const incidents = w.db.db.prepare("select rule, severity from ec_incidents").all() as Array<{ rule: string }>;
	assert.deepEqual(incidents.map((i) => i.rule).sort(), ["access_new_country", "access_refused"]);
	assert.equal(await w.ctx.kv.get("access-logs:since"), new Date(Date.parse(rows[3]!.created_at) + 1).toISOString(), "the next run starts just after the last row it read");
});

async function signed(name: string, body: unknown, id: string, secret: string) {
	const text = JSON.stringify(body);
	const ts = String(Math.floor(Date.now() / 1000));
	const nonce = b64url(crypto.getRandomValues(new Uint8Array(18)));
	const sig = await sign(secret, canonicalString(ts, nonce, `powerfarm/${name}`, await sha256Hex(text)));
	return { input: text, headers: { [HEADER.bridge]: id, [HEADER.timestamp]: ts, [HEADER.nonce]: nonce, [HEADER.signature]: sig } };
}

test("release routes: CI drafts with its own secret; the release service's secret cannot draft and CI's cannot authorise; replays are refused", async () => {
	settings()[RELEASE_SETTINGS.ciClientId] = "ci";
	settings()[RELEASE_SETTINGS.ciSecret] = "c".repeat(64);
	settings()[RELEASE_SETTINGS.ciAgent] = "agents:AG-0002";
	settings()[RELEASE_SETTINGS.releaseClientId] = "release";
	settings()[RELEASE_SETTINGS.releaseSecret] = "r".repeat(64);
	const draft = { repository: "powerfarm", commit: "abcdef1234567", artifactDigest: `sha256:${"a".repeat(64)}`, environment: "production", version: "1.4.0", testsPassed: 145, testsFailed: 0 };

	const req = await signed("release/draft", draft, "ci", "c".repeat(64));
	const made = (await call("release/draft", req)) as { id: string; created: boolean };
	assert.equal(made.created, true);
	assert.equal(w.row("releases", made.id)!.status, "draft", "CI drafts; publishing (approval) is a person's");
	await assert.rejects(call("release/draft", req), (e: { code?: string }) => e.code === "REPLAYED");
	await assert.rejects(call("release/draft", await signed("release/draft", draft, "release", "r".repeat(64))), (e: { code?: string }) => e.code === "UNKNOWN_BRIDGE");
	await assert.rejects(call("release/authorize", await signed("release/authorize", { version: "1.4.0", repository: "powerfarm", commit: "abcdef1234567", artifactDigest: draft.artifactDigest, environment: "production" }, "ci", "c".repeat(64))), (e: { code?: string }) => e.code === "UNKNOWN_BRIDGE");
	const unapproved = call("release/authorize", await signed("release/authorize", { version: "1.4.0", repository: "powerfarm", commit: "abcdef1234567", artifactDigest: draft.artifactDigest, environment: "production" }, "release", "r".repeat(64)));
	await assert.rejects(unapproved, (e: { status?: number }) => (e.status ?? 0) >= 400, "nothing is authorised to deploy before a person approves");
	await assert.rejects(call("release/draft", await signed("release/draft", { ...draft, testsFailed: 1 }, "ci", "c".repeat(64))), (e: { code?: string }) => e.code === "TESTS_FAILED");
});
