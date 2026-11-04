// Powerfarm Authority through the real hooks: principals, grants, the bootstrap,
// advisory and enforced modes, every governed path, agents, suspension, and the
// release gate.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, test } from "node:test";

import { AUTHORITY_SETTING, authorize, CAPABILITY_IDS, GOVERNED_PATHS } from "../src/authority.ts";
import { ContentReader } from "../src/content.ts";
import { authorizeDeploy, draftRelease, recordDeployment, RELEASE_SETTINGS } from "../src/release.ts";
import { ADMIN, ADMIN2, AI, EDITOR, makeWorld, type World } from "./entity-world.ts";

let w: World;
const reader = () => new ContentReader(w.db.port());
const settings = () => (w.ctx as unknown as { settings: { values: Record<string, unknown> } }).settings.values;
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const journal = () => [...w.ctx.storage.journal.rows.values()].map((r) => r.value as { type: string; payload?: Record<string, unknown> });
let orgId: string | null = null;

beforeEach(() => {
	w = makeWorld();
	orgId = null;
});

function org() {
	orgId ??= w.db.insert("organizations", { title: "Powerfarm", code: "OR-0001", lifecycle: "active", classification: "internal" }, { status: "published" }).id;
	return orgId;
}

async function activePerson(user: { id: string }, title: string, collection: "people" | "agents" = "people", extra: Record<string, unknown> = {}) {
	const owner = collection === "people" ? org() : (await activePerson({ id: `owner-of-${title.replace(/\W/g, "").toLowerCase()}` }, `Owner of ${title}`)).id;
	const d = await w.draftAs(ADMIN, collection, { title, identifiers: [{ namespace: "emdash_user", value: user.id }], ...extra }, { owner: [owner] });
	let r = await w.publishAs(ADMIN, collection, d.id);
	assert.equal(r, undefined, r);
	await w.editAs(ADMIN, collection, d.id, { lifecycle: "active" });
	r = await w.publishAs(ADMIN, collection, d.id);
	assert.equal(r, undefined, r);
	return { id: d.id, subject: `${collection}:${String(w.row(collection, d.id)!.code)}` };
}

async function grant(publisher: { id: string; role: number }, principal: string, capability: string, extra: Record<string, unknown> = {}) {
	const g = await w.draftAs(EDITOR, "grants", { title: `${capability} for ${principal}`, principal, capability, scope: "*", task: "Mission 001 recovery and operations", valid_until: inDays(90), ...extra });
	return { id: g.id, refused: await w.publishAs(publisher, "grants", g.id) };
}

const enforceAll = () => {
	settings()[AUTHORITY_SETTING] = CAPABILITY_IDS.join(",");
};

test("every principal gets a permanent id nobody can set or change; a user maps to one principal through the registry", async () => {
	const admin = await activePerson(ADMIN, "Dan");
	const pid = String(w.row("people", admin.id)!.principal_id);
	assert.match(pid, /^[0-9a-f-]{36}$/);
	await assert.rejects(w.editAs(ADMIN, "people", admin.id, { principal_id: "00000000-0000-0000-0000-000000000000" }), /assigned by Powerfarm/);
	await w.editAs(ADMIN, "people", admin.id, { role_title: "Founder", contact_email: "dan@example.com" });
	assert.equal(w.row("people", admin.id)!.principal_id, pid, "edits, a new e-mail or a new title never change it");
	const d = await authorize(w.ctx as never, reader(), { actor: ADMIN, capability: "approve.profile", scope: "mdm_profiles" });
	assert.equal(d.principal, admin.subject);
});

test("advisory by default: a missing grant is recorded as would-deny, not applied; an unknown capability is always refused", async () => {
	await activePerson(ADMIN, "Dan");
	const d = await authorize(w.ctx as never, reader(), { actor: ADMIN, capability: "approve.profile", scope: "mdm_profiles" });
	assert.equal(d.enforced, false);
	assert.equal(d.allowed, true);
	assert.equal(d.wouldAllow, false);
	assert.ok(journal().some((e) => e.type === "authority.would_deny"));
	assert.equal((await authorize(w.ctx as never, reader(), { actor: ADMIN, capability: "everything", scope: "*" })).allowed, false);
});

