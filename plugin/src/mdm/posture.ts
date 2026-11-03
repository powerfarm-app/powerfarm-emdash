/**
 * Cloudflare Access ↔ Powerfarm: the custom device posture integration, and
 * the push relay the lab Mac runs for Apple's push service.
 *
 * Posture: Cloudflare calls this route (through an Access application with a
 * Service Auth policy), sending device serial numbers; Powerfarm answers a
 * 0–100 score per device. An Access policy can then require, for example,
 * score ≥ 70 — "a device Powerfarm manages and has no serious open incident".
 *
 * Push: MDM pushes need Apple's push service with the MDM push certificate.
 * The certificate stays on the lab Mac; the bridge claims pending pushes here
 * and sends them. When the lab is down, commands simply wait in the queue.
 */

import type { ContentReader } from "../content.js";
import { devicesOf, MDM_DEFAULTS, MDM_SETTINGS, pushesOf, type MdmCtx, type PushRequest } from "./model.js";
import { openSeveritiesFor, score } from "./vigilance.js";

export interface PostureRequest {
	devices: Array<{ device_id: string; serial_number?: string | null }>;
}

export async function postureScores(ctx: MdmCtx, reader: ContentReader, input: PostureRequest, now = new Date()): Promise<{ result: Record<string, { s2s_id: string; score: number }> }> {
	const staleHours = (await ctx.settings.get<number>(MDM_SETTINGS.staleHours)) ?? MDM_DEFAULTS.staleHours;
	const result: Record<string, { s2s_id: string; score: number }> = {};
	const severities = new Map<string, Awaited<ReturnType<typeof openSeveritiesFor>>>();
	for (const d of input.devices.slice(0, 1000)) {
		const serial = (d.serial_number ?? "").trim().toUpperCase();
		// oxlint-disable-next-line no-await-in-loop -- one indexed lookup per device
		const device = serial ? ((await devicesOf(ctx).query({ where: { serial }, limit: 2 })).items.map((i) => i.data).find((x) => x.status === "enrolled") ?? null) : null;
		let open = device ? severities.get(device.assetTag) : [];
		if (device && !open) {
			// oxlint-disable-next-line no-await-in-loop
			open = await openSeveritiesFor(reader, device.assetTag);
			severities.set(device.assetTag, open);
		}
		result[d.device_id] = { s2s_id: device?.udid ?? "", score: score(device, open ?? [], now, staleHours) };
	}
	return { result };
}

const CLAIM_TIMEOUT_MS = 10 * 60_000;

/** The bridge takes pending pushes (and any it claimed earlier but never confirmed). */
export async function claimPushes(ctx: MdmCtx, limit = 50, now = new Date()): Promise<Array<Pick<PushRequest, "id" | "token" | "pushMagic" | "topic">>> {
	const out: Array<Pick<PushRequest, "id" | "token" | "pushMagic" | "topic">> = [];
	for (const status of ["pending", "claimed"] as const) {
		// oxlint-disable-next-line no-await-in-loop
		const page = await pushesOf(ctx).query({ where: { status }, orderBy: { requestedAt: "asc" }, limit });
		for (const { data: p } of page.items) {
			if (out.length >= limit) break;
			if (status === "claimed" && p.claimedAt && now.getTime() - Date.parse(p.claimedAt) < CLAIM_TIMEOUT_MS) continue;
			// oxlint-disable-next-line no-await-in-loop
			await pushesOf(ctx).put(p.id, { ...p, status: "claimed", claimedAt: now.toISOString() });
			out.push({ id: p.id, token: p.token, pushMagic: p.pushMagic, topic: p.topic });
		}
	}
	return out;
}

/** Apple's answer for one push. 410 (token no longer valid) clears the token until the device sends a new one. */
export async function pushResult(ctx: MdmCtx, input: { id: string; ok: boolean; status?: number; reason?: string }): Promise<{ recorded: boolean }> {
	const push = await pushesOf(ctx).get(input.id);
	if (!push) return { recorded: false };
	if (input.ok) {
		await pushesOf(ctx).delete(input.id);
		return { recorded: true };
	}
	if (input.status === 410 || input.status === 400) {
		await pushesOf(ctx).delete(input.id);
		const device = await devicesOf(ctx).get(push.udid);
		if (device && device.pushToken === push.token) await devicesOf(ctx).put(device.udid, { ...device, pushToken: null });
		ctx.log.warn("Apple refused an MDM push; the device must send a new token", { udid: push.udid, status: input.status, reason: input.reason });
		return { recorded: true };
	}
	await pushesOf(ctx).put(push.id, { ...push, status: "pending", claimedAt: null });
	return { recorded: true };
}
