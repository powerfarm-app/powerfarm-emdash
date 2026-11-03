/**
 * Apple's MDM protocol, served by EmDash plugin routes.
 *
 *   PUT …/mdm/checkin   Authenticate, TokenUpdate, CheckOut
 *   PUT …/mdm/connect   command results in, the next command out
 *
 * Every message must carry a valid `Mdm-Signature` from a device identity the
 * Powerfarm device CA issued (cms.ts). On top of that:
 *
 * - Authenticate is accepted only when the certificate's common name is the
 *   device's UDID (the bridge issues one identity per device, at enrolment)
 *   and the serial number is a published asset. Anything else is refused and
 *   becomes an incident.
 * - Every later message must come from the same certificate that
 *   authenticated; a different, CA-signed certificate for an enrolled UDID is
 *   refused and becomes a critical incident.
 * - The device's unlock token is never stored: Powerfarm holds no right to
 *   clear a passcode.
 */

import type { ContentReader } from "../content.js";
import { record } from "../journal.js";
import { buildCommand, factsFromResult, isAllowedCommand, type RequestType } from "./commands.js";
import { parseCertificate, pemToDer, SignatureError, toHex, verifyDetachedCms, type Certificate } from "./cms.js";
import { commandsOf, devicesOf, MDM_SETTINGS, MdmRefusal, pushesOf, type MdmCommand, type MdmCtx, type MdmDevice } from "./model.js";
import { buildPlist, parsePlistDict, PlistError, type PlistDict } from "./plist.js";
import { raiseIncident } from "./vigilance.js";

export interface MdmResponse {
	status: number;
	body: string | null;
}

const EMPTY: MdmResponse = { status: 200, body: null };
const RESEND_AFTER_MS = 60 * 60_000;
const MAX_ATTEMPTS = 5;

async function caCertificate(ctx: MdmCtx): Promise<Certificate> {
	const pem = await ctx.settings.get<string>(MDM_SETTINGS.caCertificate);
	if (!pem) throw new MdmRefusal("NOT_CONFIGURED", "The Powerfarm device CA certificate is not set", 503);
	try {
		const ca = parseCertificate(pemToDer(pem));
		if (!ca.isCA) throw new MdmRefusal("NOT_CONFIGURED", "The configured device CA certificate is not a CA", 503);
		return ca;
	} catch (e) {
		if (e instanceof MdmRefusal) throw e;
		throw new MdmRefusal("NOT_CONFIGURED", "The configured device CA certificate cannot be read", 503);
	}
}

async function enabled(ctx: MdmCtx): Promise<void> {
	if ((await ctx.settings.get<boolean>(MDM_SETTINGS.enabled)) !== true) throw new MdmRefusal("MDM_DISABLED", "Powerfarm MDM is turned off", 503);
}

interface Verified {
	message: PlistDict;
	fingerprint: string;
	cert: Certificate;
}

async function verify(ctx: MdmCtx, body: Uint8Array, signature: string | null, now: Date): Promise<Verified> {
	await enabled(ctx);
	if (!signature) throw new MdmRefusal("UNSIGNED", "Mdm-Signature is required", 401);
	const ca = await caCertificate(ctx);
	let v;
	try {
		v = await verifyDetachedCms(signature, body, ca, now);
	} catch (e) {
		if (e instanceof SignatureError) throw new MdmRefusal(e.code, e.message, 401);
		throw e;
	}
	let message: PlistDict;
	try {
		message = parsePlistDict(body);
	} catch (e) {
		throw new MdmRefusal("BAD_PLIST", e instanceof PlistError ? e.message : "Unreadable message", 400);
	}
	return { message, fingerprint: v.fingerprint, cert: v.certificate };
}

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** The enrolled device this message comes from, or a refusal (and an incident when the certificate is wrong). */
async function knownDevice(ctx: MdmCtx, v: Verified, now: Date): Promise<MdmDevice> {
	const udid = s(v.message.UDID);
	const device = udid ? await devicesOf(ctx).get(udid) : null;
	if (!device || device.status !== "enrolled") throw new MdmRefusal("NOT_ENROLLED", "This device is not enrolled", 401);
	if (device.certFingerprint !== v.fingerprint) {
		await raiseIncident(ctx, { rule: "identity_mismatch", severity: "critical", assetTag: device.assetTag, udid, at: now, detail: `A message for ${device.assetTag} was signed with a different device certificate (${v.fingerprint.slice(0, 16)}…) than the one it enrolled with. Refused.` });
		throw new MdmRefusal("IDENTITY_MISMATCH", "Signed by a different device identity", 401);
	}
	return device;
}

