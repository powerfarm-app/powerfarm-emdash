/**
 * Powerfarm as the OpenID Connect provider Cloudflare Access trusts.
 *
 *   GET  oidc/authorize   (public)   checks the client, redirect URI, state, nonce and PKCE,
 *                                    keeps the request for 10 minutes, sends the browser to
 *                                    the site page /oidc/continue
 *   /oidc/continue        (site page, site/src/pages/oidc/continue.astro) calls
 *   POST oidc/continue    (private, session) with EmDash's CSRF header; not signed in →
 *                                    EmDash's own sign-in (passkey) and back. Maps the EmDash
 *                                    user to a Powerfarm person; only an active person gets a
 *                                    single-use code (60 s); the page then navigates to the client.
 *
 * Why a page in between: EmDash gives public plugin routes no user, and private
 * routes accept a session only with the X-EmDash-Request header, which a
 * top-level browser redirect cannot carry. The page is static and holds no logic.
 *   POST oidc/token       (public)   client secret + code + PKCE verifier → ID token
 *   GET  oidc/jwks        (public)   the public signing keys (current and previous)
 *   GET  oidc/openid-configuration  discovery document, for reference
 *
 * Claims: `sub` = the person's permanent principal_id (opaque); `email` = their
 * contact e-mail (Cloudflare requires one; it is never Powerfarm's identity key);
 * `groups` = coarse access groups from the person record. Grants are never
 * sent: Powerfarm decides authority itself, on every operation.
 *
 * No login loop: Cloudflare Access must Bypass only the `oidc/` routes and
 * EmDash's sign-in page and endpoints (docs/IDENTITY.md); every other admin
 * call still needs an EmDash session.
 */

import { principalOf, type Principal } from "./authority.js";
import type { ContentReader } from "./content.js";
import { b64url, generateSigningKey, publicJwk, signJwt, type PrivateJwk } from "./jwt.js";
import { record } from "./journal.js";

/** Signing keys are secret plugin settings (encrypted with EMDASH_ENCRYPTION_KEY, never shown back). */
export const OIDC_SETTINGS = { signingKey: "oidcSigningKey", previousKey: "oidcSigningKeyPrevious" } as const;
/** Registered clients live in plugin KV, not settings, so the settings screen cannot add one around idp.config. */
const CLIENTS_KEY = "oidc:clients";
export const OIDC_BASE = "/_emdash/api/plugins/powerfarm/oidc";
/** The static site page that finishes sign-in (site/src/pages/oidc/continue.astro). */
export const CONTINUE_PAGE = "/oidc/continue";
const REQUEST_TTL_MS = 10 * 60_000;
const CODE_TTL_MS = 60_000;
const TOKEN_TTL_S = 300;
export const ACCESS_GROUPS = ["staff", "engineering", "operations", "administrators", "contractors"] as const;

export class OidcError extends Error {
	readonly error: string;
	readonly status: number;
	constructor(error: string, message: string, status = 400) {
		super(message);
		this.error = error;
		this.status = status;
	}
}

export interface OidcClient {
	client_id: string;
	client_secret_sha256: string;
	redirect_uris: string[];
	name?: string;
}

type Ctx = Parameters<typeof record>[0] & {
	settings: { get<T>(k: string): Promise<T | null>; set(k: string, v: unknown): Promise<void> };
	kv: { get<T>(k: string): Promise<T | null>; set(k: string, v: unknown): Promise<void>; delete(k: string): Promise<boolean>; getVersioned<T>(k: string): Promise<{ value: T; revision: string } | null>; compareAndDelete(k: string, rev: string): Promise<{ applied: boolean } | boolean> };
};

const sha256Hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function clients(ctx: Ctx): Promise<OidcClient[]> {
	const raw = await ctx.kv.get<OidcClient[]>(CLIENTS_KEY);
	return Array.isArray(raw) ? raw : [];
}

export function issuer(origin: string): string {
	return `${origin}${OIDC_BASE}`;
}

export function discovery(origin: string) {
	const iss = issuer(origin);
	return {
		issuer: iss,
		authorization_endpoint: `${iss}/authorize`,
		token_endpoint: `${iss}/token`,
		jwks_uri: `${iss}/jwks`,
		response_types_supported: ["code"],
		subject_types_supported: ["public"],
		id_token_signing_alg_values_supported: ["RS256"],
		scopes_supported: ["openid", "email", "profile", "groups"],
		token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
		code_challenge_methods_supported: ["S256"],
		claims_supported: ["sub", "email", "name", "groups", "nonce"],
	};
}

