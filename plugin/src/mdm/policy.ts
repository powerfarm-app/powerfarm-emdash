/**
 * Who may change incidents and device profiles, enforced in EmDash's own save,
 * publish and delete hooks.
 *
 * Incidents: opened only by Powerfarm. People (editors and up, never AI
 * clients) change only the status and the resolution; resolving needs a
 * written resolution, and records who and when. Never deleted.
 *
 * Device profiles: drafted by editors, published (approved) only by an
 * administrator, and by a second person when that setting is on. A profile is
 * checked before it can be saved: it must be a configuration profile whose
 * identifier matches the record, with no credentials in it, and it may not
 * carry another MDM enrolment, a root certificate or an identity — the payloads
 * an attacker would use to take a device over or intercept its traffic.
 * Withdrawing a published profile removes it from the devices.
 */

import type { ContentPolicyDecision, ContentPolicyEvent, PluginContext } from "emdash";
import { ContentSaveRejectedError } from "emdash";

import { findSecretLike } from "../entities.js";
import { readSettings } from "../jobs.js";
import { PLUGIN_ID, ROLE } from "../model.js";
import { getReader } from "../runtime.js";
import { devicesOf, type MdmCtx } from "./model.js";
import { parsePlistDict, PlistError, type PlistDict } from "./plist.js";

export const MDM_COLLECTIONS = new Set(["incidents", "mdm_profiles"]);

const INCIDENT_EDITABLE = new Set(["incident_status", "resolution"]);
/** Payload types a Powerfarm-approved profile may never contain. */
export const FORBIDDEN_PAYLOADS = new Set(["com.apple.mdm", "com.apple.security.root", "com.apple.security.pkcs12", "com.apple.security.pkcs1", "com.apple.security.pem", "com.apple.security.scep", "com.apple.security.acme"]);

function reject(message: string): never {
	throw new ContentSaveRejectedError(message);
}

interface Actor {
	id: string;
	role: number;
	source?: string;
}

/** Checks a .mobileconfig for an administrator to approve. Returns problems; empty means acceptable. */
export function profileProblems(xml: string, identifier: string): string[] {
	let p: PlistDict;
	try {
		p = parsePlistDict(xml);
	} catch (e) {
		return [`The profile is not a readable XML plist${e instanceof PlistError ? `: ${e.message}` : ""}. Signed profiles must be exported unsigned.`];
	}
	const out: string[] = [];
	if (p.PayloadType !== "Configuration") out.push("PayloadType must be Configuration.");
	if (p.PayloadIdentifier !== identifier) out.push(`PayloadIdentifier is "${String(p.PayloadIdentifier)}", but this record says "${identifier}".`);
	const items = Array.isArray(p.PayloadContent) ? p.PayloadContent : [];
	if (!items.length) out.push("The profile has no payloads.");
	for (const item of items) {
		const t = item && typeof item === "object" && !Array.isArray(item) ? String((item as PlistDict).PayloadType ?? "") : "";
		if (FORBIDDEN_PAYLOADS.has(t)) out.push(`It contains a ${t} payload. Powerfarm does not push enrolments, root certificates or identities through profiles.`);
	}
	const secret = findSecretLike(xml);
	if (secret) out.push(`It looks like it contains a credential (${secret}). Keep passwords and keys out of profiles.`);
	return out;
}

