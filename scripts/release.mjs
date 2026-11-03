#!/usr/bin/env node
// Powerfarm's release gate, from the two machines that touch a release.
//
//   CI (its own id and secret; can only draft):
//     node scripts/release.mjs draft --url https://powerfarm.example.org \
//       --artifact dist/site.tgz --repo powerfarm --commit "$GIT_SHA" --version 1.4.0 \
//       --env production --tests-passed 178 --tests-failed 0
//
//   Release service (another id and secret; deploys only what a person approved):
//     node scripts/release.mjs deploy --url https://powerfarm.example.org \
//       --artifact dist/site.tgz --repo powerfarm --commit "$GIT_SHA" --version 1.4.0 \
//       --env production -- pnpm --filter site run cf:deploy
//
// Between the two, a person who did not author the release and holds
// release.production publishes the draft in EmDash (Content → Releases). That
// publish is the approval; nothing here can make it.
//
// `deploy` hashes the artifact itself, asks Powerfarm for a one-time
// authorisation for exactly that digest and commit, runs the command after
// `--` without a shell, and reports the outcome with the authorisation.
//
// Credentials come from files or the environment, never arguments:
//   POWERFARM_RELEASE_ID / POWERFARM_RELEASE_SECRET_FILE (or _SECRET)
//   POWERFARM_ACCESS_CLIENT_ID / POWERFARM_ACCESS_CLIENT_SECRET (Cloudflare Access service token)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { signRequest } from "../mac/bridge/src/sign.mjs";

const ROUTE_BASE = "/_emdash/api/plugins/powerfarm/";

export function digestOf(file) {
	return `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
}

/** POST a signed JSON body to a Powerfarm release route. */
export async function signedPost({ url, route, body, id, secret, access, fetchImpl = fetch }) {
	const text = JSON.stringify(body);
	const headers = { "content-type": "application/json", ...signRequest({ bridgeId: id, secret, route: `powerfarm/${route}`, body: text }) };
	if (access?.clientId) Object.assign(headers, { "cf-access-client-id": access.clientId, "cf-access-client-secret": access.clientSecret });
	const base = url.replace(/\/+$/, "");
	if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw new Error("Use the https:// address");
	const res = await fetchImpl(`${base}${ROUTE_BASE}${route}`, { method: "POST", headers, body: text, redirect: "manual" });
	const raw = await res.text();
	let json = null;
	try {
		json = JSON.parse(raw);
	} catch {
		// not JSON: Access or something else answered
	}
	if (res.status >= 300 && res.status < 400) throw new Error(`HTTP ${res.status}: stopped by Cloudflare Access (check the service token)`);
	if (!res.ok || !json) throw new Error(`HTTP ${res.status}: ${json?.error?.code ?? ""} ${json?.error?.message ?? raw.slice(0, 200)}`.trim());
	return json.data ?? json;
}

export async function draft(opts) {
	return signedPost({ ...opts, route: "release/draft", body: { repository: opts.repo, commit: opts.commit, artifactDigest: digestOf(opts.artifact), environment: opts.env, version: opts.version, testsPassed: Number(opts.testsPassed), testsFailed: Number(opts.testsFailed), ...(opts.testSummary ? { testSummary: opts.testSummary } : {}) } });
}

/** Authorise, run the command (argv array, no shell), report. Returns the outcome. */
export async function deploy(opts, command, run = (cmd) => spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", shell: false })) {
	if (!command.length) throw new Error("Give the deploy command after --");
	const digest = digestOf(opts.artifact);
	const auth = await signedPost({ ...opts, route: "release/authorize", body: { version: opts.version, repository: opts.repo, commit: opts.commit, artifactDigest: digest, environment: opts.env } });
	console.log(`Authorised by Powerfarm until ${auth.expiresAt} (approved by ${auth.approvedBy ?? "?"}).`);
	// The artifact is hashed again right before running: it must not change in between.
	if (digestOf(opts.artifact) !== digest) throw new Error("The artifact changed after authorisation; not deploying");
	const r = run(command);
	const ok = r.status === 0;
	await signedPost({ ...opts, route: "release/deployed", body: { authorization: auth.authorization, ok, deployedVersion: opts.version, detail: ok ? "" : `exit ${r.status ?? r.signal ?? "?"}` } });
	return { ok, authorization: auth.authorization };
}

function parse(argv) {
	const dash = argv.indexOf("--");
	const own = dash >= 0 ? argv.slice(0, dash) : argv;
	const opts = {};
	for (let i = 1; i < own.length; i++) {
		const m = /^--([a-z-]+)$/.exec(own[i]);
		if (m) opts[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = own[++i];
	}
	return { cmd: own[0], opts, command: dash >= 0 ? argv.slice(dash + 1) : [] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const { cmd, opts, command } = parse(process.argv.slice(2));
	const env = process.env;
	const secret = (env.POWERFARM_RELEASE_SECRET ?? (env.POWERFARM_RELEASE_SECRET_FILE ? readFileSync(env.POWERFARM_RELEASE_SECRET_FILE, "utf8") : "")).trim();
	const id = env.POWERFARM_RELEASE_ID;
	const access = env.POWERFARM_ACCESS_CLIENT_ID ? { clientId: env.POWERFARM_ACCESS_CLIENT_ID, clientSecret: (env.POWERFARM_ACCESS_CLIENT_SECRET ?? "").trim() } : null;
	const need = ["url", "artifact", "repo", "commit", "version", "env"];
	if (!["draft", "deploy"].includes(cmd) || need.some((k) => !opts[k]) || !id || secret.length < 32) {
		console.error("Usage: release.mjs draft|deploy --url <https://…> --artifact <file> --repo <name> --commit <sha> --version <v> --env production|staging [--tests-passed N --tests-failed N] [-- <deploy command>]\nSet POWERFARM_RELEASE_ID and POWERFARM_RELEASE_SECRET_FILE.");
		process.exit(2);
	}
	try {
		if (cmd === "draft") console.log(JSON.stringify(await draft({ ...opts, id, secret, access })));
		else {
			const r = await deploy({ ...opts, id, secret, access }, command);
			console.log(r.ok ? "Deployed and reported." : "Deploy command failed; reported as failed.");
			process.exit(r.ok ? 0 : 1);
		}
	} catch (e) {
		console.error(e.message);
		process.exit(1);
	}
}