/** Step 1. Returns the same-origin path to send the browser to next. */
export async function startAuthorization(ctx: Ctx, q: Record<string, string | undefined>): Promise<string> {
	const client = (await clients(ctx)).find((c) => c.client_id === q.client_id);
	if (!client) throw new OidcError("unauthorized_client", "Unknown client_id");
	if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) throw new OidcError("invalid_request", "redirect_uri is not registered for this client");
	if (q.response_type !== "code") throw new OidcError("unsupported_response_type", "Only response_type=code");
	if (!(q.scope ?? "").split(/\s+/).includes("openid")) throw new OidcError("invalid_scope", "scope must include openid");
	if (!q.state || q.state.length > 512) throw new OidcError("invalid_request", "state is required");
	if (q.nonce && q.nonce.length > 512) throw new OidcError("invalid_request", "nonce too long");
	if (q.code_challenge && q.code_challenge_method !== "S256") throw new OidcError("invalid_request", "Only S256 PKCE");
	const rid = random(24);
	await ctx.kv.set(`oidc:req:${rid}`, { client_id: client.client_id, redirect_uri: q.redirect_uri, state: q.state, nonce: q.nonce ?? null, code_challenge: q.code_challenge ?? null, scope: q.scope, at: Date.now() });
	return `${CONTINUE_PAGE}?rid=${rid}`;
}

/** Step 2, signed in. Returns the client's redirect with code and state. */
export async function continueAuthorization(ctx: Ctx, reader: ContentReader, rid: string, user: { id: string } | null, now = Date.now()): Promise<string> {
	if (!user) throw new OidcError("login_required", "Sign in first", 401);
	const req = await ctx.kv.get<{ client_id: string; redirect_uri: string; state: string; nonce: string | null; code_challenge: string | null; at: number }>(`oidc:req:${rid}`);
	await ctx.kv.delete(`oidc:req:${rid}`);
	if (!req || now - req.at > REQUEST_TTL_MS) throw new OidcError("invalid_request", "This sign-in request expired; start again from the application", 400);
	const principal = await principalOf(reader, user.id);
	const deny = (why: string) => {
		const u = new URL(req.redirect_uri);
		u.searchParams.set("error", "access_denied");
		u.searchParams.set("error_description", why);
		u.searchParams.set("state", req.state);
		return u.toString();
	};
	if (!principal || principal.collection !== "people") {
		await record(ctx, { type: "oidc.refused", stream: "authority", actor: `user:${user.id}`, source: "policy", title: "OIDC sign-in refused: no Powerfarm person for this EmDash user" });
		return deny("No Powerfarm identity is linked to this account");
	}
	if (!principal.active) {
		await record(ctx, { type: "oidc.refused", stream: "authority", actor: `user:${user.id}`, source: "policy", title: `OIDC sign-in refused: ${principal.subject} is not active` });
		return deny("This identity is not active");
	}
	if (!principal.principalId) return deny("This identity has no permanent id yet");
	const code = random(32);
	await ctx.kv.set(`oidc:code:${code}`, { ...req, subject: principal.subject, userId: user.id, issuedAt: now });
	const u = new URL(req.redirect_uri);
	u.searchParams.set("code", code);
	u.searchParams.set("state", req.state);
	return u.toString();
}

function claimsFor(p: Principal) {
	const groups = Array.isArray(p.entity.data.access_groups) ? (p.entity.data.access_groups as unknown[]).filter((g): g is string => typeof g === "string" && (ACCESS_GROUPS as readonly string[]).includes(g)) : [];
	return { email: typeof p.entity.data.contact_email === "string" ? p.entity.data.contact_email.trim().toLowerCase() : null, name: p.title, groups };
}

