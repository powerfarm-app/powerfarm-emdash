/**
 * HTTP wiring for the Apple Hardware Bridge (logic in bridge-service.ts).
 *
 * The routes are EmDash plugin routes marked `public` because EmDash only lets
 * API tokens call plugin routes with the full `admin` scope; instead every
 * request is signed (bridge-auth.ts) with a per-bridge secret kept in EmDash's
 * encrypted plugin settings. They must never be reachable from the internet:
 * the reverse proxy must not route `/_emdash/api/plugins/powerfarm/bridge/`, and
 * an optional source-address allowlist fails closed when the address is unknown.
 */

import type { z } from "astro/zod";
import type { PluginRoute, RouteContext } from "emdash";
import { definePluginRoute, PluginRouteError } from "emdash";

import { artifactSignedRoute, HEADER, verifyBridgeRequest } from "./bridge-auth.js";
import { BridgeRefusal, check, claim, health, report, uploadArtifact } from "./bridge-service.js";
import { readSettings } from "./jobs.js";
import { PLUGIN_ID, SETTINGS } from "./model.js";
import { mdmBridgeRoutes } from "./mdm/routes.js";
import { BridgeS } from "./schemas.js";

const SIGNED = [HEADER.bridge, HEADER.timestamp, HEADER.nonce, HEADER.signature];
const ARTIFACT_HEADERS = ["x-powerfarm-job", "x-powerfarm-lease", "x-powerfarm-kind", "x-powerfarm-filename", "x-powerfarm-sha256", "content-type"];

async function authenticate(ctx: RouteContext, route: string, raw: string | Uint8Array): Promise<string> {
	const settings = await readSettings(ctx);
	if (!settings.bridgeEnabled) throw new PluginRouteError("BRIDGE_DISABLED", "Bridge access is disabled", 403);
	const allow = ((await ctx.settings.get<string>("bridgeAllowedAddresses")) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
	if (allow.length > 0 && (!ctx.requestMeta.ip || !allow.includes(ctx.requestMeta.ip))) {
		throw new PluginRouteError("FORBIDDEN_SOURCE", "Bridge requests are not accepted from this address", 403);
	}
	const result = await verifyBridgeRequest({
		headers: ctx.request.headers,
		route,
		body: raw,
		expectedBridgeId: settings.bridgeId,
		secret: (await ctx.settings.get<string>(SETTINGS.bridgeSecret)) ?? null,
		nextSecret: (await ctx.settings.get<string>(SETTINGS.bridgeSecretNext)) ?? null,
		claimNonce: async (nonce, ts) => (await ctx.kv.compareAndSet(`nonce:${nonce}`, null, ts)).applied,
	});
	if (!result.ok) {
		ctx.log.warn("Rejected bridge request", { route, reason: result.reason });
		throw new PluginRouteError(result.reason, "Bridge request rejected", result.reason === "NOT_CONFIGURED" ? 503 : 401);
	}
	return result.bridgeId;
}

function parseJson<T extends z.ZodType>(schema: T, raw: string): z.infer<T> {
	let body: unknown;
	try {
		body = raw ? JSON.parse(raw) : {};
	} catch {
		throw new PluginRouteError("INVALID_JSON", "Body must be JSON", 400);
	}
	const parsed = schema.safeParse(body);
	if (!parsed.success) throw new PluginRouteError("INVALID_INPUT", "Invalid bridge request", 400);
	return parsed.data;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		if (error instanceof BridgeRefusal) throw new PluginRouteError(error.code, error.message, error.status);
		throw error;
	}
}

export function jsonRoute<T extends z.ZodType>(name: string, schema: T, handler: (ctx: RouteContext, bridgeId: string, input: z.infer<T>) => Promise<unknown>): PluginRoute {
	return definePluginRoute({
		public: true,
		methods: ["POST"],
		request: { body: "text", maxBytes: 64 * 1024, headers: SIGNED },
		handler: async (ctx) => {
			const raw = typeof ctx.input === "string" ? ctx.input : "";
			const bridgeId = await authenticate(ctx as RouteContext, `${PLUGIN_ID}/${name}`, raw);
			return guard(() => handler(ctx as RouteContext, bridgeId, parseJson(schema, raw)));
		},
	}) as PluginRoute;
}

export function bridgeRoutes(): Record<string, PluginRoute> {
	return {
		...mdmBridgeRoutes(jsonRoute),
		"bridge/claim": jsonRoute("bridge/claim", BridgeS.claim, (ctx, id, i) => claim(ctx, id, i)),
		"bridge/check": jsonRoute("bridge/check", BridgeS.check, (ctx, id, i) => check(ctx, id, i)),
		"bridge/report": jsonRoute("bridge/report", BridgeS.report, (ctx, id, i) => report(ctx, id, i)),
		"bridge/health": jsonRoute("bridge/health", BridgeS.health, (ctx, id, i) => health(ctx, id, i)),
		"bridge/artifact": definePluginRoute({
			public: true,
			methods: ["POST"],
			request: { body: "bytes", maxBytes: 8 * 1024 * 1024, headers: [...SIGNED, ...ARTIFACT_HEADERS] },
			handler: async (ctx) => {
				const bytes = ctx.input instanceof Uint8Array ? ctx.input : new Uint8Array();
				const rc = ctx as RouteContext;
				const h = rc.request.headers;
				// The metadata headers are part of what is signed, so none can be altered in transit.
				const bridgeId = await authenticate(rc, artifactSignedRoute(h), bytes);
				const meta = { jobId: h.get("x-powerfarm-job") ?? "", leaseId: h.get("x-powerfarm-lease") ?? "" };
				if (!meta.jobId || !meta.leaseId) throw new PluginRouteError("INVALID_INPUT", "Missing job or lease header", 400);
				return guard(() =>
					uploadArtifact(rc, bridgeId, meta, {
						kind: h.get("x-powerfarm-kind") ?? "",
						filename: h.get("x-powerfarm-filename") ?? "artifact",
						contentType: h.get("content-type") ?? "",
						declaredSha256: h.get("x-powerfarm-sha256") ?? "",
						bytes,
					}),
				);
			},
		}) as PluginRoute,
	};
}
