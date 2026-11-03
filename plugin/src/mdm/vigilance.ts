/**
 * Vigilance: what Powerfarm watches on every enrolled device, and what it does
 * when something is wrong.
 *
 * Findings become `incidents` content (one open incident per rule and device;
 * repeats raise its count and last-seen time), and serious ones are e-mailed to
 * the alert address through EmDash's email capability, if one is configured.
 * Vigilance never changes a device on its own beyond two things a person has
 * already approved: reading it (the allowlisted queries) and installing the
 * profiles an administrator published as required. It never removes a
 * profile, erases or locks anything: a person decides that.
 *
 * The same findings give each device a 0–100 score, which Cloudflare Access
 * reads through the custom device posture integration (posture.ts).
 */

import type { ContentReader } from "../content.js";
import { record } from "../journal.js";
import { osAccepted } from "../recovery.js";
import { QUERY_COMMANDS } from "./commands.js";
import { commandsOf, devicesOf, MDM_DEFAULTS, MDM_SETTINGS, type MdmCtx, type MdmDevice } from "./model.js";

export type Severity = "critical" | "high" | "medium" | "low";
const RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

/** Profiles that are Powerfarm's own and always allowed: the enrolment profile the bridge builds. */
export const ENROLMENT_PROFILE_PREFIX = "org.powerfarm.mdm.enrolment";

export interface IncidentInput {
	rule: string;
	severity: Severity;
	assetTag: string | null;
	udid: string | null;
	at: Date;
	detail: string;
}

const OPEN = new Set(["open", "investigating"]);

async function readerFor(): Promise<ContentReader> {
	const { getReader } = await import("../runtime.js");
	return getReader();
}

/**
 * Open (or repeat) an incident. One open incident per rule and subject: the
 * KV key remembers which incident is open, its unique `origin` makes the create
 * happen once even if two runs race.
 */
export async function raiseIncident(ctx: MdmCtx, input: IncidentInput): Promise<{ id: string; created: boolean } | null> {
	const subjectKey = input.assetTag ?? input.udid ?? "unknown";
	const kvKey = `incident:open:${input.rule}:${subjectKey}`;
	const reader = await readerFor();
	const openOrigin = await ctx.kv.get<string>(kvKey);
	if (openOrigin) {
		const existing = (await reader.byField("incidents", "origin", [openOrigin], "draft", 1))[0];
		if (existing && OPEN.has(String(existing.data.incident_status))) {
			const count = Number(existing.data.occurrences ?? 1) + 1;
			await ctx.content?.update?.("incidents", existing.id, { occurrences: count, last_seen: input.at.toISOString() });
			return { id: existing.id, created: false };
		}
	}
	const origin = `${input.rule}:${subjectKey}:${input.at.toISOString()}`;
	const content = ctx.content;
	if (!content?.create) {
		ctx.log.error("Powerfarm cannot record incidents: content:write is not granted", { rule: input.rule });
		return null;
	}
	let id: string;
	try {
		id = (
			await content.create("incidents", {
				title: `${input.assetTag ?? input.udid ?? "Unknown device"}: ${TITLES[input.rule] ?? input.rule}`.slice(0, 200),
				severity: input.severity,
				incident_status: "open",
				rule: input.rule,
				subject: input.assetTag ? `assets:${input.assetTag}` : null,
				udid: input.udid,
				detail: input.detail.slice(0, 2000),
				first_seen: input.at.toISOString(),
				last_seen: input.at.toISOString(),
				occurrences: 1,
				origin,
			})
		).id;
	} catch {
		const winner = (await reader.byField("incidents", "origin", [origin], "draft", 1))[0];
		if (!winner) throw new Error(`Could not record incident ${input.rule}`);
		return { id: winner.id, created: false };
	}
	if (content.getVersioned && content.publish) {
		const v = await content.getVersioned("incidents", id);
		if (v) await content.publish("incidents", id, { _rev: v._rev });
	}
	await ctx.kv.set(kvKey, origin);
	await record(ctx as never, { type: "incident.opened", stream: input.assetTag ? `asset:${input.assetTag}` : "system", actor: "powerfarm:vigilance", source: "system", title: `${input.severity.toUpperCase()}: ${TITLES[input.rule] ?? input.rule}`, assetTag: input.assetTag, payload: { rule: input.rule, udid: input.udid, detail: input.detail.slice(0, 500) }, idempotencyKey: `incident:${origin}` });
	if (RANK[input.severity] >= RANK.high) await alert(ctx, input);
	return { id, created: true };
}

