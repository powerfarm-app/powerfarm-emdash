/**
 * Release governance: source → CI draft → a person's approval → the release
 * service's short-lived authorisation → deployment recorded.
 *
 * - CI (its own agent identity and signing secret) can only draft a release
 *   with its commit, artifact digest, environment and test result.
 * - Approval is publishing the release, by a person holding
 *   `release.production`, who is neither its author nor the agent that drafted it.
 * - The release service (another agent, another secret) holds the production
 *   deploy credential, outside Powerfarm. Before deploying it asks Powerfarm for
 *   an authorisation naming that exact version, commit, digest and environment;
 *   it is valid for 15 minutes and usable once. It then reports what deployed.
 * - No ordinary CI job holds a production credential: that is configuration on
 *   the CI side (docs/IDENTITY.md), checked by the deploy reconciliation.
 */

import type { PluginContext } from "emdash";

import { principalOf, refusal as authorityRefusal } from "./authority.js";
import type { ContentReader } from "./content.js";
import { record } from "./journal.js";

export const RELEASE_SETTINGS = {
	ciClientId: "ciClientId",
	ciSecret: "ciSecret",
	ciAgent: "ciAgent",
	releaseClientId: "releaseClientId",
	releaseSecret: "releaseSecret",
	releaseAgent: "releaseAgent",
} as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{7,64}$/;
const AUTH_MINUTES = 15;

export class ReleaseRefusal extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 409) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

type Ctx = Pick<PluginContext, "kv" | "settings" | "log" | "storage" | "content">;

export function releaseProblems(data: Record<string, unknown>): string[] {
	const out: string[] = [];
	if (!DIGEST.test(String(data.artifact_digest ?? ""))) out.push("Artifact digest must be sha256:<64 hex>.");
	if (!COMMIT.test(String(data.source_revision ?? ""))) out.push("Source revision must be a commit id.");
	if (!["production", "staging"].includes(String(data.environment ?? ""))) out.push("Choose the environment.");
	if (!String(data.repository ?? "").trim()) out.push("Name the repository.");
	return out;
}

/** Publishing a release = approving it. */
export async function releasePublishRefusal(ctx: Ctx, reader: ContentReader, actor: { id: string; role: number; source?: string } | null, content: Record<string, unknown>, data: Record<string, unknown>): Promise<string | null> {
	if (!actor) return "A release is approved by a person.";
	if (actor.source === "mcp") return "AI clients cannot approve releases.";
	const problems = releaseProblems(data);
	if (problems.length) return problems.join(" ");
	const approver = await principalOf(reader, actor.id);
	const author = String(data.author_principal ?? "");
	if (typeof content.authorId === "string" && content.authorId === actor.id) return "The author of a release cannot approve it.";
	if (approver && author && approver.subject === author) return "The author of a release cannot approve it.";
	const denied = await authorityRefusal(ctx as never, reader, { actor, capability: "release.production", scope: `releases:${String(data.environment)}`, what: `approve ${String(data.code ?? "")} ${String(data.artifact_digest ?? "").slice(0, 19)}` });
	if (denied) return denied;
	await ctx.kv.set(`release:approval:${String(content.id)}`, { approverUserId: actor.id, approver: approver?.subject ?? null, at: new Date().toISOString(), digest: data.artifact_digest, commit: data.source_revision, environment: data.environment });
	return null;
}