test("bootstrap: the first authority.grant comes from an administrator to a person; after that only holders grant, never to themselves", async () => {
	const dan = await activePerson(ADMIN, "Dan");
	const ana = await activePerson(EDITOR, "Ana");
	enforceAll();
	assert.match(String((await grant(ADMIN, ana.subject, "approve.profile")).refused), /bootstrap grant/);
	const boot = await grant(ADMIN, dan.subject, "authority.grant");
	assert.equal(boot.refused, undefined, boot.refused);
	const boot0 = journal().find((e) => e.type === "authority.bootstrap");
	assert.equal(boot0?.payload?.selfGrant, true, "with one administrator the bootstrap is a self-grant, and says so");
	assert.equal(boot0?.payload?.twoPersonRuleSatisfied, false, "never presented as independent");
	assert.equal((await grant(ADMIN, ana.subject, "approve.profile")).refused, undefined);
	assert.match(String((await grant(ADMIN, dan.subject, "approve.profile")).refused), /themselves/);
	assert.match(String((await grant(ADMIN2, ana.subject, "policy.publish")).refused), /not linked/);
	await assert.rejects(w.draftAs(AI, "grants", { title: "x", principal: ana.subject, capability: "mdm.command", scope: "*", task: "AI wants power", valid_until: inDays(5) }, {}, "mcp"), /AI clients/);
	await assert.rejects(w.draftAs(EDITOR, "grants", { title: "x", principal: ana.subject, capability: "approve.profile", scope: "*", task: "Too long a grant", valid_until: inDays(500) }), /at most 366 days/);
});

test("enforced: each governed path refuses without a grant and allows with one", async () => {
	const dan = await activePerson(ADMIN, "Dan");
	const ana = await activePerson(EDITOR, "Ana");
	await grant(ADMIN, dan.subject, "authority.grant"); // bootstrap, in advisory mode
	enforceAll();

	// identity.admin: publishing a person
	const p = await w.draftAs(EDITOR, "people", { title: "Rui" }, { owner: [org()] });
	assert.match(String(await w.publishAs(ADMIN, "people", p.id)), /no current grant for identity\.admin/);
	assert.equal((await grant(ADMIN, ana.subject, "identity.admin", { scope: "people" })).refused, undefined);
	assert.equal(await w.publishAs(EDITOR, "people", p.id), undefined, "Ana now holds identity.admin on people");

	// policy.publish
	const pol = await w.draftAs(EDITOR, "policies", { title: "Device baseline", owner_principal: dan.subject, scope: "All company devices", body: "Every device runs the Powerfarm baseline profile." });
	assert.match(String(await w.publishAs(ADMIN, "policies", pol.id)), /policy\.publish/);
	assert.equal((await grant(ADMIN, ana.subject, "policy.publish")).refused, undefined);
	assert.equal(await w.publishAs(EDITOR, "policies", pol.id), undefined);
	assert.match(String(await w.unpublishAs(ADMIN2, "policies", pol.id)), /not linked/, "withdrawing is authority too");

	// approve.profile
	const xml = '<?xml version="1.0"?><plist version="1.0"><dict><key>PayloadType</key><string>Configuration</string><key>PayloadIdentifier</key><string>org.powerfarm.t</string><key>PayloadContent</key><array><dict><key>PayloadType</key><string>com.apple.applicationaccess</string></dict></array></dict></plist>';
	const prof = await w.draftAs(EDITOR, "mdm_profiles", { title: "t", identifier: "org.powerfarm.t", install: "required", platform: "all", mobileconfig: xml });
	assert.match(String(await w.publishAs(ADMIN, "mdm_profiles", prof.id)), /approve\.profile/);

	// release.production, and the author rule
	const rel = await w.draftAs(EDITOR, "releases", { title: "site 1.4.0", code: "1.4.0", repository: "powerfarm/site", source_revision: "a".repeat(40), artifact_digest: `sha256:${"b".repeat(64)}`, environment: "production" });
	assert.match(String(await w.publishAs(ADMIN, "releases", rel.id)), /release\.production/);
	assert.equal((await grant(ADMIN, ana.subject, "release.production")).refused, undefined);
	assert.match(String(await w.publishAs(EDITOR, "releases", rel.id)), /author of a release cannot approve it/, "Ana drafted it");

	// identity.admin on a registry transfer
	const entry = w.db.db.prepare("select id from ec_identifiers where identifier = ?").get(`emdash_user:${EDITOR.id}`) as { id: string };
	await assert.rejects(w.editAs(ADMIN, "identifiers", entry.id, { subject: dan.subject, rationale: "Moving this sign-in identity to test the rule." }), /identity\.admin/);

	// revoking a grant needs authority.grant
	const someGrant = w.db.db.prepare("select id from ec_grants where capability = 'policy.publish'").get() as { id: string };
	assert.match(String(await w.unpublishAs(ADMIN2, "grants", someGrant.id)), /not linked/);
});