async function alert(ctx: MdmCtx, input: IncidentInput): Promise<void> {
	const to = await ctx.settings.get<string>(MDM_SETTINGS.alertEmail);
	const email = (ctx as { email?: { send(m: { to: string; subject: string; text: string }): Promise<void> } }).email;
	if (!to || !email) return;
	await email
		.send({
			to,
			subject: `[Powerfarm ${input.severity}] ${input.assetTag ?? input.udid ?? "device"}: ${TITLES[input.rule] ?? input.rule}`,
			text: `${input.detail}\n\nSeen at ${input.at.toISOString()}. Open Powerfarm → Content → Incidents to triage. This message contains no links on purpose: open Powerfarm yourself.`,
		})
		.catch((e: unknown) => ctx.log.warn("Incident alert e-mail failed", { rule: input.rule, error: String(e) }));
}

export const TITLES: Record<string, string> = {
	identity_mismatch: "message signed by a different device identity",
	left_management: "device left Powerfarm management",
	enrolment_refused: "enrolment refused",
	re_enrolled: "enrolled again with a new identity",
	unknown_profile: "configuration profile Powerfarm did not approve",
	not_seen: "device has not checked in",
	no_passcode: "no passcode",
	filevault_off: "FileVault is off",
	sip_off: "System Integrity Protection is off",
	not_supervised: "device is not supervised",
	os_policy: "OS version outside policy",
	os_downgrade: "OS version went backwards",
	identity_expiring: "device identity certificate expires soon",
	profile_failed: "required profile could not be installed",
};

export interface Finding {
	rule: string;
	severity: Severity;
	detail: string;
}

export interface ProfilePolicy {
	id: string;
	identifier: string;
	install: "required" | "available" | "known_external";
	platform: "all" | "ios" | "macos";
	revision: string | null;
}

const isMac = (d: MdmDevice) => /^Mac/i.test(d.productName ?? d.model ?? "");