/** MDM needs the 1.3 content model (incidents, device profiles): refuse rather than half-work on an older one. */
export async function mdmSchemaReady(reader: ContentReader): Promise<boolean> {
	const types = await reader.readPort.fieldTypes();
	return types.has("incidents") && types.has("mdm_profiles");
}

async function ready(ctx: MdmCtx, reader: ContentReader): Promise<void> {
	await enabled(ctx);
	if (!(await mdmSchemaReady(reader))) throw new MdmRefusal("NOT_CONFIGURED", "The content model is older than 1.3: apply site/seed/migrations/1.3.0.json", 503);
}

export async function handleCheckin(ctx: MdmCtx, reader: ContentReader, body: Uint8Array, signature: string | null, now = new Date()): Promise<MdmResponse> {
	await ready(ctx, reader);
	const v = await verify(ctx, body, signature, now);
	const type = s(v.message.MessageType);
	const topic = await ctx.settings.get<string>(MDM_SETTINGS.topic);
	if (type === "Authenticate" || type === "TokenUpdate" || type === "CheckOut") {
		if (!topic || s(v.message.Topic) !== topic) throw new MdmRefusal("WRONG_TOPIC", "The message is for a different MDM push topic", 400);
	}
	switch (type) {
		case "Authenticate":
			return authenticate(ctx, reader, v, now);
		case "TokenUpdate": {
			const device = await knownDevice(ctx, v, now);
			const token = v.message.Token instanceof Uint8Array ? toHex(v.message.Token) : null;
			const pushMagic = s(v.message.PushMagic) || null;
			if (!token || !pushMagic) throw new MdmRefusal("BAD_TOKEN", "TokenUpdate without a push token", 400);
			const withToken = { ...device, pushToken: token, pushMagic, lastSeenAt: now.toISOString() };
			await devicesOf(ctx).put(device.udid, withToken);
			// Commands queued before the device could be reached (the first inventory) go out now.
			if ((await pendingFor(ctx, device.udid)).length) await requestPush(ctx, withToken, now);
			await record(ctx as never, { type: "mdm.token_update", stream: `asset:${device.assetTag}`, actor: `device:${device.udid}`, source: "system", title: `${device.assetTag} registered for MDM push`, assetTag: device.assetTag, idempotencyKey: `mdm:token:${device.udid}:${token.slice(0, 16)}` });
			return EMPTY;
		}
		case "CheckOut": {
			const device = await knownDevice(ctx, v, now);
			await devicesOf(ctx).put(device.udid, { ...device, status: "checked_out", checkedOutAt: now.toISOString(), lastSeenAt: now.toISOString(), pushToken: null, pushMagic: null });
			await raiseIncident(ctx, { rule: "left_management", severity: "critical", assetTag: device.assetTag, udid: device.udid, at: now, detail: `${device.assetTag} removed its MDM enrolment (CheckOut). If no person did this on purpose, treat the device as compromised.` });
			return EMPTY;
		}
		case "UserAuthenticate":
			// macOS user channel: not used by Powerfarm. 410 tells the device not to ask again.
			return { status: 410, body: null };
		default:
			throw new MdmRefusal("UNSUPPORTED_MESSAGE", `Check-in message ${type || "(none)"} is not supported`, 400);
	}
}

