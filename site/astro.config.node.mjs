// Powerfarm on EmDash, self-hosted Node.js variant (a VM with SQLite).
// Not the primary deployment since 1.2.2 — that is Cloudflare (astro.config.mjs,
// docs/DEPLOYMENT-CLOUDFLARE.md). Kept for local development and as a fallback.
// Build with: pnpm build:node. Never exposed to the internet (docs/DEPLOYMENT.md). A public site comes
// later, through an explicit publication allowlist (docs/PUBLICATION.md).
import node from "@astrojs/node";
import react from "@astrojs/react";
import auditLog from "@emdash-cms/plugin-audit-log";
import { powerfarm } from "@powerfarm/emdash-plugin";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { postgres, sqlite } from "emdash/db";

import { powerfarmPaths } from "./powerfarm.paths.mjs";
import * as brand from "./brand.mjs";

const paths = powerfarmPaths();
const siteUrl = process.env.EMDASH_SITE_URL;

if (paths.databaseUrl) {
	console.warn(
		"[powerfarm] DATABASE_URL is set: using PostgreSQL. EmDash's full-text search (FTS5) is SQLite-only, so graph and knowledge search fall back to exact key matching. SQLite is the supported choice for Mission 001.",
	);
}
if (process.env.EMDASH_PRIVATE_MEDIA !== "1") {
	console.warn("[powerfarm] EMDASH_PRIVATE_MEDIA is not 1: media files (including evidence) are served without authentication. Apply upstream/patches/0001 and set it.");
}

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	server: {
		// Loopback by default. Set HOST to the VM's private address so the bridge on the Mac host can reach it.
		host: process.env.HOST ?? "127.0.0.1",
		port: Number(process.env.PORT ?? 4321),
	},
	security: siteUrl ? { allowedDomains: [{ hostname: new URL(siteUrl).hostname }] } : undefined,
	image: { layout: "constrained", responsiveStyles: true },
	integrations: [
		react(),
		emdash({
			database: paths.databaseUrl ? postgres({ connectionString: paths.databaseUrl }) : sqlite({ url: `file:${paths.database}` }),
			storage: local({ directory: paths.uploads, baseUrl: "/_emdash/api/media/file" }),
			siteUrl,
			// Trusted, in-process plugins only. No sandboxRunner is configured, so nothing can be
			// installed from the plugin registry at runtime.
			plugins: [powerfarm(), auditLog],
			// Powerfarm's name, logo and font in the admin (brand.mjs, docs/BRAND.md).
			admin: brand.admin,
			fonts: false,
		}),
	],
	fonts: brand.fonts,
	devToolbar: { enabled: false },
});
