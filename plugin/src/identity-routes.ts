/**
 * EmDash plugin routes for Powerfarm Identity.
 *
 *   identity/whoami          (signed in or API token) the principal behind this EmDash user,
 *                            its organisation and current grants
 *   identity/whoami-access   (public) for Free Zone services: the principal behind a
 *                            verified Cloudflare Access assertion
 *   identity/oidc/rotate-key (session, idp.keys)    new OIDC signing key; old one kept in JWKS
 *   identity/oidc/client     (session, idp.config)  register Cloudflare Access as a client
 *   oidc/*                   the OIDC provider (oidc.ts); oidc/continue is called by the
 *                            static site page /oidc/continue
 *   records/seal             is a record still what was sealed?
 *   release/draft            CI (signed with the CI secret)
 *   release/authorize, release/deployed   the release service (its own secret)
 */

import { z } from "astro/zod";
import type { PluginRoute, RouteContext } from "emdash";
import { definePluginRoute, pluginResponse, PluginRouteError } from "emdash";

import { authorize, CAPABILITY_IDS, grantsHeld, principalById, principalOf, type Principal } from "./authority.js";
import { verifyBridgeRequest } from "./bridge-auth.js";
import { verifyAccessAssertion } from "./cloudflare.js";
import type { ContentReader } from "./content.js";
import { continueAuthorization, discovery, exchangeCode, jwks, OidcError, registerClient, rotateKey, startAuthorization } from "./oidc.js";
import { authorizeDeploy, draftRelease, recordDeployment, RELEASE_SETTINGS, ReleaseRefusal } from "./release.js";
import { sessionUser } from "./routes.js";
import { getReader } from "./runtime.js";
import { sealStatus } from "./seals.js";

async function context(reader: ContentReader, p: Principal) {
	const now = new Date();
	const grants = [];
	for (const cap of CAPABILITY_IDS) {
		// oxlint-disable-next-line no-await-in-loop -- nine capabilities
		for (const g of await grantsHeld(reader, p.subject, cap, "*", now).catch(() => [])) grants.push({ capability: cap, scope: String(g.data.scope), validUntil: String(g.data.valid_until), code: g.key });
	}
	const all = (await reader.byField("grants", "principal", [p.subject], "published", 200)).filter((g) => Date.parse(String(g.data.valid_until)) > now.getTime());
	return {
		subject: p.subject,
		principalId: p.principalId,
		name: p.title,
		active: p.active,
		lifecycle: p.entity.data.lifecycle,
		groups: Array.isArray(p.entity.data.access_groups) ? p.entity.data.access_groups : [],
		grants: all.map((g) => ({ code: g.key, capability: g.data.capability, scope: g.data.scope, validUntil: g.data.valid_until, delegatedBy: g.data.delegated_by ?? null })),
		_held: grants.length,
	};
}

function oidcError(e: unknown) {
	if (e instanceof OidcError) return pluginResponse({ status: e.status, headers: { "content-type": "application/json" }, body: { kind: "text", value: JSON.stringify({ error: e.error, error_description: e.message }) } });
	throw e;
}

const json = (status: number, value: unknown) => pluginResponse({ status, headers: { "content-type": "application/json" }, body: { kind: "text", value: JSON.stringify(value) } });

/** Signed JSON routes for CI and the release service: same HMAC scheme as the bridge, their own ids and secrets. */
function signedRoute<T extends z.ZodType>(name: string, schema: T, who: { id: string; secret: string }, handler: (ctx: RouteContext, input: z.infer<T>) => Promise<unknown>): PluginRoute {
	return definePluginRoute({
		public: true,
		methods: ["POST"],
		request: { body: "text", maxBytes: 64 * 1024, headers: ["x-powerfarm-bridge", "x-powerfarm-timestamp", "x-powerfarm-nonce", "x-powerfarm-signature"] },
		handler: async (ctx) => {
			const rc = ctx as RouteContext;
			const raw = typeof ctx.input === "string" ? ctx.input : "";
			const result = await verifyBridgeRequest({
				headers: rc.request.headers,
				route: `powerfarm/${name}`,
				body: raw,
				expectedBridgeId: (await rc.settings.get<string>(who.id)) ?? null,
				secret: (await rc.settings.get<string>(who.secret)) ?? null,
				claimNonce: async (nonce, ts) => (await rc.kv.compareAndSet(`nonce:${name}:${nonce}`, null, ts)).applied,
			});
			if (!result.ok) throw new PluginRouteError(result.reason, "Request rejected", result.reason === "NOT_CONFIGURED" ? 503 : 401);
			let body: unknown;
			try {
				body = JSON.parse(raw || "{}");
			} catch {
				throw new PluginRouteError("INVALID_INPUT", "Body is not JSON", 400);
			}
			const parsed = schema.safeParse(body);
			if (!parsed.success) throw new PluginRouteError("INVALID_INPUT", "Invalid request", 400);
			try {
				return await handler(rc, parsed.data);
			} catch (e) {
				if (e instanceof ReleaseRefusal) throw new PluginRouteError(e.code, e.message, e.status);
				throw e;
			}
		},
	}) as PluginRoute;
}