async function authenticate(ctx: MdmCtx, reader: ContentReader, v: Verified, now: Date): Promise<MdmResponse> {
	const udid = s(v.message.UDID);
	const serial = s(v.message.SerialNumber).toUpperCase();
	if (!udid || v.cert.subjectCN !== udid) {
		await raiseIncident(ctx, { rule: "enrolment_refused", severity: "high", assetTag: null, udid: udid || null, at: now, detail: `An enrolment for UDID ${udid || "(none)"} used a certificate issued to ${v.cert.subjectCN ?? "(no name)"}. Refused.` });
		throw new MdmRefusal("IDENTITY_NOT_FOR_DEVICE", "The device certificate was issued to another device", 401);
	}
	const asset = serial ? (await reader.byField("assets", "serial_number", [serial], "published", 2))[0] : undefined;
	if (!asset?.key) {
		await raiseIncident(ctx, { rule: "enrolment_refused", severity: "high", assetTag: null, udid, at: now, detail: `Device ${udid} (serial ${serial || "unknown"}) tried to enrol but is not a published asset. Refused.` });
		throw new MdmRefusal("UNKNOWN_DEVICE", "The serial number is not a registered asset", 403);
	}
	const previous = await devicesOf(ctx).get(udid);
	const device: MdmDevice = {
		udid,
		serial,
		assetTag: asset.key,
		model: s(v.message.Model) || null,
		productName: s(v.message.ProductName) || null,
		osVersion: s(v.message.OSVersion) || null,
		buildVersion: s(v.message.BuildVersion) || null,
		topic: s(v.message.Topic),
		pushToken: null,
		pushMagic: null,
		certFingerprint: v.fingerprint,
		certNotAfter: v.cert.notAfter.toISOString(),
		status: "enrolled",
		enrolledAt: now.toISOString(),
		lastSeenAt: now.toISOString(),
		checkedOutAt: null,
		facts: {},
	};
	await devicesOf(ctx).put(udid, device);
	if (previous && previous.certFingerprint !== v.fingerprint) {
		await raiseIncident(ctx, { rule: "re_enrolled", severity: "medium", assetTag: asset.key, udid, at: now, detail: `${asset.key} enrolled again with a new device identity. Expected after an erase and a new enrolment through the bridge; otherwise investigate.` });
	}
	await record(ctx as never, { type: "mdm.enrolled", stream: `asset:${asset.key}`, actor: `device:${udid}`, source: "system", title: `${asset.key} enrolled in Powerfarm MDM`, assetTag: asset.key, payload: { udid, serial, osVersion: device.osVersion, certificate: v.fingerprint }, idempotencyKey: `mdm:enrolled:${udid}:${v.fingerprint}` });
	// First look at the device straight away.
	for (const q of ["DeviceInformation", "SecurityInfo", "ProfileList"] as const) await queueCommand(ctx, { udid, requestType: q, issuedBy: "vigilance", reason: "First inventory after enrolment" }, now, false);
	return EMPTY;
}

/** Queue a command for a device (and ask for a push). Read-only queries are de-duplicated while one is pending. */
export async function queueCommand(
	ctx: MdmCtx,
	input: { udid: string; requestType: string; params?: Record<string, unknown>; issuedBy: string; reason: string },
	now = new Date(),
	push = true,
): Promise<MdmCommand> {
	if (!isAllowedCommand(input.requestType)) throw new MdmRefusal("COMMAND_NOT_ALLOWED", `${input.requestType} is not a command Powerfarm sends`, 400);
	const device = await devicesOf(ctx).get(input.udid);
	if (!device || device.status !== "enrolled") throw new MdmRefusal("NOT_ENROLLED", "The device is not enrolled", 409);
	const params = input.params ?? {};
	const pending = await pendingFor(ctx, input.udid);
	const same = pending.find((c) => c.requestType === input.requestType && JSON.stringify(c.params) === JSON.stringify(params));
	if (same) return same;
	const command: MdmCommand = {
		id: crypto.randomUUID().toUpperCase(),
		udid: input.udid,
		assetTag: device.assetTag,
		requestType: input.requestType,
		params,
		status: "queued",
		issuedBy: input.issuedBy,
		reason: input.reason.slice(0, 300),
		queuedAt: now.toISOString(),
		sentAt: null,
		doneAt: null,
		attempts: 0,
		error: null,
	};
	await commandsOf(ctx).put(command.id, command);
	if (push) await requestPush(ctx, device, now);
	return command;
}