/** CI drafts a release. Refuses failing tests; the same commit, environment and repository drafts once. */
export async function draftRelease(ctx: Ctx, input: { repository: string; commit: string; artifactDigest: string; environment: "production" | "staging"; version: string; testsPassed: number; testsFailed: number; testSummary?: string }): Promise<{ id: string; created: boolean }> {
	if (input.testsFailed > 0) throw new ReleaseRefusal("TESTS_FAILED", "A release with failing tests is not drafted.");
	const data = { title: `${input.repository} ${input.version} (${input.environment})`, code: input.version, repository: input.repository, source_revision: input.commit.toLowerCase(), artifact_digest: input.artifactDigest.toLowerCase(), environment: input.environment, test_summary: `${input.testsPassed} passed, 0 failed. ${input.testSummary ?? ""}`.trim().slice(0, 2000), author_principal: (await ctx.settings.get<string>(RELEASE_SETTINGS.ciAgent)) ?? "", origin: `ci:${input.repository}@${input.commit.toLowerCase()}:${input.environment}` };
	const problems = releaseProblems(data);
	if (problems.length) throw new ReleaseRefusal("INVALID", problems.join(" "), 400);
	const { getReader } = await import("./runtime.js");
	const reader = await getReader();
	const existing = (await reader.byField("releases", "origin", [data.origin], "draft", 1))[0];
	if (existing) return { id: existing.id, created: false };
	if (!ctx.content?.create) throw new ReleaseRefusal("NOT_AVAILABLE", "content:write is not granted", 500);
	const created = await ctx.content.create("releases", data);
	await record(ctx as never, { type: "release.drafted", stream: "releases", actor: "ci", source: "system", title: `Drafted ${data.title}`, payload: { ...data } });
	return { id: created.id, created: true };
}

/** The release service asks before deploying. Everything must match the approved release. */
export async function authorizeDeploy(ctx: Ctx, reader: ContentReader, input: { version: string; repository: string; commit: string; artifactDigest: string; environment: string }, now = new Date()) {
	const release = (await reader.byField("releases", "code", [input.version], "published", 20)).find((r) => r.data.repository === input.repository && r.data.environment === input.environment);
	if (!release) throw new ReleaseRefusal("NOT_APPROVED", `${input.repository} ${input.version} has no approved ${input.environment} release.`);
	if (release.data.source_revision !== input.commit.toLowerCase()) throw new ReleaseRefusal("COMMIT_MISMATCH", "The commit is not the one that was approved.");
	if (release.data.artifact_digest !== input.artifactDigest.toLowerCase()) throw new ReleaseRefusal("DIGEST_MISMATCH", "The artifact is not the one that was approved.");
	const approval = await ctx.kv.get<{ approver: string | null; approverUserId: string; digest: string }>(`release:approval:${release.id}`);
	if (!approval || approval.digest !== release.data.artifact_digest) throw new ReleaseRefusal("NO_APPROVAL_RECORD", "No approval is recorded for this exact artifact.");
	const id = crypto.randomUUID();
	const expiresAt = new Date(now.getTime() + AUTH_MINUTES * 60_000).toISOString();
	await ctx.kv.set(`release:auth:${id}`, { id, releaseId: release.id, version: input.version, digest: release.data.artifact_digest, environment: input.environment, expiresAt, used: false });
	await record(ctx as never, { type: "release.authorized", stream: "releases", actor: "release-service", source: "system", title: `Deploy of ${input.version} to ${input.environment} authorised until ${expiresAt}`, payload: { authorization: id, approver: approval.approver, ...input } });
	return { authorization: id, expiresAt, approvedBy: approval.approver };
}

export async function recordDeployment(ctx: Ctx, input: { authorization: string; ok: boolean; deployedVersion?: string; detail?: string }, now = new Date()) {
	const auth = await ctx.kv.get<{ id: string; releaseId: string; version: string; environment: string; expiresAt: string; used: boolean }>(`release:auth:${input.authorization}`);
	if (!auth) throw new ReleaseRefusal("UNKNOWN_AUTHORIZATION", "No such authorisation.", 404);
	if (auth.used) throw new ReleaseRefusal("USED", "This authorisation was already used.");
	if (now.getTime() > Date.parse(auth.expiresAt)) throw new ReleaseRefusal("EXPIRED", "The authorisation expired before the deployment was reported; deploy again with a new one.");
	await ctx.kv.set(`release:auth:${input.authorization}`, { ...auth, used: true });
	await ctx.kv.set(`release:deployed:${auth.environment}`, { version: auth.version, releaseId: auth.releaseId, at: now.toISOString(), ok: input.ok, deployedVersion: input.deployedVersion ?? null });
	await record(ctx as never, { type: input.ok ? "release.deployed" : "release.deploy_failed", stream: "releases", actor: "release-service", source: "system", title: `${auth.version} ${input.ok ? "deployed to" : "failed to deploy to"} ${auth.environment}`, payload: { ...input, releaseId: auth.releaseId } });
	return { recorded: true };
}
