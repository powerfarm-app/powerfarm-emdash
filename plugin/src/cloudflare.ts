/**
 * Cloudflare Access, from the inside:
 *
 * - `verifyAccessAssertion`: checks the `Cf-Access-Jwt-Assertion` header that
 *   Access adds to every request it lets through (issuer = the team domain,
 *   audience = one of the configured application AUD tags, expiry, signature
 *   against the team's published keys). Used by `identity/whoami-access`, so a
 *   Free Zone service can learn who its caller is without its own user store.
 * - `accessLogsTask`: reads Access authentication logs into incidents —
 *   refused sign-ins and sign-ins from a country not seen before for that user.
 */

import { verifyJwt, JwtError } from "./jwt.js";
import { raiseIncident } from "./mdm/vigilance.js";

export const CF_SETTINGS = { teamDomain: "accessTeamDomain", audiences: "accessAudiences", accountId: "cloudflareAccountId", apiToken: "cloudflareLogsToken" } as const;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
type Ctx = {
	settings: { get<T>(k: string): Promise<T | null> };
	kv: { get<T>(k: string): Promise<T | null>; set(k: string, v: unknown): Promise<void> };
	http?: { fetch: Fetch };
	log: { warn(m: string, d?: unknown): void };
};

const fetcher = (ctx: Ctx): Fetch => ctx.http?.fetch.bind(ctx.http) ?? ((u, i) => fetch(u, i));

export async function verifyAccessAssertion(ctx: Ctx, token: string | null, now = Math.floor(Date.now() / 1000)): Promise<{ email: string; sub: string; principalId: string | null; payload: Record<string, unknown> }> {
	if (!token) throw new JwtError("No Access assertion");
	const team = ((await ctx.settings.get<string>(CF_SETTINGS.teamDomain)) ?? "").trim().replace(/^https:\/\//, "").replace(/\/$/, "");
	const audiences = ((await ctx.settings.get<string>(CF_SETTINGS.audiences)) ?? "").split(/[\s,]+/).filter(Boolean);
	if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || audiences.length === 0) throw new JwtError("Access team domain and application audiences are not configured");
	const cacheKey = `access:certs:${team}`;
	let cached = await ctx.kv.get<{ at: number; keys: JsonWebKey[] }>(cacheKey);
	if (!cached || now - cached.at > 3600) {
		const res = await fetcher(ctx)(`https://${team}/cdn-cgi/access/certs`);
		if (!res.ok) throw new JwtError(`Could not read Access keys (${res.status})`);
		const body = (await res.json()) as { keys?: JsonWebKey[] };
		cached = { at: now, keys: body.keys ?? [] };
		await ctx.kv.set(cacheKey, cached);
	}
	const payload = await verifyJwt(token, cached.keys, { issuer: `https://${team}`, audiences, now });
	if (typeof payload.email !== "string" || typeof payload.sub !== "string") throw new JwtError("Assertion without a user (a service token)");
	// The person, by Powerfarm's permanent id: Cloudflare copies the ID token's custom claim
	// pf_principal_id into oidc_fields when the Access IdP is configured with it
	// (docs/IDENTITY.md §5.2). Absent = this login did not come through Powerfarm.
	const fields = payload.oidc_fields;
	const raw = fields && typeof fields === "object" && !Array.isArray(fields) ? (fields as Record<string, unknown>).pf_principal_id : undefined;
	const principalId = typeof raw === "string" && raw.length > 0 ? raw : null;
	return { email: payload.email.toLowerCase(), sub: payload.sub, principalId, payload };
}

interface AccessLogRow {
	user_email?: string;
	allowed?: boolean;
	action?: string;
	country?: string;
	ip_address?: string;
	app_domain?: string;
	created_at?: string;
	ray_id?: string;
}

/** The `access-logs` task: refused sign-ins and new countries become incidents. */
export async function accessLogsTask(ctx: Ctx, now = new Date()): Promise<Record<string, number>> {
	const account = await ctx.settings.get<string>(CF_SETTINGS.accountId);
	const token = await ctx.settings.get<string>(CF_SETTINGS.apiToken);
	if (!account || !token) return { skipped: 1 };
	const since = (await ctx.kv.get<string>("access-logs:since")) ?? new Date(now.getTime() - 3_600_000).toISOString();
	const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/access/logs/access_requests?since=${encodeURIComponent(since)}&limit=1000&direction=asc`;
	const res = await fetcher(ctx)(url, { headers: { authorization: `Bearer ${token}` } });
	if (!res.ok) {
		ctx.log.warn("Access logs could not be read", { status: res.status });
		return { error: res.status };
	}
	const rows = (((await res.json()) as { result?: AccessLogRow[] }).result ?? []).filter((r) => r.user_email && r.created_at);
	let refused = 0;
	let newCountry = 0;
	// Compare as times, not strings (Cloudflare may or may not send milliseconds).
	let latest = Date.parse(since);
	for (const r of rows) {
		const email = r.user_email!.toLowerCase();
		const at = Date.parse(r.created_at!);
		if (Number.isFinite(at) && at > latest) latest = at;
		if (r.allowed === false) {
			// oxlint-disable-next-line no-await-in-loop -- one incident per user, repeats counted
			await raiseIncident(ctx as never, { rule: "access_refused", severity: "medium", assetTag: null, udid: `access:${email}`, at: new Date(r.created_at!), detail: `Cloudflare Access refused ${email} on ${r.app_domain ?? "an application"} from ${r.ip_address ?? "?"} (${r.country ?? "?"}), ray ${r.ray_id ?? "?"}.` });
			refused++;
			continue;
		}
		if (r.country) {
			const key = `access-logs:countries:${email}`;
			// oxlint-disable-next-line no-await-in-loop
			const seen = (await ctx.kv.get<string[]>(key)) ?? [];
			if (!seen.includes(r.country)) {
				if (seen.length > 0) {
					// oxlint-disable-next-line no-await-in-loop
					await raiseIncident(ctx as never, { rule: "access_new_country", severity: "medium", assetTag: null, udid: `access:${email}`, at: new Date(r.created_at!), detail: `${email} signed in through Access from ${r.country} for the first time (before: ${seen.join(", ")}), IP ${r.ip_address ?? "?"}. Confirm with them through another channel.` });
					newCountry++;
				}
				// oxlint-disable-next-line no-await-in-loop
				await ctx.kv.set(key, [...seen, r.country].slice(-20));
			}
		}
	}
	// `since` is inclusive: start just after the last row read, so it is not counted twice.
	await ctx.kv.set("access-logs:since", new Date(latest + (rows.length ? 1 : 0)).toISOString());
	return { read: rows.length, refused, newCountry };
}