async function pendingFor(ctx: MdmCtx, udid: string): Promise<MdmCommand[]> {
	const out: MdmCommand[] = [];
	for (const status of ["queued", "sent"] as const) {
		const page = await commandsOf(ctx).query({ where: { udid, status }, orderBy: { queuedAt: "asc" }, limit: 100 });
		out.push(...page.items.map((i) => i.data));
	}
	return out.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export async function requestPush(ctx: MdmCtx, device: MdmDevice, now = new Date()): Promise<boolean> {
	if (!device.pushToken || !device.pushMagic) return false;
	await pushesOf(ctx).put(device.udid, { id: device.udid, udid: device.udid, token: device.pushToken, pushMagic: device.pushMagic, topic: device.topic, status: "pending", requestedAt: now.toISOString(), claimedAt: null });
	return true;
}

/** Profiles are installed from published `mdm_profiles` content only; the command carries the entry id. */
async function profileBytes(reader: ContentReader, command: MdmCommand): Promise<Uint8Array> {
	const id = typeof command.params.profileId === "string" ? command.params.profileId : "";
	const profile = id ? await reader.resolve("mdm_profiles", id, "published") : null;
	const xml = profile && typeof profile.data.mobileconfig === "string" ? profile.data.mobileconfig : null;
	if (!xml) throw new MdmRefusal("PROFILE_GONE", "The profile is no longer published", 409);
	return new TextEncoder().encode(xml);
}

export async function handleConnect(ctx: MdmCtx, reader: ContentReader, body: Uint8Array, signature: string | null, now = new Date()): Promise<MdmResponse> {
	await ready(ctx, reader);
	const v = await verify(ctx, body, signature, now);
	const device = await knownDevice(ctx, v, now);
	const status = s(v.message.Status);
	const uuid = s(v.message.CommandUUID).toUpperCase();
	const skip = new Set<string>();
	let updated: MdmDevice = { ...device, lastSeenAt: now.toISOString() };

	if (status !== "Idle" && uuid) {
		const command = await commandsOf(ctx).get(uuid);
		if (command && command.udid === device.udid && command.status === "sent") {
			if (status === "Acknowledged") {
				const facts = factsFromResult(command.requestType, v.message, now.toISOString());
				updated = { ...updated, facts: { ...updated.facts, ...facts } };
				const info = facts.information?.values;
				if (info) updated = { ...updated, osVersion: (info.OSVersion as string) ?? updated.osVersion, buildVersion: (info.BuildVersion as string) ?? updated.buildVersion, productName: (info.ProductName as string) ?? updated.productName };
				await commandsOf(ctx).put(uuid, { ...command, status: "acknowledged", doneAt: now.toISOString() });
				if (command.requestType === "InstallProfile" && typeof command.params.identifier === "string") {
					await ctx.kv.set(`mdm:installed:${device.udid}:${command.params.identifier}`, (command.params.revision as string | null) ?? null);
				}
				await record(ctx as never, { type: "mdm.observed", stream: `asset:${device.assetTag}`, actor: `device:${device.udid}`, source: "system", title: `${device.assetTag}: ${command.requestType} received`, assetTag: device.assetTag, payload: { command: uuid, requestType: command.requestType, ...summarise(facts) }, idempotencyKey: `mdm:result:${uuid}` });
			} else if (status === "NotNow") {
				await commandsOf(ctx).put(uuid, { ...command, status: "queued" });
				skip.add(uuid);
			} else {
				const chain = Array.isArray(v.message.ErrorChain) ? v.message.ErrorChain : [];
				const first = (chain[0] && typeof chain[0] === "object" && !Array.isArray(chain[0]) ? chain[0] : {}) as PlistDict;
				const error = `${status}: ${s(first.LocalizedDescription) || s(first.ErrorDomain) || "no detail"}`.slice(0, 300);
				await commandsOf(ctx).put(uuid, { ...command, status: "error", doneAt: now.toISOString(), error });
				await record(ctx as never, { type: "mdm.command_failed", stream: `asset:${device.assetTag}`, actor: `device:${device.udid}`, source: "system", title: `${device.assetTag}: ${command.requestType} failed`, assetTag: device.assetTag, payload: { command: uuid, error }, idempotencyKey: `mdm:error:${uuid}` });
			}
		}
	}
	await devicesOf(ctx).put(device.udid, updated);

	// Next command: the oldest queued one, or one sent long ago without an answer.
	for (const next of await pendingFor(ctx, device.udid)) {
		if (skip.has(next.id)) continue;
		if (next.status === "sent" && (next.sentAt && now.getTime() - Date.parse(next.sentAt) < RESEND_AFTER_MS)) continue;
		if (next.attempts >= MAX_ATTEMPTS) {
			await commandsOf(ctx).put(next.id, { ...next, status: "error", doneAt: now.toISOString(), error: "No answer after several attempts" });
			continue;
		}
		let command: PlistDict;
		try {
			command = buildCommand(next.requestType as RequestType, next.params, next.requestType === "InstallProfile" ? await profileBytes(reader, next) : undefined);
		} catch (e) {
			await commandsOf(ctx).put(next.id, { ...next, status: "cancelled", doneAt: now.toISOString(), error: e instanceof Error ? e.message : String(e) });
			continue;
		}
		await commandsOf(ctx).put(next.id, { ...next, status: "sent", sentAt: now.toISOString(), attempts: next.attempts + 1 });
		return { status: 200, body: buildPlist({ CommandUUID: next.id, Command: command }) };
	}
	return EMPTY;
}

function summarise(facts: Record<string, unknown>): Record<string, unknown> {
	const f = facts as import("./model.js").DeviceFacts;
	if (f.information) return { information: f.information.values };
	if (f.security) return { security: f.security.values };
	if (f.profiles) return { profiles: f.profiles.items.map((p) => p.identifier) };
	if (f.certificates) return { certificates: f.certificates.items.length };
	if (f.apps) return { apps: f.apps.count };
	return {};
}