test("every governed path in the list is wired to authorize in the code", () => {
	const src = path.join(import.meta.dirname, "..", "src");
	const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith(".ts") ? [path.join(dir, d.name)] : []));
	const code = files(src).filter((f) => !f.endsWith("authority.ts")).map((f) => readFileSync(f, "utf8")).join("\n");
	for (const { path: where, capability } of GOVERNED_PATHS) {
		assert.ok(code.includes(`capability: "${capability}"`) || code.includes(`"${capability}"`), `${where}: no call to authorize for ${capability}`);
	}
	assert.ok(code.includes('capability: "approve.destructive"'), "recovery approvals check approve.destructive");
	assert.ok(code.includes('capability: "mdm.command"'), "the MDM query route checks mdm.command");
});

test("agents: their own identity, a responsible person, short task-scoped grants they cannot exceed or misuse", async () => {
	const dan = await activePerson(ADMIN, "Dan");
	await grant(ADMIN, dan.subject, "authority.grant");
	await grant(ADMIN2, dan.subject, "mdm.command"); // advisory: allowed
	const agent = await activePerson({ id: "agent-claude-eng" }, "Claude engineering", "agents", { agent_kind: "ai_agent" });
	enforceAll();
	await assert.rejects(w.draftAs(EDITOR, "grants", { title: "x", principal: agent.subject, capability: "approve.profile", scope: "*", task: "Approve profiles for me", valid_until: inDays(5), delegated_by: dan.subject }), /Agents cannot hold approve\.profile/);
	await assert.rejects(w.draftAs(EDITOR, "grants", { title: "x", principal: agent.subject, capability: "mdm.command", scope: "*", task: "Refresh device reports", valid_until: inDays(5) }), /names the person delegating/);
	await assert.rejects(w.draftAs(EDITOR, "grants", { title: "x", principal: agent.subject, capability: "mdm.command", scope: "*", task: "Refresh device reports", valid_until: inDays(40), delegated_by: dan.subject }), /at most 30 days/);
	assert.equal((await grant(ADMIN, agent.subject, "mdm.command", { delegated_by: dan.subject, valid_until: inDays(7) })).refused, undefined);
	const d = await authorize(w.ctx as never, reader(), { actor: { id: "agent-claude-eng", role: 20, source: "mcp" }, capability: "mdm.command", scope: "assets:LAB-512" });
	assert.equal(d.allowed, true);
	assert.equal(d.delegator, dan.subject, "the journal records the agent and who delegated");
	assert.equal((await authorize(w.ctx as never, reader(), { actor: { id: "agent-claude-eng", role: 20, source: "mcp" }, capability: "release.production", scope: "releases:production" })).allowed, false);
});

test("suspension: grants held and delegated are revoked at once, authorize denies, and work opens for what EmDash and Cloudflare must do", async () => {
	const dan = await activePerson(ADMIN, "Dan");
	const ana = await activePerson(EDITOR, "Ana");
	await grant(ADMIN, dan.subject, "authority.grant");
	await grant(ADMIN, ana.subject, "approve.profile");
	enforceAll();
	assert.equal((await authorize(w.ctx as never, reader(), { actor: EDITOR, capability: "approve.profile", scope: "mdm_profiles" })).allowed, true);
	settings()[AUTHORITY_SETTING] = "";
	await w.editAs(ADMIN, "people", ana.id, { lifecycle: "suspended" });
	assert.equal(await w.publishAs(ADMIN, "people", ana.id), undefined);
	enforceAll();
	const d = await authorize(w.ctx as never, reader(), { actor: EDITOR, capability: "approve.profile", scope: "mdm_profiles" });
	assert.equal(d.allowed, false);
	assert.match(d.reason, /not active/);
	assert.equal((w.db.db.prepare("select count(*) as n from ec_grants where principal = ? and status = 'published'").get(ana.subject) as { n: number }).n, 0, "her grants are revoked");
	const work = w.db.db.prepare("select title from ec_work_items where subject = ?").all(ana.subject) as Array<{ title: string }>;
	assert.ok(work.some((t) => /Disable EmDash user editor-1/.test(t.title)));
	assert.ok(work.some((t) => /Cloudflare Access/.test(t.title)));
	assert.ok((w.db.db.prepare("select rule from ec_incidents").all() as Array<{ rule: string }>).some((i) => i.rule === "principal_suspended"));
});