const S = {
	draft: z.object({ repository: z.string().min(1).max(120), commit: z.string().regex(/^[0-9a-f]{7,64}$/i), artifactDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/i), environment: z.enum(["production", "staging"]), version: z.string().min(1).max(60), testsPassed: z.number().int().min(0), testsFailed: z.number().int().min(0), testSummary: z.string().max(2000).optional() }),
	authorize: z.object({ version: z.string().min(1).max(60), repository: z.string().min(1).max(120), commit: z.string().regex(/^[0-9a-f]{7,64}$/i), artifactDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/i), environment: z.enum(["production", "staging"]) }),
	deployed: z.object({ authorization: z.string().uuid(), ok: z.boolean(), deployedVersion: z.string().max(120).optional(), detail: z.string().max(500).optional() }),
};

export function identityRoutes(): Record<string, PluginRoute> {
	const ci = { id: RELEASE_SETTINGS.ciClientId, secret: RELEASE_SETTINGS.ciSecret };
	const rel = { id: RELEASE_SETTINGS.releaseClientId, secret: RELEASE_SETTINGS.releaseSecret };
	return {
		"identity/whoami": {
			permission: "content:read",
			input: z.object({}).passthrough(),
			handler: async (ctx) => {
				const user = ctx.user;
				if (!user) throw new PluginRouteError("UNAUTHORIZED", "Sign in", 401);
				const reader = await getReader();
				const p = await principalOf(reader, user.id);
				return { user: { id: user.id, role: user.role }, principal: p ? await context(reader, p) : null };
			},
		} as PluginRoute,
		"identity/whoami-access": definePluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none", headers: ["cf-access-jwt-assertion"] },
			response: "raw",
			handler: async (ctx) => {
				const rc = ctx as unknown as RouteContext;
				try {
					const a = await verifyAccessAssertion(rc as never, rc.request.headers.get("cf-access-jwt-assertion"));
					if (!a.principalId) return json(404, { error: "unknown_principal", message: "This Access login did not come through Powerfarm (no pf_principal_id claim: break-glass, another provider, or the claim is not configured)." });
					const reader = await getReader();
					const p = await principalById(reader, a.principalId);
					if (!p) return json(404, { error: "unknown_principal", message: "No Powerfarm principal has this id." });
					// A valid Access session is not authority: an inactive principal is refused here
					// even while Cloudflare still honours a session issued before the suspension.
					if (!p.active) return json(403, { error: "principal_inactive", message: `${p.subject} is not active.` });
					return json(200, { principal: await context(reader, p) });
				} catch (e) {
					return json(401, { error: "invalid_assertion", message: e instanceof Error ? e.message : String(e) });
				}
			},
		}) as PluginRoute,
		"identity/oidc/rotate-key": {
			permission: "plugins:manage",
			input: z.object({}).passthrough(),
			handler: async (ctx) => {
				const user = sessionUser(ctx as unknown as RouteContext);
				const d = await authorize(ctx as never, await getReader(), { actor: user, capability: "idp.keys", scope: "oidc", what: "rotate signing key" });
				if (!d.allowed) throw new PluginRouteError("NOT_AUTHORISED", `Not authorised: ${d.reason}`, 403);
				return rotateKey(ctx as never, `user:${user.id}`);
			},
		} as PluginRoute,
		"identity/oidc/client": {
			permission: "plugins:manage",
			input: z.object({ client_id: z.string().min(3).max(60), redirect_uris: z.array(z.string().url()).min(1).max(5), name: z.string().max(80).optional() }),
			handler: async (ctx) => {
				const user = sessionUser(ctx as unknown as RouteContext);
				const d = await authorize(ctx as never, await getReader(), { actor: user, capability: "idp.config", scope: "oidc", what: "register client" });
				if (!d.allowed) throw new PluginRouteError("NOT_AUTHORISED", `Not authorised: ${d.reason}`, 403);
				try {
					return await registerClient(ctx as never, ctx.input as { client_id: string; redirect_uris: string[]; name?: string }, `user:${user.id}`);
				} catch (e) {
					if (e instanceof OidcError) throw new PluginRouteError(e.error, e.message, 400);
					throw e;
				}
			},
		} as PluginRoute,
		"oidc/authorize": definePluginRoute({
			public: true,
			methods: ["GET"],
			request: { body: "none" },
			response: "raw",
			handler: async (ctx) => {
				try {
					// A repeated parameter arrives as an array: treat it as invalid rather than pick one.
					const q: Record<string, string | undefined> = {};
					for (const [k, v] of Object.entries(ctx.input as Record<string, string | string[]>)) q[k] = typeof v === "string" ? v : undefined;
					return pluginResponse({ status: 302, headers: { location: await startAuthorization(ctx as never, q) } });
				} catch (e) {
					return oidcError(e);
				}
			},
		}) as PluginRoute,
		"oidc/continue": {
			permission: "content:read",
			input: z.object({ rid: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/) }),
			handler: async (ctx) => {
				const user = sessionUser(ctx as unknown as RouteContext);
				try {
					const caller = (ctx as unknown as RouteContext).user as unknown as { email?: string; emailVerified?: boolean } | undefined;
					return { location: await continueAuthorization(ctx as never, await getReader(), (ctx.input as { rid: string }).rid, { id: user.id, email: caller?.email, emailVerified: caller?.emailVerified }) };
				} catch (e) {
					if (e instanceof OidcError) throw new PluginRouteError(e.error, e.message, e.status);
					throw e;
				}
			},
		} as PluginRoute,
		"oidc/token": definePluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "form-data", maxBytes: 16 * 1024, headers: ["authorization", "content-type"] },
			response: "raw",
			handler: async (ctx) => {
				const rc = ctx as unknown as RouteContext;
				const form: Record<string, string | undefined> = {};
				const input = ctx.input as { entries?: Array<{ name: string; value?: string }> } | Record<string, unknown>;
				if (Array.isArray((input as { entries?: unknown }).entries)) for (const e of (input as { entries: Array<{ name: string; value?: string }> }).entries) form[e.name] = typeof e.value === "string" ? e.value : undefined;
				else for (const [k, v] of Object.entries(input as Record<string, unknown>)) form[k] = typeof v === "string" ? v : undefined;
				try {
					return json(200, await exchangeCode(ctx as never, await getReader(), form, rc.request.headers.get("authorization")));
				} catch (e) {
					return oidcError(e);
				}
			},
		}) as PluginRoute,
		"oidc/jwks": definePluginRoute({ public: true, methods: ["GET"], request: { body: "none" }, response: "raw", handler: async (ctx) => json(200, await jwks(ctx as never)) }) as PluginRoute,
		"oidc/openid-configuration": definePluginRoute({ public: true, methods: ["GET"], request: { body: "none" }, response: "raw", handler: async (ctx) => {
				try {
					return json(200, discovery(ctx as never));
				} catch (e) {
					return oidcError(e);
				}
			} }) as PluginRoute,
		"records/seal": {
			permission: "content:read",
			input: z.object({ collection: z.string().min(1).max(40), ref: z.string().min(1).max(120) }),
			handler: async (ctx) => {
				const i = ctx.input as { collection: string; ref: string };
				return sealStatus(ctx as never, await getReader(), i.collection, i.ref);
			},
		} as PluginRoute,
		"release/draft": signedRoute("release/draft", S.draft, ci, async (ctx, i) => draftRelease(ctx as never, i)),
		"release/authorize": signedRoute("release/authorize", S.authorize, rel, async (ctx, i) => authorizeDeploy(ctx as never, await getReader(), i)),
		"release/deployed": signedRoute("release/deployed", S.deployed, rel, async (ctx, i) => recordDeployment(ctx as never, i)),
	};
}