/** Pure: the findings for one device, from its record, its asset's OS policy and the published profiles. */
export function evaluateDevice(device: MdmDevice, osPolicy: string | null, profiles: ProfilePolicy[], now: Date, staleHours: number, previousMaxOs: string | null): Finding[] {
	const out: Finding[] = [];
	if (device.status !== "enrolled") return out;
	const ageH = (now.getTime() - Date.parse(device.lastSeenAt)) / 3_600_000;
	if (ageH > staleHours) out.push({ rule: "not_seen", severity: "high", detail: `${device.assetTag} last checked in ${Math.floor(ageH)} hours ago (limit ${staleHours}). It may be off, offline, or blocked from reaching Powerfarm.` });

	const allowed = new Set(profiles.map((p) => p.identifier));
	for (const p of device.facts.profiles?.items ?? []) {
		if (p.identifier.startsWith(ENROLMENT_PROFILE_PREFIX) || allowed.has(p.identifier)) continue;
		out.push({ rule: "unknown_profile", severity: "critical", detail: `${device.assetTag} has the profile "${p.name || p.identifier}" (${p.identifier}), which no administrator approved in Powerfarm. Profiles can install certificates, VPNs and proxies that intercept traffic. Inspect it on the device and remove it if nobody can account for it.` });
	}
	const sec = device.facts.security?.values ?? {};
	if (sec.PasscodePresent === false) out.push({ rule: "no_passcode", severity: "high", detail: `${device.assetTag} reports no passcode.` });
	if (isMac(device) && sec.FDE_Enabled === false) out.push({ rule: "filevault_off", severity: "high", detail: `${device.assetTag} reports FileVault off.` });
	if (isMac(device) && sec.SystemIntegrityProtectionEnabled === false) out.push({ rule: "sip_off", severity: "critical", detail: `${device.assetTag} reports System Integrity Protection disabled. That is only possible from recoveryOS by someone with access: treat as compromise.` });
	const info = device.facts.information?.values ?? {};
	if (info.IsSupervised === false && !isMac(device)) out.push({ rule: "not_supervised", severity: "medium", detail: `${device.assetTag} is not supervised: Powerfarm cannot enforce restrictions on it.` });
	if (device.osVersion && osPolicy) {
		const r = osAccepted(osPolicy, device.osVersion);
		if (!r.pass) out.push({ rule: "os_policy", severity: "medium", detail: r.reason });
	}
	if (device.osVersion && previousMaxOs && osAccepted(`>=${previousMaxOs}`, device.osVersion).pass === false) {
		out.push({ rule: "os_downgrade", severity: "critical", detail: `${device.assetTag} reports OS ${device.osVersion}, older than the ${previousMaxOs} it reported before. Downgrades are not normal; treat as compromise until explained.` });
	}
	if (Date.parse(device.certNotAfter) - now.getTime() < 30 * 86_400_000) out.push({ rule: "identity_expiring", severity: "medium", detail: `${device.assetTag}'s device identity expires ${device.certNotAfter.slice(0, 10)}. Re-enrol it through the bridge before then.` });
	return out;
}

/** 0–100 for Cloudflare Access: 100 healthy, lower with open incidents, 0 when not managed. */
export function score(device: MdmDevice | null, openSeverities: Severity[], now: Date, staleHours: number): number {
	if (!device || device.status !== "enrolled") return 0;
	let s = 100;
	if (openSeverities.includes("critical")) s = 0;
	else if (openSeverities.includes("high")) s = Math.min(s, 40);
	else if (openSeverities.includes("medium")) s = Math.min(s, 70);
	else if (openSeverities.includes("low")) s = Math.min(s, 90);
	if ((now.getTime() - Date.parse(device.lastSeenAt)) / 3_600_000 > staleHours) s = Math.min(s, 40);
	return s;
}

export async function openSeveritiesFor(reader: ContentReader, assetTag: string): Promise<Severity[]> {
	const items = await reader.byField("incidents", "subject", [`assets:${assetTag}`], "draft", 200);
	return items.filter((i) => OPEN.has(String(i.data.incident_status))).map((i) => i.data.severity as Severity);
}

export async function publishedProfiles(reader: ContentReader): Promise<ProfilePolicy[]> {
	return (await reader.list("mdm_profiles", "published", 200)).map((p) => ({
		id: p.id,
		identifier: String(p.data.identifier ?? ""),
		install: (p.data.install as ProfilePolicy["install"]) ?? "available",
		platform: (p.data.platform as ProfilePolicy["platform"]) ?? "all",
		revision: p.liveRevisionId,
	}));
}

