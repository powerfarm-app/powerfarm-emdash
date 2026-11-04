/**
 * Powerfarm Authority: one decision, `authorize()`, for every governed
 * operation, on top of EmDash's own roles (both must allow).
 *
 * Who is acting: the EmDash user is mapped to a principal through the
 * identifier registry (`emdash_user:<id>` → `people:PE-…` or `agents:AG-…`).
 * What allows it: a published grant for that principal, capability and scope,
 * inside its validity window. For an agent, the person who delegated the grant
 * must be active and hold the same capability themselves. A principal that is
 * not active holds nothing.
 *
 * Default deny for an enforced capability: no mapping, no grant, an expired
 * grant or a scope that does not match all refuse. A capability is enforced
 * once all its paths are covered (GOVERNED_PATHS, each with a test); until an
 * administrator lists it in the setting, decisions are recorded but not
 * applied ("advisory"), so a missing grant cannot lock everyone out.
 *
 * Every decision goes to the journal: requester, acting principal, delegator,
 * grant, policy, mode and outcome.
 */

import type { ContentReader, Entity } from "./content.js";
import { record } from "./journal.js";
import { type CollectionSlug, ROLE } from "./model.js";

export const CAPABILITIES = {
	"authority.grant": "Publish or revoke grants",
	"identity.admin": "Activate, suspend or retire people and agents; link and transfer sign-in identities",
	"idp.keys": "Rotate the OIDC signing keys",
	"idp.config": "Register OIDC clients (Cloudflare Access)",
	"policy.publish": "Publish or withdraw policies",
	"approve.destructive": "Approve destructive recovery operations",
	"approve.profile": "Approve or withdraw device profiles",
	"mdm.command": "Ask managed devices for reports",
	"release.production": "Approve a release for production",
} as const;
export type Capability = keyof typeof CAPABILITIES;
export const CAPABILITY_IDS = Object.keys(CAPABILITIES) as Capability[];

/** Agents never hold authority over authority, identity, keys or policy, and never approve. */
export const AGENT_CAPABILITIES: readonly Capability[] = ["mdm.command"];

/** Every place a governed operation can happen. Each line has a test that it refuses without a grant once enforced. */
export const GOVERNED_PATHS: ReadonlyArray<{ path: string; capability: Capability }> = [
	{ path: "content:beforePublish grants", capability: "authority.grant" },
	{ path: "content:beforeUnpublish grants", capability: "authority.grant" },
	{ path: "content:beforePublish people, agents, organizations", capability: "identity.admin" },
	{ path: "content:beforeSave identifiers (transfer)", capability: "identity.admin" },
	{ path: "content:beforePublish policies", capability: "policy.publish" },
	{ path: "content:beforeUnpublish policies", capability: "policy.publish" },
	{ path: "content:beforePublish recovery_operations (destructive)", capability: "approve.destructive" },
	{ path: "content:beforePublish mdm_profiles", capability: "approve.profile" },
	{ path: "content:beforeUnpublish mdm_profiles", capability: "approve.profile" },
	{ path: "route mdm/query", capability: "mdm.command" },
	{ path: "content:beforePublish releases", capability: "release.production" },
	{ path: "route identity/oidc/rotate-key", capability: "idp.keys" },
	{ path: "route identity/oidc/client", capability: "idp.config" },
];

export const AUTHORITY_SETTING = "authorityEnforced";

export function isCapability(v: unknown): v is Capability {
	return typeof v === "string" && Object.hasOwn(CAPABILITIES, v);
}

export interface Actor {
	id: string;
	role: number;
	source?: string;
}

export interface Principal {
	subject: string; // people:PE-0001
	collection: "people" | "agents";
	key: string;
	principalId: string | null;
	title: string;
	active: boolean;
	entity: Entity;
}

export interface Decision {
	allowed: boolean;
	enforced: boolean;
	/** What would have happened under enforcement (equal to `allowed` when enforced). */
	wouldAllow: boolean;
	capability: string;
	scope: string;
	reason: string;
	principal: string | null;
	delegator: string | null;
	grant: string | null;
	policy: string | null;
}

type Ctx = Parameters<typeof record>[0] & { settings: { get<T>(k: string): Promise<T | null> } };

const IDENTITY_ENTRY = (userId: string) => `emdash_user:${userId}`;

/** The principal an EmDash user acts as, if one published registry entry links them. */
export async function principalOf(reader: ContentReader, userId: string): Promise<Principal | null> {
	const entry = (await reader.byField("identifiers", "identifier", [IDENTITY_ENTRY(userId)], "published", 2))[0];
	const subject = typeof entry?.data.subject === "string" ? entry.data.subject : null;
	if (!subject) return null;
	return principalBySubject(reader, subject);
}

export async function principalBySubject(reader: ContentReader, subject: string): Promise<Principal | null> {
	const m = /^(people|agents):([A-Z0-9-]{2,40})$/.exec(subject.trim());
	if (!m) return null;
	const entity = await reader.resolve(m[1] as CollectionSlug, m[2]!, "published");
	if (!entity) return null;
	return {
		subject: `${m[1]}:${entity.key ?? m[2]}`,
		collection: m[1] as "people" | "agents",
		key: entity.key ?? m[2]!,
		principalId: typeof entity.data.principal_id === "string" ? entity.data.principal_id : null,
		title: entity.title,
		active: entity.data.lifecycle === "active",
		entity,
	};
}

