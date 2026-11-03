/**
 * Powerfarm plugin for EmDash (trusted, native).
 *
 * Native because the graph reads EmDash's relation tables and draft revisions,
 * which the plugin context does not expose (emdash-port.ts is the only place that
 * does), and because the admin integration uses React panels and list columns.
 *
 * Register it in astro.config.mjs:  emdash({ plugins: [powerfarm()] })
 */

import type { PluginCapability, PluginDescriptor, ResolvedPlugin, SettingField } from "emdash";
import { definePlugin } from "emdash";

import { AUTHORITY_SETTING, CAPABILITIES as AUTHORITY_CAPABILITIES } from "./authority.js";
import { bridgeRoutes } from "./bridge.js";
import { CF_SETTINGS } from "./cloudflare.js";
import { identityRoutes } from "./identity-routes.js";
import { OIDC_SETTINGS } from "./oidc.js";
import { RELEASE_SETTINGS } from "./release.js";
import { MDM_DEFAULTS, MDM_SETTINGS, MDM_STORAGE } from "./mdm/model.js";
import { mdmRoutes } from "./mdm/routes.js";
import { STORAGE } from "./jobs.js";
import { DEFAULTS, PLUGIN_ID, PLUGIN_VERSION, ROLE, SETTINGS } from "./model.js";
import { afterChange, afterPublish, afterUnpublish, beforeDelete, beforePublish, beforeSave, beforeSchedule, beforeUnpublish } from "./policy.js";
import { runTask, TASKS } from "./reconcile.js";
import { apiRoutes, mcpTools } from "./routes.js";

const ENTRY = "@powerfarm/emdash-plugin";
const ADMIN_ENTRY = "@powerfarm/emdash-plugin/admin";

const CAPABILITIES: PluginCapability[] = [
	"content:read",
	"content:revisions:read",
	"content:write",
	"content:publish",
	"schema:read",
	"hooks.content-policy:register",
	"media:read",
	"media:bytes:read",
	"media:write",
	// 1.3: incident alerts through whatever e-mail provider EmDash has configured (none: alerts stay in the admin).
	"email:send",
	// 1.4: Cloudflare Access signing keys and logs only (ALLOWED_HOSTS).
	"network:request",
];

/** The only hosts Powerfarm's Worker code may call. */
const ALLOWED_HOSTS = ["api.cloudflare.com", "*.cloudflareaccess.com"];

const ADMIN_PAGES = [
	{ path: "/recovery", label: "Recovery", icon: "first-aid-kit", group: "Powerfarm" },
	{ path: "/graph", label: "Graph", icon: "graph", group: "Powerfarm" },
	{ path: "/engineering", label: "Engineering", icon: "code", group: "Powerfarm" },
	{ path: "/audit", label: "Audit and health", icon: "shield-check", group: "Powerfarm" },
];

const ADMIN_WIDGETS = [
	{ id: "mission", title: "Mission 001", size: "half" as const },
	{ id: "physical", title: "Waiting for physical action", size: "half" as const },
	{ id: "attention", title: "Needs inspection or blocked", size: "half" as const },
	{ id: "approvals", title: "Operations awaiting approval", size: "half" as const },
	{ id: "bridge", title: "Apple Hardware Bridge", size: "half" as const },
	{ id: "evidence", title: "Evidence and audit", size: "half" as const },
	{ id: "events", title: "Recent operational events", size: "full" as const },
	{ id: "entities", title: "Entities and onboarding", size: "half" as const },
	{ id: "work", title: "Open work and approvals", size: "half" as const },
	{ id: "devices", title: "Managed devices and incidents", size: "full" as const },
];

