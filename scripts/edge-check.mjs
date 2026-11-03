#!/usr/bin/env node
// Prove, from outside, that Powerfarm on Cloudflare is reachable only through
// Cloudflare Access. Run it after every deploy and after any Access change.
//
//   node scripts/edge-check.mjs --url https://powerfarm.example.com \
//     [--workers-dev https://powerfarm.<account>.workers.dev] \
//     [--r2-dev https://pub-<id>.r2.dev] \
//     [--access-id <service token id> --access-secret-file <file>] [--mdm] [--oidc]
//
// Without credentials every request must be stopped at the edge (a redirect to
// the Access login, or 403) and never answered by EmDash. With the bridge's
// service token, a bridge route must reach EmDash and be refused there for its
// missing signature: that proves both layers. Prints PASS/FAIL; exits 1 on any FAIL.
import { readFileSync } from "node:fs";

/** Classify one response. `edge`: stopped by Cloudflare Access; `emdash`: answered by the Worker. */
export function classify(status, headers, body) {
	const location = headers.get?.("location") ?? headers.location ?? "";
	if (status >= 300 && status < 400 && /cloudflareaccess\.com|\/cdn-cgi\/access\//.test(location)) return "edge";
	const json = /^\s*[{[]/.test(body);
	if ((status === 401 || status === 403) && !json) return "edge";
	if (json) return "emdash";
	return status >= 200 && status < 300 ? "open" : "other";
}

export async function edgeCheck({ url, workersDev, r2Dev, access, mdm = false, oidc = false, fetchImpl = fetch }) {
	const base = url.replace(/\/+$/, "");
	const results = [];
	const check = async (name, fn) => {
		try {
			results.push(["PASS", name, (await fn()) ?? ""]);
		} catch (e) {
			results.push(["FAIL", name, e.message]);
		}
	};
	const get = async (target, init = {}) => {
		const res = await fetchImpl(target, { redirect: "manual", ...init });
		const body = await res.text().catch(() => "");
		return { status: res.status, kind: classify(res.status, res.headers, body), body };
	};
	const mustBeStopped = (r) => {
		if (r.kind !== "edge") throw new Error(`HTTP ${r.status} answered ${r.kind === "emdash" ? "by EmDash" : "without Access"}: Access is not in front of this path`);
		return `stopped by Access (HTTP ${r.status})`;
	};

	await check("https only", () => {
		if (!base.startsWith("https://")) throw new Error("use the https:// address");
	});
	for (const p of ["/_emdash/admin", "/_emdash/api/health", "/_emdash/api/mcp", "/_emdash/api/media/file/x.png", "/"]) {
		await check(`without credentials: GET ${p}`, async () => mustBeStopped(await get(`${base}${p}`)));
	}
	await check("without credentials: POST bridge/claim", async () => mustBeStopped(await get(`${base}/_emdash/api/plugins/powerfarm/bridge/claim`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })));
	await check("a forged Access header does not get through", async () => mustBeStopped(await get(`${base}/_emdash/api/health`, { headers: { "cf-access-jwt-assertion": "forged.jwt.value", "cf-access-client-id": "not-a-token.access", "cf-access-client-secret": "nope" } })));

	if (mdm) {
		await check("MDM device path: reachable without Access (Bypass), and refused by EmDash without a device signature", async () => {
			const r = await get(`${base}/_emdash/api/plugins/powerfarm/mdm/checkin`, { method: "PUT", headers: { "content-type": "application/x-apple-aspen-mdm-checkin" }, body: "<plist/>" });
			if (r.kind === "edge" && !/^(UNSIGNED|MDM_DISABLED|NOT_CONFIGURED)$/.test(r.body.trim())) throw new Error(`HTTP ${r.status} from Access: add an Access application for this path with a Bypass policy, or devices cannot check in`);
			if (r.status < 400) throw new Error(`HTTP ${r.status}: an unsigned device message was accepted`);
			return `EmDash answered ${r.status} ${r.body.trim().slice(0, 20)}`;
		});
		await check("MDM posture path: stopped by Access without the posture service token", async () => mustBeStopped(await get(`${base}/_emdash/api/plugins/powerfarm/posture/score`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"devices":[]}' })));
	}
	if (oidc) {
		// Powerfarm is the identity provider Access trusts, so its sign-in path must be open
		// to browsers before they have an Access session (Bypass), and nothing else.
		const P = `${base}/_emdash/api/plugins/powerfarm`;
		await check("OIDC keys: reachable without Access (Bypass) and served by EmDash", async () => {
			const r = await get(`${P}/oidc/jwks`);
			if (r.kind !== "emdash") throw new Error(`HTTP ${r.status}: Access must Bypass ${"/_emdash/api/plugins/powerfarm/oidc/"} or Cloudflare cannot read the signing keys (sign-in loop)`);
			if (/"d"\s*:/.test(r.body)) throw new Error("the key set contains a private key component");
			return `HTTP ${r.status}`;
		});
		await check("OIDC token endpoint: reachable, and refuses an unauthenticated client", async () => {
			const r = await get(`${P}/oidc/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=authorization_code&code=x" });
			if (r.kind === "edge") throw new Error(`HTTP ${r.status} from Access: Bypass the oidc/ path`);
			if (r.status < 400) throw new Error(`HTTP ${r.status}: a token request without client credentials was accepted`);
			return `EmDash answered ${r.status}`;
		});
		await check("sign-in page /oidc/continue: reachable without Access", async () => {
			const r = await get(`${base}/oidc/continue`);
			if (r.kind === "edge") throw new Error(`HTTP ${r.status} from Access: Bypass /oidc/continue`);
			return `HTTP ${r.status}`;
		});
		await check("EmDash sign-in page: reachable without Access", async () => {
			const r = await get(`${base}/_emdash/admin/login`);
			if (r.kind === "edge") throw new Error(`HTTP ${r.status} from Access: Bypass EmDash's sign-in page, its assets and /_emdash/api/auth/ (docs/IDENTITY.md)`);
			return `HTTP ${r.status}`;
		});
		await check("the rest of Powerfarm Identity is still behind Access", async () => mustBeStopped(await get(`${P}/identity/whoami`)));
	}
	if (access) {
		const headers = { "cf-access-client-id": access.clientId, "cf-access-client-secret": access.clientSecret, "content-type": "application/json" };
		await check("with the bridge service token: bridge/claim reaches EmDash and is refused for its missing signature", async () => {
			const r = await get(`${base}/_emdash/api/plugins/powerfarm/bridge/claim`, { method: "POST", headers, body: "{}" });
			if (r.kind !== "emdash") throw new Error(`HTTP ${r.status}: the token did not get through Access (check the policy and that the token is allowed on this path)`);
			if (r.status < 400) throw new Error(`HTTP ${r.status}: an unsigned bridge request was accepted`);
			return `EmDash answered ${r.status}`;
		});
		await check("with the service token: EmDash still requires its own sign-in for content", async () => {
			const r = await get(`${base}/_emdash/api/content/clients`, { headers });
			if (r.kind === "edge") return `stopped by Access (HTTP ${r.status}): the token is limited to the bridge path, as recommended`;
			if (r.status !== 401 && r.status !== 403) throw new Error(`HTTP ${r.status}: content was served without an EmDash session or API token`);
			return `EmDash answered ${r.status}`;
		});
	}
	if (workersDev) {
		await check("the workers.dev address is off", async () => {
			const r = await get(`${workersDev.replace(/\/+$/, "")}/_emdash/api/health`).catch((e) => ({ status: 0, kind: "unreachable", body: e.message }));
			if (r.kind === "emdash" || r.kind === "open") throw new Error(`HTTP ${r.status}: the Worker answers on workers.dev, which bypasses Access. Set "workers_dev": false and redeploy.`);
			return r.status ? `HTTP ${r.status}, not the Worker` : "unreachable";
		});
	}
	if (r2Dev) {
		await check("the media bucket has no public address", async () => {
			const r = await get(`${r2Dev.replace(/\/+$/, "")}/`).catch((e) => ({ status: 0, kind: "unreachable", body: e.message }));
			if (r.status >= 200 && r.status < 300) throw new Error(`HTTP ${r.status}: the bucket is public. Disable r2.dev access on it.`);
			return r.status ? `HTTP ${r.status}` : "unreachable";
		});
	}
	return results;
}

function arg(name) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const url = arg("url");
	if (!url) {
		console.error("Usage: node scripts/edge-check.mjs --url https://<host> [--workers-dev <url>] [--r2-dev <url>] [--access-id <id> --access-secret-file <file>]");
		process.exit(2);
	}
	const id = arg("access-id");
	const secretFile = arg("access-secret-file");
	const access = id ? { clientId: id, clientSecret: (process.env.POWERFARM_ACCESS_CLIENT_SECRET ?? (secretFile ? readFileSync(secretFile, "utf8") : "")).trim() } : null;
	const results = await edgeCheck({ url, workersDev: arg("workers-dev"), r2Dev: arg("r2-dev"), access, mdm: process.argv.includes("--mdm"), oidc: process.argv.includes("--oidc") });
	for (const [status, name, detail] of results) console.log(`${status}  ${name}${detail ? ` — ${detail}` : ""}`);
	process.exit(results.some(([s]) => s === "FAIL") ? 1 : 0);
}
