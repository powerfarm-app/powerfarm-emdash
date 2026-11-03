/**
 * Suspending or retiring a person or agent.
 *
 * The moment the record is published as suspended (or retired):
 *   1. `authorize()` denies them: a principal that is not active holds nothing.
 *   2. The OIDC provider stops issuing identities for them (same check).
 *   3. Their grants, and every grant they delegated, are unpublished (revoked).
 * Then Powerfarm opens work for what it cannot do itself, because EmDash gives
 * plugins no way to disable users and Cloudflare sessions live at Cloudflare:
 *   4. disable each linked EmDash user (Admin → Users);
 *   5. revoke their Cloudflare Access sessions and any service tokens;
 *   6. review the devices in their custody.
 * A high incident stays open until a person closes it after those steps.
 */

import type { PluginContext } from "emdash";

import type { ContentReader } from "./content.js";
import { record } from "./journal.js";
import { raiseIncident } from "./mdm/vigilance.js";

type Ctx = Pick<PluginContext, "content" | "kv" | "log" | "settings" | "storage">;

async function publishEntry(ctx: Ctx, collection: string, id: string): Promise<void> {
	const v = ctx.content?.getVersioned ? await ctx.content.getVersioned(collection, id) : null;
	if (v && ctx.content?.publish) await ctx.content.publish(collection, id, { _rev: v._rev });
}

export async function suspendPrincipal(ctx: Ctx, reader: ContentReader, subject: string, lifecycle: string, now = new Date()): Promise<{ revoked: number; work: number }> {
	// 3. Revoke grants held or delegated.
	let revoked = 0;
	const held = await reader.byField("grants", "principal", [subject], "published", 200);
	const delegated = await reader.byField("grants", "delegated_by", [subject], "published", 200);
	for (const g of [...held, ...delegated]) {
		const v = ctx.content?.getVersioned ? await ctx.content.getVersioned("grants", g.id) : null;
		if (!v || !ctx.content?.unpublish) continue;
		await ctx.content.unpublish("grants", g.id, { _rev: v._rev });
		revoked++;
	}

	// 4–6. Work for people, once per suspension.
	const users = (await reader.byField("identifiers", "subject", [subject], "published", 50)).filter((e) => e.data.namespace === "emdash_user").map((e) => String(e.data.value));
	const stamp = now.toISOString();
	const tasks = [
		...users.map((u, i) => ({ key: `user-${i}`, title: `Disable EmDash user ${u} (${subject} is ${lifecycle})`, description: `EmDash → Users → find user id ${u} → disable. Powerfarm already refuses this person, but EmDash itself still lets the account sign in until it is disabled.` })),
		{ key: "access", title: `Revoke Cloudflare Access sessions and service tokens of ${subject}`, description: "Zero Trust → Users → revoke sessions; Service credentials → revoke any token issued to them." },
		{ key: "devices", title: `Review devices in the custody of ${subject}`, description: "Collect or wipe company devices; remove the person as custodian; check MDM incidents for those devices." },
	];
	let work = 0;
	for (const t of tasks) {
		const origin = `suspend:${subject}:${stamp}:${t.key}`;
		if (!ctx.content?.create) break;
		const created = await ctx.content.create("work_items", { title: t.title.slice(0, 200), work_kind: "task", pillar: "identity", work_status: "open", subject, description: t.description, required_role: 50, origin });
		await publishEntry(ctx, "work_items", created.id);
		work++;
	}

	await raiseIncident(ctx as never, { rule: "principal_suspended", severity: "high", assetTag: null, udid: null, at: now, detail: `${subject} is ${lifecycle}. Powerfarm now refuses them and revoked ${revoked} grant(s). Close this incident once the open work items for ${subject} are done (EmDash user disabled, Access sessions revoked, devices reviewed).` });
	await record(ctx as never, { type: "identity.suspended", stream: "authority", actor: "powerfarm", source: "policy", title: `${subject} ${lifecycle}: ${revoked} grant(s) revoked, ${work} task(s) opened`, payload: { subject, lifecycle, revoked, users } });
	return { revoked, work };
}
