/**
 * EmDash plugin routes for Powerfarm MDM.
 *
 *   mdm/checkin, mdm/connect   devices (public; the device signature is the lock;
 *                              Cloudflare Access must Bypass this path only)
 *   posture/score              Cloudflare's custom device posture integration
 *                              (public; behind an Access Service Auth application)
 *   bridge/mdm-pushes          the lab Mac claims pushes to send (bridge-signed)
 *   bridge/mdm-push-result     and reports Apple's answer
 *   mdm/devices, mdm/device    read models for the admin (editors)
 *   mdm/query                  an editor asks a device for a fresh report (session only)
 */

import { z } from "astro/zod";
import type { PluginRoute, RouteContext } from "emdash";
import { definePluginRoute, pluginResponse, PluginRouteError } from "emdash";

import { ROLE } from "../model.js";
import { sessionUser } from "../routes.js";
import { getReader } from "../runtime.js";
import { QUERY_COMMANDS } from "./commands.js";
import { commandsOf, devicesOf, MDM_DEFAULTS, MDM_SETTINGS, MdmRefusal, type MdmCtx } from "./model.js";
import { claimPushes, postureScores, pushResult } from "./posture.js";
import { handleCheckin, handleConnect, queueCommand, type MdmResponse } from "./protocol.js";
import { openSeveritiesFor, score } from "./vigilance.js";

/**
 * Plists go out as application/x-plist: EmDash's raw routes refuse
 * application/xml (an "active" type). Apple's MDM client reads the body as a
 * plist; confirm on the first real device (docs/MDM.md, live checks).
 */
const PLIST_TYPE = "application/x-plist; charset=utf-8";

function wire(r: MdmResponse) {
	return pluginResponse({ status: r.status, headers: r.body ? { "content-type": PLIST_TYPE } : {}, body: r.body ? { kind: "text", value: r.body } : null });
}

function deviceRoute(handler: typeof handleCheckin, maxBytes: number): PluginRoute {
	return definePluginRoute({
		public: true,
		methods: ["PUT", "POST"],
		request: { body: "bytes", maxBytes, headers: ["mdm-signature", "content-type"] },
		response: "raw",
		handler: async (ctx) => {
			const rc = ctx as unknown as RouteContext;
			const body = ctx.input instanceof Uint8Array ? ctx.input : new Uint8Array();
			try {
				return wire(await handler(rc as unknown as MdmCtx, await getReader(), body, rc.request.headers.get("mdm-signature")));
			} catch (e) {
				if (e instanceof MdmRefusal) {
					rc.log.warn("MDM request refused", { code: e.code, message: e.message });
					return pluginResponse({ status: e.status, headers: { "content-type": "text/plain; charset=utf-8" }, body: { kind: "text", value: e.code } });
				}
				throw e;
			}
		},
	}) as PluginRoute;
}

const posture = z.object({ devices: z.array(z.object({ device_id: z.string().min(1).max(100), serial_number: z.string().max(100).nullish() }).passthrough()).max(1000) });
const pushResultS = z.object({ results: z.array(z.object({ id: z.string().min(1).max(100), ok: z.boolean(), status: z.number().int().optional(), reason: z.string().max(200).optional() })).max(100) });

/** Routes the bridge calls; `jsonBridgeRoute` comes from bridge.ts so the same signature check applies. */
export function mdmBridgeRoutes(jsonBridgeRoute: <T extends z.ZodType>(name: string, schema: T, handler: (ctx: RouteContext, bridgeId: string, input: z.infer<T>) => Promise<unknown>) => PluginRoute): Record<string, PluginRoute> {
	return {
		"bridge/mdm-pushes": jsonBridgeRoute("bridge/mdm-pushes", z.object({ limit: z.number().int().min(1).max(100).default(50) }), async (ctx, _id, i) => ({ pushes: await claimPushes(ctx as unknown as MdmCtx, i.limit) })),
		"bridge/mdm-push-result": jsonBridgeRoute("bridge/mdm-push-result", pushResultS, async (ctx, _id, i) => {
			let recorded = 0;
			for (const r of i.results) if ((await pushResult(ctx as unknown as MdmCtx, r)).recorded) recorded++;
			return { recorded };
		}),
	};
}