/** The `vigilance` scheduled task: refresh what is stale, install required profiles, record findings. */
export async function vigilanceTask(ctx: MdmCtx, reader: ContentReader, now = new Date()): Promise<Record<string, number>> {
	if ((await ctx.settings.get<boolean>(MDM_SETTINGS.enabled)) !== true) return { skipped: 1 };
	const { mdmSchemaReady } = await import("./protocol.js");
	if (!(await mdmSchemaReady(reader))) return { skipped: 1, schemaMissing: 1 };
	const staleHours = (await ctx.settings.get<number>(MDM_SETTINGS.staleHours)) ?? MDM_DEFAULTS.staleHours;
	const everyH = (await ctx.settings.get<number>(MDM_SETTINGS.queryEveryHours)) ?? MDM_DEFAULTS.queryEveryHours;
	const { queueCommand } = await import("./protocol.js");
	const profiles = await publishedProfiles(reader);
	let devices = 0;
	let queued = 0;
	let findings = 0;
	const page = await devicesOf(ctx).query({ where: { status: "enrolled" }, limit: 100 });
	for (const { data: device } of page.items) {
		devices++;
		// 1. Ask again what is older than the interval.
		const ages: Record<string, string | undefined> = {
			DeviceInformation: device.facts.information?.at,
			SecurityInfo: device.facts.security?.at,
			ProfileList: device.facts.profiles?.at,
			CertificateList: device.facts.certificates?.at,
			InstalledApplicationList: device.facts.apps?.at,
		};
		for (const q of QUERY_COMMANDS) {
			const at = ages[q];
			const every = q === "CertificateList" || q === "InstalledApplicationList" ? 24 : everyH;
			if (!at || now.getTime() - Date.parse(at) > every * 3_600_000) {
				// oxlint-disable-next-line no-await-in-loop -- a handful of devices
				await queueCommand(ctx, { udid: device.udid, requestType: q, issuedBy: "vigilance", reason: "Scheduled check" }, now);
				queued++;
			}
		}
		// 2. Required profiles that are missing or out of date.
		const installed = new Set((device.facts.profiles?.items ?? []).map((p) => p.identifier));
		for (const p of profiles) {
			if (p.install !== "required" || (p.platform === "macos" && !isMac(device)) || (p.platform === "ios" && isMac(device))) continue;
			// oxlint-disable-next-line no-await-in-loop
			const doneRev = await ctx.kv.get<string>(`mdm:installed:${device.udid}:${p.identifier}`);
			if (installed.has(p.identifier) && doneRev === p.revision) continue;
			// oxlint-disable-next-line no-await-in-loop
			await queueCommand(ctx, { udid: device.udid, requestType: "InstallProfile", params: { profileId: p.id, identifier: p.identifier, revision: p.revision }, issuedBy: "vigilance", reason: `Required profile ${p.identifier}` }, now);
			queued++;
		}
		// 3. Findings.
		// oxlint-disable-next-line no-await-in-loop
		const asset = (await reader.resolve("assets", device.assetTag, "published")) ?? null;
		const osPolicy = asset && typeof asset.data.os_policy === "string" ? asset.data.os_policy : null;
		const maxKey = `mdm:maxos:${device.udid}`;
		// oxlint-disable-next-line no-await-in-loop
		const previousMax = await ctx.kv.get<string>(maxKey);
		for (const f of evaluateDevice(device, osPolicy, profiles, now, staleHours, previousMax)) {
			// oxlint-disable-next-line no-await-in-loop
			await raiseIncident(ctx, { ...f, assetTag: device.assetTag, udid: device.udid, at: now });
			findings++;
		}
		if (device.osVersion && (!previousMax || osAccepted(`>=${previousMax}`, device.osVersion).pass)) {
			// oxlint-disable-next-line no-await-in-loop
			await ctx.kv.set(maxKey, device.osVersion);
		}
	}
	// 4. Profile installs that failed.
	const failed = await commandsOf(ctx).query({ where: { status: "error", requestType: "InstallProfile" }, limit: 50 });
	for (const { data: c } of failed.items) {
		const key = `mdm:install-failure-seen:${c.id}`;
		// oxlint-disable-next-line no-await-in-loop
		if (await ctx.kv.get(key)) continue;
		// oxlint-disable-next-line no-await-in-loop
		await raiseIncident(ctx, { rule: "profile_failed", severity: "medium", assetTag: c.assetTag, udid: c.udid, at: now, detail: `${String(c.params.identifier)} could not be installed on ${c.assetTag}: ${c.error ?? "unknown error"}.` });
		// oxlint-disable-next-line no-await-in-loop
		await ctx.kv.set(key, true);
		findings++;
	}
	return { devices, queued, findings };
}