export function beforeSaveMdm(collection: string, content: Record<string, unknown>, isNew: boolean, actor: Actor | undefined, current: Record<string, unknown> | null): Record<string, unknown> {
	if (!actor) return content; // Powerfarm itself
	if (actor.source === "mcp") reject(`AI clients cannot change ${collection === "incidents" ? "incidents" : "device profiles"}.`);
	if (actor.role < ROLE.EDITOR) reject("Editors and administrators only.");
	if (collection === "incidents") {
		if (isNew) reject("Incidents are opened by Powerfarm vigilance, not by hand.");
		for (const [k, v] of Object.entries(content)) {
			if (INCIDENT_EDITABLE.has(k) || k.startsWith("_")) continue;
			if (current && JSON.stringify(current[k] ?? null) !== JSON.stringify(v ?? null)) reject(`${k} is recorded by Powerfarm and cannot be edited. Change the status and write the resolution.`);
		}
		const status = String(content.incident_status ?? current?.incident_status ?? "open");
		if (current && ["resolved", "false_positive"].includes(String(current.incident_status)) && status !== current.incident_status) reject("A closed incident stays closed. If it happens again, Powerfarm opens a new one.");
		if (status === "resolved" || status === "false_positive") {
			const resolution = String(content.resolution ?? current?.resolution ?? "").trim();
			if (resolution.length < 10) reject("Write what was done and why (at least 10 characters) before closing an incident.");
			if (!current || current.incident_status !== status) return { ...content, resolved_by: actor.id, resolved_at: new Date().toISOString() };
		}
		return content;
	}
	// mdm_profiles
	const identifier = String(content.identifier ?? current?.identifier ?? "").trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9.-]{2,200}$/.test(identifier)) reject("Give the profile's PayloadIdentifier (reverse-DNS, for example org.powerfarm.baseline.passcode).");
	const install = String(content.install ?? current?.install ?? "required");
	const xml = typeof content.mobileconfig === "string" ? content.mobileconfig : typeof current?.mobileconfig === "string" ? current.mobileconfig : "";
	if (install === "known_external") {
		if (xml.trim()) reject("A known external profile is only an identifier Powerfarm accepts on devices; leave the profile body empty.");
		return content;
	}
	if (!xml.trim()) reject("Paste the .mobileconfig XML of the profile.");
	const problems = profileProblems(xml, identifier);
	if (problems.length) reject(problems.join(" "));
	return content;
}

export async function beforePublishMdm(event: ContentPolicyEvent, ctx: PluginContext): Promise<ContentPolicyDecision> {
	if (event.origin.source === "plugin" && event.origin.pluginId === PLUGIN_ID) return;
	if (event.origin.source === "mcp" || !event.actor) return { cancel: true, reason: "Only a person publishes this." };
	if (event.collection === "incidents") return;
	if (event.actor.role < ROLE.ADMIN) return { cancel: true, reason: "Only an administrator approves a device profile." };
	const { refusal } = await import("../authority.js");
	const denied = await refusal(ctx as never, await getReader(), { actor: { id: event.actor.id, role: event.actor.role, source: event.origin.source }, capability: "approve.profile", scope: `mdm_profiles:${String(((event.content.data ?? event.content) as Record<string, unknown>).identifier ?? "")}`, what: "approve device profile" });
	if (denied) return { cancel: true, reason: denied };
	const settings = await readSettings(ctx);
	const authorId = typeof event.content.authorId === "string" ? event.content.authorId : null;
	if (settings.requireSecondPerson && authorId === event.actor.id) return { cancel: true, reason: "A second person must approve this profile: its author cannot." };
	const data = (event.content.data ?? event.content) as Record<string, unknown>;
	if (data.install !== "known_external") {
		const problems = profileProblems(String(data.mobileconfig ?? ""), String(data.identifier ?? ""));
		if (problems.length) return { cancel: true, reason: problems.join(" ").slice(0, 500) };
	}
}

export async function beforeDeleteMdm(collection: string, id: string): Promise<boolean> {
	if (collection === "incidents") return false;
	const row = await (await getReader()).resolve("mdm_profiles", id, "draft");
	return !(row && (row.state === "published" || row.publishedAt));
}

/** A profile an administrator withdraws is removed from the devices that have it. */
export async function afterUnpublishMdm(collection: string, content: Record<string, unknown>, ctx: MdmCtx): Promise<number> {
	if (collection !== "mdm_profiles") return 0;
	const data = (content.data ?? content) as Record<string, unknown>;
	const identifier = typeof data.identifier === "string" ? data.identifier : null;
	if (!identifier || data.install === "known_external") return 0;
	const { queueCommand } = await import("./protocol.js");
	let queued = 0;
	for (const { data: d } of (await devicesOf(ctx).query({ where: { status: "enrolled" }, limit: 100 })).items) {
		if (!(d.facts.profiles?.items ?? []).some((p) => p.identifier === identifier)) continue;
		// oxlint-disable-next-line no-await-in-loop
		await queueCommand(ctx, { udid: d.udid, requestType: "RemoveProfile", params: { identifier }, issuedBy: "policy", reason: `Profile ${identifier} was withdrawn` });
		// oxlint-disable-next-line no-await-in-loop
		await ctx.kv.delete(`mdm:installed:${d.udid}:${identifier}`);
		queued++;
	}
	return queued;
}
