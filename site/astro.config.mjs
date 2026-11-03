// Powerfarm on EmDash, on Cloudflare: Workers for the site, D1 for the database,
// R2 for media and evidence, the Worker's cron for plugin tasks.
//
// The whole hostname is private: Cloudflare Access sits in front of it (people
// sign in through Access, then with their EmDash passkey; the bridge and test
// clients use Access service tokens). No page is public during Mission 001
// (docs/PUBLICATION.md), so nothing is cached at the edge.
//
// Compute stays on the lab Macs: the bridge pulls approved jobs from this
// Worker and reports back (docs/DEPLOYMENT-CLOUDFLARE.md).
//
// The self-hosted Node/SQLite variant is astro.config.node.mjs.
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import auditLog from "@emdash-cms/plugin-audit-log";
import { powerfarm } from "@powerfarm/emdash-plugin";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	image: { layout: "constrained", responsiveStyles: true },
	integrations: [
		react(),
		emdash({
			// Binding names must match wrangler.jsonc. Do not enable D1 read replication:
			// Powerfarm's registry and onboarding read what they just wrote.
			database: d1({ binding: "DB", session: "auto" }),
			// No publicUrl: every file, including evidence, goes through EmDash's
			// authenticated media route (patch 0001 with EMDASH_PRIVATE_MEDIA=1).
			storage: r2({ binding: "MEDIA" }),
			// Trusted, in-process plugins only. No sandboxRunner and no Worker Loader
			// binding, so nothing can be installed from the plugin registry at runtime.
			plugins: [powerfarm(), auditLog],
			// The deployed Worker never migrates its own database: the pipeline runs
			// `emdash migrate` against the build's manifest before new code takes traffic,
			// and a skipped migration makes the Worker answer 503 instead of migrating
			// behind everyone's back. Local dev keeps migrating on its own.
			migrations: { runtime: "check", dev: "auto" },
		}),
	],
	devToolbar: { enabled: false },
});