/**
 * The principal whose permanent id this is (people first, then agents). Ambiguity
 * (two published records with one id, which the unique field should prevent) is
 * treated as no principal: identity must never be guessed.
 */
export async function principalById(reader: ContentReader, principalId: string): Promise<Principal | null> {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(principalId)) return null;
	const found: Array<{ collection: "people" | "agents"; entity: Awaited<ReturnType<ContentReader["byField"]>>[number] }> = [];
	for (const collection of ["people", "agents"] as const) {
		// oxlint-disable-next-line no-await-in-loop -- two collections
		for (const entity of await reader.byField(collection, "principal_id", [principalId], "published", 2)) found.push({ collection, entity });
	}
	if (found.length !== 1) return null;
	const { collection, entity } = found[0]!;
	return principalBySubject(reader, `${collection}:${entity.key}`);
}

/** Does `scope` of a grant cover the requested scope? `*`, a collection, or an exact `collection:KEY`. */
export function scopeCovers(granted: string, requested: string): boolean {
	const g = granted.trim();
	if (g === "*") return true;
	if (g === requested) return true;
	return !g.includes(":") && requested.startsWith(`${g}:`);
}

function within(grant: Entity, now: Date): boolean {
	const from = Date.parse(String(grant.data.valid_from ?? ""));
	const until = Date.parse(String(grant.data.valid_until ?? ""));
	if (!Number.isFinite(until) || now.getTime() >= until) return false;
	return !Number.isFinite(from) || now.getTime() >= from;
}

/** Published grants a principal holds for a capability and scope now (not following delegation). */
export async function grantsHeld(reader: ContentReader, subject: string, capability: Capability, scope: string, now: Date): Promise<Entity[]> {
	return (await reader.byField("grants", "principal", [subject], "published", 200)).filter((g) => g.data.capability === capability && scopeCovers(String(g.data.scope ?? ""), scope) && within(g, now));
}

async function enforcedSet(ctx: Ctx): Promise<Set<string>> {
	const raw = (await ctx.settings.get<string>(AUTHORITY_SETTING)) ?? "";
	return new Set(raw.split(/[\s,]+/).filter(Boolean));
}

/**
 * The decision. `actor` undefined = Powerfarm itself (a hook or task acting on
 * something a person already approved): allowed, and recorded as such.
 */
export async function authorize(ctx: Ctx, reader: ContentReader, input: { actor?: Actor | null; capability: string; scope: string; now?: Date; what?: string }): Promise<Decision> {
	const now = input.now ?? new Date();
	const enforced = (await enforcedSet(ctx)).has(input.capability);
	const base = { capability: input.capability, scope: input.scope, principal: null, delegator: null, grant: null, policy: null } as Omit<Decision, "allowed" | "enforced" | "wouldAllow" | "reason">;
	const finish = async (wouldAllow: boolean, reason: string, extra: Partial<Decision> = {}): Promise<Decision> => {
		const d: Decision = { ...base, ...extra, enforced, wouldAllow, allowed: enforced ? wouldAllow : true, reason };
		await record(ctx, {
			type: d.wouldAllow ? "authority.allowed" : enforced ? "authority.denied" : "authority.would_deny",
			stream: "authority",
			actor: input.actor ? `user:${input.actor.id}` : "powerfarm",
			source: "policy",
			title: `${d.wouldAllow ? "Allowed" : enforced ? "Denied" : "Would deny"}: ${input.capability} on ${input.scope}${input.what ? ` (${input.what})` : ""}`.slice(0, 200),
			payload: { ...d, requestedBy: input.actor?.id ?? null, actingSource: input.actor?.source ?? null, at: now.toISOString() },
		});
		// No catch: a decision that cannot be journalled is not a decision. The journal
		// marks the platform audit-degraded and throws; the protected action does not run.
		return d;
	};

	if (!isCapability(input.capability)) return { ...(await finish(false, `Unknown capability ${input.capability}.`)), allowed: false };
	if (!input.actor) return finish(true, "Powerfarm acting on an earlier approval.", { principal: "powerfarm" });

	const principal = await principalOf(reader, input.actor.id);
	if (!principal) return finish(false, "This EmDash user is not linked to a Powerfarm person or agent (an emdash_user identifier on their record).");
	if (!principal.active) return finish(false, `${principal.subject} is not active.`, { principal: principal.subject });
	if (principal.collection === "agents" && !AGENT_CAPABILITIES.includes(input.capability)) {
		return finish(false, `Agents cannot hold ${input.capability}.`, { principal: principal.subject });
	}

	for (const grant of await grantsHeld(reader, principal.subject, input.capability, input.scope, now)) {
		const policy = typeof grant.data.policy === "string" && grant.data.policy ? grant.data.policy : null;
		if (principal.collection === "agents") {
			const by = typeof grant.data.delegated_by === "string" ? await principalBySubject(reader, grant.data.delegated_by) : null;
			if (!by || by.collection !== "people" || !by.active) continue;
			if (!(await grantsHeld(reader, by.subject, input.capability, input.scope, now)).length) continue; // nobody delegates more than they hold
			return finish(true, `Delegated by ${by.subject} under ${grant.key ?? grant.id}.`, { principal: principal.subject, delegator: by.subject, grant: grant.key ?? grant.id, policy });
		}
		return finish(true, `Held under ${grant.key ?? grant.id}.`, { principal: principal.subject, grant: grant.key ?? grant.id, policy });
	}
	return finish(false, `${principal.subject} holds no current grant for ${input.capability} on ${input.scope}.`, { principal: principal.subject });
}

