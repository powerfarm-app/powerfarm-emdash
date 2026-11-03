/**
 * Cloudflare Worker entry for Powerfarm: EmDash's Astro handler plus the
 * scheduled() handler that runs EmDash maintenance and Powerfarm's plugin tasks
 * (reconciliation, onboarding runs, identity) on the Cron Trigger in wrangler.jsonc.
 * PluginBridge is exported because EmDash's entry expects it; no sandboxed plugin is configured.
 */
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";

export { PluginBridge };

export default {
	...handler,
	scheduled: createScheduledHandler(),
} satisfies ExportedHandler;