export function mdmRoutes(): Record<string, PluginRoute> {
	return {
		"mdm/checkin": deviceRoute(handleCheckin, 256 * 1024),
		"mdm/connect": deviceRoute(handleConnect, 8 * 1024 * 1024),
		"posture/score": {
			public: true,
			input: posture,
			handler: async (ctx) => {
				if ((await ctx.settings?.get<boolean>(MDM_SETTINGS.enabled)) !== true) throw new PluginRouteError("MDM_DISABLED", "Powerfarm MDM is turned off", 503);
				return postureScores(ctx as unknown as MdmCtx, await getReader(), ctx.input as z.infer<typeof posture>);
			},
		} as PluginRoute,
		"mdm/devices": {
			permission: "content:read",
			input: z.object({}).passthrough(),
			handler: async (ctx) => {
				const user = ctx.user;
				if (!user || user.role < ROLE.EDITOR) throw new PluginRouteError("FORBIDDEN", "Editors and administrators only", 403);
				const reader = await getReader();
				const staleHours = (await ctx.settings?.get<number>(MDM_SETTINGS.staleHours)) ?? MDM_DEFAULTS.staleHours;
				const page = await devicesOf(ctx as never).query({ limit: 100 });
				const now = new Date();
				const devices = [];
				for (const { data: d } of page.items) {
					// oxlint-disable-next-line no-await-in-loop
					const open = await openSeveritiesFor(reader, d.assetTag);
					devices.push({ udid: d.udid, assetTag: d.assetTag, serial: d.serial, productName: d.productName, osVersion: d.osVersion, status: d.status, lastSeenAt: d.lastSeenAt, enrolledAt: d.enrolledAt, push: !!d.pushToken, score: score(d, open, now, staleHours), openIncidents: open.length });
				}
				return { devices };
			},
		} as PluginRoute,
		"mdm/device": {
			permission: "content:read",
			input: z.object({ assetTag: z.string().min(1).max(64) }),
			handler: async (ctx) => {
				const user = ctx.user;
				if (!user || user.role < ROLE.EDITOR) throw new PluginRouteError("FORBIDDEN", "Editors and administrators only", 403);
				const tag = (ctx.input as { assetTag: string }).assetTag.toUpperCase();
				const d = (await devicesOf(ctx as never).query({ where: { assetTag: tag }, limit: 5 })).items.map((i) => i.data).sort((a, b) => b.enrolledAt.localeCompare(a.enrolledAt))[0];
				if (!d) return { device: null, commands: [] };
				const commands = (await commandsOf(ctx as never).query({ where: { udid: d.udid }, orderBy: { queuedAt: "desc" }, limit: 30 })).items.map((i) => i.data);
				const { pushToken: _t, pushMagic: _m, ...safe } = d;
				return { device: safe, commands };
			},
		} as PluginRoute,
		"mdm/query": {
			permission: "content:publish_any",
			input: z.object({ assetTag: z.string().min(1).max(64), requestType: z.enum(QUERY_COMMANDS) }),
			handler: async (ctx) => {
				const user = sessionUser(ctx as unknown as RouteContext);
				const i = ctx.input as { assetTag: string; requestType: (typeof QUERY_COMMANDS)[number] };
				const d = (await devicesOf(ctx as never).query({ where: { assetTag: i.assetTag.toUpperCase(), status: "enrolled" }, limit: 1 })).items[0]?.data;
				if (!d) throw new PluginRouteError("NOT_ENROLLED", `${i.assetTag} is not enrolled`, 404);
				const { refusal } = await import("../authority.js");
				const denied = await refusal(ctx as never, await getReader(), { actor: { id: user.id, role: user.role }, capability: "mdm.command", scope: `assets:${d.assetTag}`, what: i.requestType });
				if (denied) throw new PluginRouteError("NOT_AUTHORISED", denied, 403);
				try {
					const c = await queueCommand(ctx as unknown as MdmCtx, { udid: d.udid, requestType: i.requestType, issuedBy: `user:${user.id}`, reason: "Asked from the admin" });
					return { command: c.id, status: c.status };
				} catch (e) {
					if (e instanceof MdmRefusal) throw new PluginRouteError(e.code, e.message, e.status);
					throw e;
				}
			},
		} as PluginRoute,
	};
}