/** For hooks: a refusal message, or null when allowed. */
export async function refusal(ctx: Ctx, reader: ContentReader, input: Parameters<typeof authorize>[2]): Promise<string | null> {
	const d = await authorize(ctx, reader, input);
	return d.allowed ? null : `Not authorised: ${d.reason}`;
}

// ---------------------------------------------------------------------------
// Grants and policies: what may be saved and published
// ---------------------------------------------------------------------------

const SUBJECT = /^(people|agents):[A-Z0-9-]{2,40}$/;
const SCOPE = /^(\*|[a-z_]+|[a-z_]+:[A-Za-z0-9._-]{1,64})$/;

export function grantProblems(data: Record<string, unknown>, now = new Date()): string[] {
	const out: string[] = [];
	const principal = String(data.principal ?? "").trim();
	if (!SUBJECT.test(principal)) out.push("Principal must be people:PE-… or agents:AG-….");
	if (!isCapability(data.capability)) out.push("Pick a capability from the list.");
	if (!SCOPE.test(String(data.scope ?? ""))) out.push("Scope is *, a collection (assets) or one record (assets:LAB-512).");
	const until = Date.parse(String(data.valid_until ?? ""));
	if (!Number.isFinite(until) || until <= now.getTime()) out.push("Valid until must be in the future.");
	const agent = principal.startsWith("agents:");
	const maxDays = agent ? 30 : 366;
	if (Number.isFinite(until) && until - now.getTime() > maxDays * 86_400_000) out.push(`A grant to ${agent ? "an agent" : "a person"} lasts at most ${maxDays} days.`);
	if (agent) {
		if (!/^people:[A-Z0-9-]{2,40}$/.test(String(data.delegated_by ?? ""))) out.push("A grant to an agent names the person delegating it (people:PE-…).");
		if (isCapability(data.capability) && !AGENT_CAPABILITIES.includes(data.capability)) out.push(`Agents cannot hold ${data.capability}.`);
	}
	if (String(data.task ?? "").trim().length < 10) out.push("Say what the grant is for (at least 10 characters).");
	return out;
}

/** Publishing a grant: the publisher holds authority.grant, is not the grantee, and (when required) is not its author. */
export async function grantPublishRefusal(ctx: Ctx & { settings: Ctx["settings"] }, reader: ContentReader, actor: Actor | undefined, data: Record<string, unknown>, authorId: string | null, requireSecondPerson: boolean, now = new Date()): Promise<string | null> {
	if (!actor) return "Grants are published by a person.";
	if (actor.source === "mcp") return "AI clients cannot publish grants.";
	const problems = grantProblems(data, now);
	if (problems.length) return problems.join(" ");
	const publisher = await principalOf(reader, actor.id);
	const grantee = await principalBySubject(reader, String(data.principal));
	if (!grantee?.active) return `${String(data.principal)} is not an active, published principal.`;
	if (requireSecondPerson && authorId === actor.id) return "A second person must publish this grant: its author cannot.";

	// Bootstrap: while no authority.grant exists at all, an administrator publishes the first one, to a person.
	// With a single human administrator that person is the grantee: recorded as such, never presented as independent.
	const anyAuthority = (await reader.byField("grants", "capability", ["authority.grant"], "published", 1)).length > 0;
	if (!anyAuthority) {
		if (actor.role < ROLE.ADMIN || data.capability !== "authority.grant" || !String(data.principal).startsWith("people:")) {
			return "No one holds authority.grant yet: an administrator must first grant it to a person (the bootstrap grant).";
		}
		const selfGrant = !!publisher && publisher.subject === String(data.principal).trim();
		await record(ctx, { type: "authority.bootstrap", stream: "authority", actor: `user:${actor.id}`, source: "policy", title: `Bootstrap: first authority.grant to ${String(data.principal)}${selfGrant ? " (self, single administrator)" : ""}`, payload: { principal: data.principal, publisher: actor.id, selfGrant, twoPersonRuleSatisfied: !selfGrant && authorId !== null && authorId !== actor.id } });
		return null;
	}
	if (publisher && publisher.subject === String(data.principal).trim()) return "Nobody grants authority to themselves.";
	return refusal(ctx, reader, { actor, capability: "authority.grant", scope: String(data.principal), now, what: `grant ${String(data.capability)} to ${String(data.principal)}` });
}