test("release gate: CI drafts, a non-author with release.production approves, the release service gets a one-time authorisation for exactly that artifact", async () => {
	const dan = await activePerson(ADMIN, "Dan");
	await grant(ADMIN, dan.subject, "authority.grant");
	await grant(ADMIN2, dan.subject, "release.production");
	settings()[RELEASE_SETTINGS.ciAgent] = "agents:AG-0001";
	enforceAll();
	const commit = "c0ffee".padEnd(40, "0");
	const digest = `sha256:${"d".repeat(64)}`;
	await assert.rejects(draftRelease(w.ctx as never, { repository: "powerfarm/site", commit, artifactDigest: digest, environment: "production", version: "1.4.0", testsPassed: 10, testsFailed: 1 }), /failing tests/);
	const draft = await draftRelease(w.ctx as never, { repository: "powerfarm/site", commit, artifactDigest: digest, environment: "production", version: "1.4.0", testsPassed: 146, testsFailed: 0 });
	assert.equal((await draftRelease(w.ctx as never, { repository: "powerfarm/site", commit, artifactDigest: digest, environment: "production", version: "1.4.0", testsPassed: 146, testsFailed: 0 })).created, false, "drafted once");
	const ask = { version: "1.4.0", repository: "powerfarm/site", commit, artifactDigest: digest, environment: "production" };
	await assert.rejects(authorizeDeploy(w.ctx as never, reader(), ask), /no approved/);
	assert.equal(await w.publishAs(ADMIN, "releases", draft.id), undefined);
	await assert.rejects(authorizeDeploy(w.ctx as never, reader(), { ...ask, artifactDigest: `sha256:${"e".repeat(64)}` }), /not the one that was approved/);
	await assert.rejects(authorizeDeploy(w.ctx as never, reader(), { ...ask, commit: "f".repeat(40) }), /commit is not/);
	const auth = await authorizeDeploy(w.ctx as never, reader(), ask);
	assert.equal(auth.approvedBy, dan.subject);
	assert.deepEqual(await recordDeployment(w.ctx as never, { authorization: auth.authorization, ok: true, deployedVersion: "1.4.0" }), { recorded: true });
	await assert.rejects(recordDeployment(w.ctx as never, { authorization: auth.authorization, ok: true }), /already used/);
	const late = await authorizeDeploy(w.ctx as never, reader(), ask);
	await assert.rejects(recordDeployment(w.ctx as never, { authorization: late.authorization, ok: true }, new Date(Date.now() + 20 * 60_000)), /expired/);
});

test("fail closed: a decision that cannot be journalled is not given, the platform is audit-degraded, and the protected action does not happen", async () => {
	const dan = await activePerson(ADMIN, "Dan");
	const ana = await activePerson(EDITOR, "Ana");
	enforceAll();
	assert.equal((await grant(ADMIN, dan.subject, "authority.grant")).refused, undefined);
	const journalStore = w.ctx.storage.journal as unknown as { compareAndSet: (...a: unknown[]) => Promise<unknown> };
	const original = journalStore.compareAndSet.bind(journalStore);
	journalStore.compareAndSet = async () => {
		throw new Error("storage unavailable");
	};
	await assert.rejects(authorize(w.ctx as never, reader(), { actor: ADMIN, capability: "authority.grant", scope: "*" }), /storage unavailable/);
	const degraded = (await w.ctx.kv.get("audit:degraded")) as { degraded: boolean } | null;
	assert.equal(degraded?.degraded, true, "the failure is visible, not swallowed");
	const g = await w.draftAs(EDITOR, "grants", { title: "approve.profile for Ana", principal: ana.subject, capability: "approve.profile", scope: "*", task: "MDM profiles", valid_until: inDays(30) });
	const outcome = await w.publishAs(ADMIN, "grants", g.id).then((r) => r ?? "published", (e: Error) => `threw: ${e.message}`);
	assert.match(outcome, /threw: .*storage unavailable/, "the publish hook fails, so EmDash aborts the publish");
	assert.notEqual(w.row("grants", g.id)!.status, "published", "the grant is not published while its authority cannot be recorded");
	journalStore.compareAndSet = original;
	assert.equal((await authorize(w.ctx as never, reader(), { actor: ADMIN, capability: "authority.grant", scope: "*" })).allowed, true, "journal back: decisions resume");
});