/** Step 3: the client exchanges the code. */
export async function exchangeCode(ctx: Ctx, reader: ContentReader, origin: string, form: Record<string, string | undefined>, basicAuth: string | null, now = Date.now()) {
	let clientId = form.client_id;
	let secret = form.client_secret;
	if (basicAuth?.startsWith("Basic ")) {
		const [id, s] = atob(basicAuth.slice(6)).split(":");
		clientId = decodeURIComponent(id ?? "");
		secret = decodeURIComponent(s ?? "");
	}
	const client = (await clients(ctx)).find((c) => c.client_id === clientId);
	if (!client || !secret || (await sha256Hex(secret)) !== client.client_secret_sha256) throw new OidcError("invalid_client", "Client authentication failed", 401);
	if (form.grant_type !== "authorization_code" || !form.code) throw new OidcError("unsupported_grant_type", "Only authorization_code");
	const key = `oidc:code:${form.code}`;
	const held = await ctx.kv.getVersioned<{ client_id: string; redirect_uri: string; nonce: string | null; code_challenge: string | null; subject: string; userId: string; issuedAt: number }>(key);
	if (!held) throw new OidcError("invalid_grant", "Unknown or used code");
	const del = await ctx.kv.compareAndDelete(key, held.revision);
	if (!(typeof del === "boolean" ? del : del.applied)) throw new OidcError("invalid_grant", "Code already used");
	const c = held.value;
	if (now - c.issuedAt > CODE_TTL_MS) throw new OidcError("invalid_grant", "Code expired");
	if (c.client_id !== client.client_id || c.redirect_uri !== form.redirect_uri) throw new OidcError("invalid_grant", "Code was issued to another client or redirect");
	if (c.code_challenge) {
		const v = form.code_verifier ?? "";
		const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
		if (challenge !== c.code_challenge) throw new OidcError("invalid_grant", "PKCE verification failed");
	}
	// Status is checked again at the moment of issuance: a suspension in between wins.
	const { principalBySubject } = await import("./authority.js");
	const p = await principalBySubject(reader, c.subject);
	if (!p?.active || !p.principalId) throw new OidcError("invalid_grant", "This identity is not active");
	const claims = claimsFor(p);
	if (!claims.email) throw new OidcError("invalid_grant", `${p.subject} has no contact e-mail; Cloudflare Access needs one`);
	const jwk = await ctx.settings.get<PrivateJwk | string>(OIDC_SETTINGS.signingKey);
	const key2 = typeof jwk === "string" ? (JSON.parse(jwk) as PrivateJwk) : jwk;
	if (!key2?.kid) throw new OidcError("server_error", "No signing key: rotate one in first (identity/oidc/rotate-key)", 503);
	const iat = Math.floor(now / 1000);
	const idToken = await signJwt({ iss: issuer(origin), sub: p.principalId, aud: client.client_id, iat, exp: iat + TOKEN_TTL_S, ...(c.nonce ? { nonce: c.nonce } : {}), email: claims.email, email_verified: true, name: claims.name, groups: claims.groups }, key2);
	// Powerfarm's own record of which e-mail it asserted for which principal: how Access assertions map back.
	await ctx.kv.set(`oidc:issued:${claims.email}`, { subject: p.subject, principalId: p.principalId, at: new Date(now).toISOString() });
	await record(ctx, { type: "oidc.issued", stream: "authority", actor: `user:${c.userId}`, source: "policy", title: `ID token issued to ${client.client_id} for ${p.subject}`, payload: { client: client.client_id, subject: p.subject, groups: claims.groups } });
	return { access_token: random(32), token_type: "Bearer", expires_in: TOKEN_TTL_S, id_token: idToken };
}

export async function jwks(ctx: Ctx) {
	const keys = [];
	for (const k of [OIDC_SETTINGS.signingKey, OIDC_SETTINGS.previousKey]) {
		const v = await ctx.settings.get<PrivateJwk | string>(k);
		const jwk = typeof v === "string" ? (JSON.parse(v) as PrivateJwk) : v;
		if (jwk?.kid) keys.push(publicJwk(jwk));
	}
	return { keys };
}

/** Key rotation: the current key becomes the previous one (still published in JWKS) and a new key signs from now on. */
export async function rotateKey(ctx: Ctx, actor = "powerfarm"): Promise<{ kid: string; previousKid: string | null }> {
	const current = await ctx.settings.get<PrivateJwk | string>(OIDC_SETTINGS.signingKey);
	const cur = typeof current === "string" ? (JSON.parse(current) as PrivateJwk) : current;
	const next = await generateSigningKey();
	if (cur?.kid) await ctx.settings.set(OIDC_SETTINGS.previousKey, JSON.stringify(cur));
	await ctx.settings.set(OIDC_SETTINGS.signingKey, JSON.stringify(next));
	await record(ctx, { type: "oidc.key_rotated", stream: "authority", actor, source: "policy", title: `OIDC signing key rotated to ${next.kid}`, payload: { kid: next.kid, previousKid: cur?.kid ?? null } });
	return { kid: next.kid, previousKid: cur?.kid ?? null };
}

/** Register (or replace) a client. The secret is returned once and stored only as a hash. */
export async function registerClient(ctx: Ctx, input: { client_id: string; redirect_uris: string[]; name?: string }, actor = "powerfarm"): Promise<{ client_id: string; client_secret: string }> {
	if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(input.client_id)) throw new OidcError("invalid_request", "client_id: lowercase letters, digits and dashes");
	for (const u of input.redirect_uris) if (!/^https:\/\/[^\s#]+$/.test(u)) throw new OidcError("invalid_request", `Redirect URIs must be https: ${u}`);
	const secret = random(32);
	const list = (await clients(ctx)).filter((c) => c.client_id !== input.client_id);
	list.push({ client_id: input.client_id, client_secret_sha256: await sha256Hex(secret), redirect_uris: input.redirect_uris, name: input.name });
	await ctx.kv.set(CLIENTS_KEY, list);
	await record(ctx, { type: "oidc.client_registered", stream: "authority", actor, source: "policy", title: `OIDC client ${input.client_id} registered`, payload: { client_id: input.client_id, redirect_uris: input.redirect_uris } });
	return { client_id: input.client_id, client_secret: secret };
}