const SETTINGS_SCHEMA: Record<string, SettingField> = {
	// ---- 1.4 Powerfarm Identity (docs/IDENTITY.md) ----
	[AUTHORITY_SETTING]: {
		type: "string",
		label: "Authority: enforced capabilities",
		description: `Comma-separated. Listed capabilities are default-deny: only a published, current grant allows them. Others are checked and journalled (would_deny) but not enforced. Known: ${Object.keys(AUTHORITY_CAPABILITIES).join(", ")}.`,
	},
	[OIDC_SETTINGS.signingKey]: { type: "secret", label: "OIDC: signing key", description: "Written by identity/oidc/rotate-key. Do not paste a key here." },
	[OIDC_SETTINGS.previousKey]: { type: "secret", label: "OIDC: previous signing key", description: "Kept in the published key set after a rotation, so tokens signed just before still verify." },
	[CF_SETTINGS.teamDomain]: { type: "string", label: "Cloudflare Access: team domain", description: "For example yourteam.cloudflareaccess.com." },
	[CF_SETTINGS.audiences]: { type: "string", label: "Cloudflare Access: application audiences", description: "Comma-separated AUD tags of the Access applications whose assertions identity/whoami-access accepts." },
	[CF_SETTINGS.accountId]: { type: "string", label: "Cloudflare: account ID", description: "For the access-logs task." },
	[CF_SETTINGS.apiToken]: { type: "secret", label: "Cloudflare: Access audit logs token", description: "An API token with only Account › Access: Audit Logs › Read." },
	[RELEASE_SETTINGS.ciClientId]: { type: "string", label: "Release: CI client ID", description: "The id CI signs release drafts with." },
	[RELEASE_SETTINGS.ciSecret]: { type: "secret", label: "Release: CI signing secret", description: "openssl rand -hex 32. CI can only draft releases, never approve them." },
	[RELEASE_SETTINGS.ciAgent]: { type: "string", label: "Release: CI agent", description: "The agents record CI acts as, for example agents:AG-0002." },
	[RELEASE_SETTINGS.releaseClientId]: { type: "string", label: "Release: release service client ID" },
	[RELEASE_SETTINGS.releaseSecret]: { type: "secret", label: "Release: release service signing secret", description: "A different secret from CI's. The release service only deploys what a person approved." },
	[RELEASE_SETTINGS.releaseAgent]: { type: "string", label: "Release: release service agent", description: "For example agents:AG-0003." },
	// ---- 1.3 Powerfarm MDM (docs/MDM.md) ----
	[MDM_SETTINGS.enabled]: { type: "boolean", label: "MDM: accept device check-ins", description: "Off by default. Turn off to stop all MDM traffic at once.", default: false },
	[MDM_SETTINGS.topic]: { type: "string", label: "MDM: push topic", description: "The UID of your MDM push certificate (com.apple.mgmt.External.…). Devices with another topic are refused." },
	[MDM_SETTINGS.caCertificate]: { type: "string", label: "MDM: device CA certificate (PEM)", description: "The public certificate printed by `powerfarm-bridge mdm-ca init` on the lab Mac. Only devices with identities from this CA are accepted. The CA's private key never leaves the Mac." },
	[MDM_SETTINGS.staleHours]: { type: "number", label: "MDM: hours without check-in before an incident", min: 1, max: 168, default: MDM_DEFAULTS.staleHours },
	[MDM_SETTINGS.queryEveryHours]: { type: "number", label: "MDM: hours between device reports", min: 1, max: 48, default: MDM_DEFAULTS.queryEveryHours },
	[MDM_SETTINGS.alertEmail]: { type: "string", label: "MDM: alert e-mail", description: "Where high and critical incidents are e-mailed, if EmDash has an e-mail provider. Use an address on a device and account you trust." },
	[SETTINGS.bridgeEnabled]: { type: "boolean", label: "Accept bridge requests", description: "Turn off to revoke the bridge immediately.", default: DEFAULTS.bridgeEnabled },
	[SETTINGS.bridgeId]: { type: "string", label: "Bridge ID", description: "Identifier the bridge sends, for example lab-512-bridge." },
	[SETTINGS.bridgeSecret]: { type: "secret", label: "Bridge signing secret", description: "At least 32 random bytes: openssl rand -hex 32. Encrypted with EMDASH_ENCRYPTION_KEY." },
	[SETTINGS.bridgeSecretNext]: {
		type: "secret",
		label: "Next bridge secret (rotation)",
		description: "Set this, update the bridge, then move it into the signing secret and clear this field.",
	},
	bridgeAllowedAddresses: {
		type: "string",
		label: "Bridge source addresses",
		description: "Optional comma-separated IPs. When set, requests from any other or unknown address are refused. On Cloudflare this is the lab's public address as Cloudflare sees it (CF-Connecting-IP); leave it empty if the lab's address changes. Self-hosted behind a proxy: needs EmDash's trusted proxy header.",
	},
	[SETTINGS.hostAssetTag]: { type: "string", label: "Trusted host asset tag", description: "The bridge never operates on this asset.", default: DEFAULTS.hostAssetTag },
	[SETTINGS.requireSecondPerson]: {
		type: "boolean",
		label: "Require a second person to approve",
		description: "When on, an operation's author cannot approve it, and an unknown author blocks approval.",
		default: DEFAULTS.requireSecondPerson,
	},
	[SETTINGS.destructiveMinRole]: {
		type: "select",
		label: "Who can approve destructive operations",
		options: [
			{ value: String(ROLE.ADMIN), label: "Administrators" },
			{ value: String(ROLE.EDITOR), label: "Editors and administrators" },
		],
		default: String(DEFAULTS.destructiveMinRole),
	},
	[SETTINGS.claimLeaseMinutes]: { type: "number", label: "Bridge lease (minutes)", min: 5, max: 240, default: DEFAULTS.claimLeaseMinutes },
	[SETTINGS.maxArtifactMegabytes]: { type: "number", label: "Largest evidence upload (MiB)", min: 1, max: 8, default: DEFAULTS.maxArtifactMegabytes },
	[SETTINGS.tokenMaxClassification]: {
		type: "select",
		label: "Highest classification API tokens and AI clients may read",
		description: "Applies to Powerfarm's routes and MCP tools. Give AI tokens only the mcp:tools:powerfarm scope so EmDash's own content tools cannot bypass this.",
		options: [
			{ value: "public", label: "Public" },
			{ value: "internal", label: "Internal (default)" },
			{ value: "confidential", label: "Confidential" },
		],
		default: DEFAULTS.tokenMaxClassification,
	},
};

