/**
 * Identity registry: identifiers that are unique across every record type.
 *
 * The registry is EmDash content: the `identifiers` collection, one entry per
 * identifier, whose `identifier` field (`namespace:value`) is a seed `unique`
 * field. EmDash's database enforces the uniqueness, so of two concurrent claims
 * exactly one create succeeds. Revisions record every change; the audit-log
 * plugin records who made it.
 *
 * Entries are created when a person publishes a record listing them
 * (`beforePublish`), released when a published record drops them (renamed to
 * `released/<entry>/<identifier>`, so the value is free again and the entry
 * keeps its history; EmDash's unique index also covers trashed rows), and
 * transferred by an administrator editing the entry's subject (with a
 * rationale) or by merging a duplicate record. Verification status is not
 * stored: it is derived from evidence (`identity_verified` attestations).
 * Mission 001 asset serials and ECIDs are mirrored read-only.
 */

import type { PluginContext } from "emdash";

import type { ContentReader, Entity } from "./content.js";

export interface Namespace {
	label: string;
	normalise: (value: string) => string;
	valid: RegExp;
	/** Only the plugin writes these (Mission 001 mirror). */
	readOnly?: boolean;
	/**
	 * 1.4: what the entry is. `identity` = an issuer and subject that names a
	 * principal (sign-in identities); `credential` = a reference to a credential
	 * (fingerprint, token id), never the secret itself; `record` = an official
	 * identifier of an organisation or thing (VAT, domain, serial).
	 */
	kind?: "identity" | "credential" | "record";
}

const upperCompact = (v: string) => v.toUpperCase().replace(/[\s.\-/]/g, "");
const domain = (v: string) => v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "");