export function powerfarm(): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		format: "native",
		entrypoint: ENTRY,
		options: {},
		capabilities: CAPABILITIES,
		allowedHosts: ALLOWED_HOSTS,
		adminEntry: ADMIN_ENTRY,
		adminPages: ADMIN_PAGES,
		adminWidgets: ADMIN_WIDGETS,
		// Storage is declared at runtime in definePlugin(): the descriptor form accepts only
		// single-field indexes, and these collections use composite ones.
	};
}

export function createPlugin(): ResolvedPlugin {
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		capabilities: CAPABILITIES,
		allowedHosts: ALLOWED_HOSTS,
		storage: { ...STORAGE, ...MDM_STORAGE },
		admin: { entry: ADMIN_ENTRY, pages: ADMIN_PAGES, widgets: ADMIN_WIDGETS, settingsSchema: SETTINGS_SCHEMA },
		hooks: {
			"plugin:activate": async (_event, ctx) => {
				for (const [name, schedule] of Object.entries(TASKS)) {
					// oxlint-disable-next-line no-await-in-loop -- a dozen tasks
					await ctx.cron?.schedule(name, { schedule });
				}
			},
			cron: { timeout: 60_000, errorPolicy: "continue", handler: async (event, ctx) => runTask(ctx, event.name) },
			"content:beforeSave": { priority: 10, timeout: 20_000, errorPolicy: "abort", handler: beforeSave },
			"content:afterSave": { errorPolicy: "continue", handler: afterChange },
			"content:beforeDelete": { priority: 10, errorPolicy: "abort", handler: beforeDelete },
			"content:afterDelete": { errorPolicy: "continue", handler: afterChange },
			"content:beforePublish": { priority: 10, timeout: 15_000, errorPolicy: "abort", handler: beforePublish },
			"content:beforeSchedule": { priority: 10, errorPolicy: "abort", handler: beforeSchedule },
			"content:beforeUnpublish": { priority: 10, errorPolicy: "abort", handler: beforeUnpublish },
			"content:afterPublish": { errorPolicy: "continue", timeout: 20_000, handler: afterPublish },
			"content:afterUnpublish": { errorPolicy: "continue", timeout: 20_000, handler: afterUnpublish },
		},
		routes: { ...apiRoutes(), ...bridgeRoutes(), ...mdmRoutes(), ...identityRoutes() },
		mcp: { tools: mcpTools() },
	});
}

export default createPlugin;