export const NAMESPACES: Readonly<Record<string, Namespace>> = {
	vat: { label: "VAT number", normalise: upperCompact, valid: /^[A-Z]{2}[A-Z0-9]{2,13}$/ },
	lei: { label: "Legal Entity Identifier", normalise: upperCompact, valid: /^[A-Z0-9]{18}[0-9]{2}$/ },
	duns: { label: "D-U-N-S number", normalise: (v) => v.replace(/\D/g, ""), valid: /^\d{9}$/ },
	company_reg: { label: "Company registration (country:number)", normalise: (v) => v.trim().toUpperCase().replace(/\s/g, ""), valid: /^[A-Z]{2}:[A-Z0-9-]{2,30}$/ },
	domain: { label: "Domain", normalise: domain, valid: /^(?=.{3,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/ },
	email_domain: { label: "E-mail domain", normalise: domain, valid: /^(?=.{3,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/ },
	github: { label: "GitHub organisation or user", normalise: (v) => v.trim().toLowerCase(), valid: /^[a-z0-9](?:[a-z0-9-]{0,38})$/ },
	apple_serial: { label: "Apple serial number", normalise: (v) => v.trim().toUpperCase(), valid: /^[A-Z0-9]{8,20}$/, readOnly: true },
	apple_ecid: {
		label: "Apple ECID",
		normalise: (v) => {
			const hex = v.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
			return `0x${hex || "0"}`;
		},
		valid: /^0x[0-9a-f]{1,20}$/,
		readOnly: true,
	},
	// ---- 1.4 Powerfarm Identity: sign-in identities (issuer and subject) ----
	emdash_user: { label: "EmDash user id", normalise: (v) => v.trim(), valid: /^[A-Za-z0-9_-]{6,64}$/, kind: "identity" },
	oidc: { label: "OIDC identity (issuer|subject)", normalise: (v) => v.trim(), valid: /^https:\/\/[\x21-\x7b\x7d\x7e]{3,200}\|[\x21-\x7e]{1,255}$/, kind: "identity" },
	apple_managed: { label: "Managed Apple Account", normalise: (v) => v.trim().toLowerCase(), valid: /^[^\s@]{1,64}@[a-z0-9.-]{3,253}$/, kind: "identity" },
	git: { label: "Git provider identity (provider|id)", normalise: (v) => v.trim().toLowerCase(), valid: /^[a-z0-9.-]{2,60}\|[a-z0-9_.-]{1,100}$/, kind: "identity" },
	apple_udid: { label: "Apple device UDID", normalise: (v) => v.trim().toUpperCase(), valid: /^[0-9A-F-]{24,40}$/, kind: "identity" },
	// ---- credential references: never the secret itself ----
	mdm_cert: { label: "MDM device certificate (SHA-256)", normalise: (v) => v.trim().toLowerCase(), valid: /^[0-9a-f]{64}$/, kind: "credential" },
	cf_service_token: { label: "Cloudflare Access service token client id", normalise: (v) => v.trim().toLowerCase(), valid: /^[0-9a-f]{32}\.access$/, kind: "credential" },
	emdash_token: { label: "EmDash API token id", normalise: (v) => v.trim(), valid: /^[A-Za-z0-9_-]{6,64}$/, kind: "credential" },
	signed_client: { label: "Signed-request client id (bridge, CI, release service)", normalise: (v) => v.trim().toLowerCase(), valid: /^[a-z0-9][a-z0-9-]{2,40}$/, kind: "credential" },
};

/** `ext:<issuer>` namespaces for identifiers issued by anyone else. */
const EXTERNAL = /^ext:[a-z0-9][a-z0-9_.-]{1,40}$/;

export interface Identifier {
	namespace: string;
	value: string;
}

export function namespaceOf(ns: string): Namespace | null {
	if (Object.hasOwn(NAMESPACES, ns)) return NAMESPACES[ns]!;
	if (EXTERNAL.test(ns)) return { label: `Identifier issued by ${ns.slice(4)}`, normalise: (v) => v.trim(), valid: /^[\x21-\x7e]{1,120}$/ };
	return null;
}

export function registryId(id: Identifier): string {
	return `${id.namespace}|${id.value}`;
}

export function formatIdentifier(id: Identifier): string {
	return `${id.namespace}:${id.value}`;
}

/** Parse and normalise an `identifiers` field value. Never throws. */
export function parseIdentifiers(value: unknown, options: { allowReadOnly?: boolean } = {}): { identifiers: Identifier[]; errors: string[] } {
	if (value === null || value === undefined || value === "") return { identifiers: [], errors: [] };
	if (!Array.isArray(value)) return { identifiers: [], errors: ["Identifiers must be a list of {namespace, value}."] };
	const errors: string[] = [];
	const out: Identifier[] = [];
	const seen = new Set<string>();
	if (value.length > 20) errors.push("At most 20 identifiers per record.");
	value.slice(0, 20).forEach((item, i) => {
		const r = item as Record<string, unknown> | null;
		const nsName = typeof r?.namespace === "string" ? r.namespace.trim().toLowerCase() : "";
		const raw = typeof r?.value === "string" ? r.value : typeof r?.value === "number" ? String(r.value) : "";
		const ns = namespaceOf(nsName);
		if (!ns) return void errors.push(`Identifier ${i + 1}: unknown namespace "${nsName}". Use one of ${Object.keys(NAMESPACES).join(", ")}, or ext:<issuer>.`);
		if (ns.readOnly && !options.allowReadOnly) return void errors.push(`Identifier ${i + 1}: ${nsName} is recorded from Mission 001 inventory, not entered on entities.`);
		const normalised = ns.normalise(raw);
		if (!ns.valid.test(normalised)) return void errors.push(`Identifier ${i + 1}: "${raw}" is not a valid ${ns.label}.`);
		const id = { namespace: nsName, value: normalised };
		if (seen.has(registryId(id))) return void errors.push(`Identifier ${i + 1}: ${formatIdentifier(id)} is listed twice.`);
		seen.add(registryId(id));
		out.push(id);
	});
	return { identifiers: out, errors };
}

// ---------------------------------------------------------------------------
// Registry entries (EmDash content: collection `identifiers`)
// ---------------------------------------------------------------------------

/** One registry entry as the plugin reads it. */
export interface Claim {
	id: string;
	identifier: string;
	namespace: string;
	value: string;
	/** `<collection>:<KEY>` of the record it identifies. */
	subject: string;
	source: "record" | "asset_mirror" | "transfer";
	status: string;
}

export function claimOf(e: Entity): Claim {
	return {
		id: e.id,
		identifier: String(e.data.identifier ?? e.key ?? ""),
		namespace: String(e.data.namespace ?? ""),
		value: String(e.data.value ?? ""),
		subject: String(e.data.subject ?? ""),
		source: (["record", "asset_mirror", "transfer"].includes(String(e.data.source)) ? e.data.source : "record") as Claim["source"],
		status: e.status,
	};
}

/** Registry entries for these identifiers (any status: a draft entry still holds its value). */
export async function lookupMany(reader: ContentReader, ids: readonly Identifier[]): Promise<Map<string, Claim>> {
	if (ids.length === 0) return new Map();
	const entries = await reader.byField("identifiers", "identifier", ids.map(formatIdentifier), "draft", ids.length * 2);
	return new Map(entries.map((e) => [String(e.data.identifier), claimOf(e)]));
}

export async function lookup(reader: ContentReader, id: Identifier): Promise<Claim | null> {
	return (await lookupMany(reader, [id])).get(formatIdentifier(id)) ?? null;
}

export const RELEASED = "released/";

export async function claimsForSubject(reader: ContentReader, subject: string): Promise<Claim[]> {
	return (await reader.byField("identifiers", "subject", [subject], "draft", 100)).map(claimOf).filter((c) => !c.identifier.startsWith(RELEASED));
}

/** Free an entry's value while keeping the entry and its revisions as history. */
async function release(ctx: Ctx, claim: Pick<Claim, "id" | "identifier">, note: string): Promise<boolean> {
	const c = writer(ctx);
	if (!c.update) return false;
	await c.update("identifiers", claim.id, { identifier: `${RELEASED}${claim.id}/${claim.identifier}`, title: `${claim.identifier} (released)`, rationale: note.slice(0, 2000) });
	return true;
}

/** Identifiers already held by another record. For duplicate detection on save. */
export async function conflicts(reader: ContentReader, subject: string | null, ids: Identifier[]): Promise<Array<{ identifier: Identifier; holder: Claim }>> {
	const found = await lookupMany(reader, ids);
	const out: Array<{ identifier: Identifier; holder: Claim }> = [];
	for (const id of ids) {
		const holder = found.get(formatIdentifier(id));
		if (holder && holder.subject !== subject) out.push({ identifier: id, holder });
	}
	return out;
}

type Ctx = Pick<PluginContext, "content" | "log">;
type Writable = NonNullable<PluginContext["content"]> & {
	create?: (collection: string, data: Record<string, unknown>) => Promise<{ id: string }>;
	update?: (collection: string, id: string, data: Record<string, unknown>) => Promise<unknown>;
	delete?: (collection: string, id: string) => Promise<boolean>;
	getVersioned?: (collection: string, id: string) => Promise<{ _rev: string } | null>;
	publish?: (collection: string, id: string, options: { _rev: string }) => Promise<unknown>;
};

function writer(ctx: Ctx): Writable {
	return ctx.content as Writable;
}

async function publishEntry(ctx: Ctx, id: string): Promise<void> {
	const c = writer(ctx);
	if (!c.getVersioned || !c.publish) return;
	const v = await c.getVersioned("identifiers", id);
	if (v) await c.publish("identifiers", id, { _rev: v._rev });
}

/**
 * Make sure every identifier has a registry entry for this subject. All or
 * nothing in effect: if any is held by another record, the entries this call
 * created are moved to the trash again and the conflicts are returned. EmDash's
 * unique index decides races; a losing create is looked up and reported.
 */
export { release as releaseEntry };

export async function claimAll(
	ctx: Ctx,
	reader: ContentReader,
	subject: string,
	ids: Identifier[],
	source: Claim["source"] = "record",
): Promise<{ ok: true; created: Array<{ id: string; identifier: string }> } | { ok: false; conflicts: Array<{ identifier: Identifier; holder: Claim }> }> {
	const c = writer(ctx);
	if (!c.create) throw new Error("content:write is not granted to Powerfarm");
	const existing = await lookupMany(reader, ids);
	const created: Array<{ id: string; identifier: string }> = [];
	const lost: Array<{ identifier: Identifier; holder: Claim }> = [];
	for (const id of ids) {
		const name = formatIdentifier(id);
		const held = existing.get(name);
		if (held) {
			if (held.subject !== subject) lost.push({ identifier: id, holder: held });
			// A transferred identifier now listed on the receiving record is an ordinary claim again.
			else if (held.source === "transfer" && source === "record" && c.update) await c.update("identifiers", held.id, { source: "record" });
			continue;
		}
		try {
			// oxlint-disable-next-line no-await-in-loop -- at most 20 identifiers
			const entry = await c.create("identifiers", { title: name, identifier: name, namespace: id.namespace, value: id.value, subject, source });
			created.push({ id: entry.id, identifier: name });
			// oxlint-disable-next-line no-await-in-loop
			await publishEntry(ctx, entry.id);
		} catch (error) {
			// oxlint-disable-next-line no-await-in-loop -- lost a race: EmDash's unique index refused the create
			const winner = await lookup(reader, id);
			if (winner && winner.subject !== subject) lost.push({ identifier: id, holder: winner });
			else if (!winner) throw error;
		}
	}
	if (lost.length > 0) {
		for (const entry of created) {
			// oxlint-disable-next-line no-await-in-loop
			await release(ctx, entry, `Undone: ${subject} could not claim every identifier.`).catch((error) => ctx.log.error("Could not undo an identifier claim", { id: entry.id, error: String(error) }));
		}
		return { ok: false, conflicts: lost };
	}
	return { ok: true, created };
}

/** Release the subject's entries its published record no longer lists. */
export async function releaseDropped(ctx: Ctx, reader: ContentReader, subject: string, keep: Identifier[]): Promise<string[]> {
	const keepNames = new Set(keep.map(formatIdentifier));
	const released: string[] = [];
	for (const claim of await claimsForSubject(reader, subject)) {
		// Mirrored asset identifiers are not the record's to release; transferred ones wait
		// until the receiving record lists them (claimAll then makes them ordinary).
		if (keepNames.has(claim.identifier) || claim.source !== "record") continue;
		// oxlint-disable-next-line no-await-in-loop
		if (await release(ctx, claim, `Released: no longer listed on ${subject}.`)) released.push(claim.identifier);
	}
	return released;
}

/**
 * Merge: every identifier the duplicate holds moves to the survivor, marked as a
 * transfer with the rationale. Called after an administrator published the
 * duplicate with `merged_into`; EmDash revisions record each entry's change.
 */
export async function moveAll(ctx: Ctx, reader: ContentReader, from: string, to: string, rationale: string): Promise<string[]> {
	const moved: string[] = [];
	for (const claim of await claimsForSubject(reader, from)) {
		if (claim.source === "asset_mirror") continue;
		// oxlint-disable-next-line no-await-in-loop
		await writer(ctx).update?.("identifiers", claim.id, { subject: to, source: "transfer", rationale: `Merged from ${from}: ${rationale}`.slice(0, 2000) });
		moved.push(claim.identifier);
	}
	return moved;
}

// ---------------------------------------------------------------------------
// Derived verification status
// ---------------------------------------------------------------------------

export type IdentifierStatus = "reported" | "imported" | "attested" | "verified";

export interface IdentityEvidence {
	attests: string | null;
	identifier: string | null;
	digestVerified: boolean;
	signedBy: string | null;
	createdAt: string;
}

export function identifierStatus(claim: Pick<Claim, "source"> | null, id: Identifier, evidence: readonly IdentityEvidence[]): IdentifierStatus {
	const name = formatIdentifier(id);
	const attestations = evidence.filter((e) => e.attests === "identity_verified" && e.identifier === name && e.signedBy);
	if (attestations.some((e) => e.digestVerified)) return "verified";
	if (attestations.length > 0) return "attested";
	// Mirrored from Mission 001 inventory rather than entered on a record.
	if (claim?.source === "asset_mirror") return "imported";
	return "reported";
}

// ---------------------------------------------------------------------------
// Mission 001 mirror (read-only)
// ---------------------------------------------------------------------------

/** Mirror asset serials and ECIDs into the registry. Conflicts are reported, never resolved automatically. */
export async function mirrorAssets(
	ctx: Ctx,
	reader: ContentReader,
	assets: Array<{ key: string; serial: string | null; ecid: string | null }>,
): Promise<{ claimed: number; conflicts: string[] }> {
	let claimed = 0;
	const problems: string[] = [];
	for (const asset of assets) {
		const ids: Identifier[] = [];
		if (asset.serial) ids.push({ namespace: "apple_serial", value: NAMESPACES.apple_serial!.normalise(asset.serial) });
		if (asset.ecid) ids.push({ namespace: "apple_ecid", value: NAMESPACES.apple_ecid!.normalise(asset.ecid) });
		const valid = ids.filter((i) => namespaceOf(i.namespace)!.valid.test(i.value));
		if (valid.length === 0) continue;
		const subject = `assets:${asset.key.toUpperCase()}`;
		// oxlint-disable-next-line no-await-in-loop
		const result = await claimAll(ctx, reader, subject, valid, "asset_mirror");
		if (result.ok) claimed += result.created.length;
		else problems.push(...result.conflicts.map((c) => `${formatIdentifier(c.identifier)} is recorded on ${asset.key} and on ${c.holder.subject.split(":")[1]}`));
	}
	return { claimed, conflicts: [...new Set(problems)] };
}
