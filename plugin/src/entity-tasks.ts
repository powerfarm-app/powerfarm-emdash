/**
 * Scheduled work for 1.2 entities (see reconcile.ts for registration):
 *
 * - `blueprints`: advance open blueprint runs.
 * - `identity`: finish publishes whose afterPublish did not complete, move to
 *   the trash registry entries no published record lists any more, and mirror
 *   Mission 001 asset identifiers (read-only). Conflicts are reported in the
 *   system journal, never resolved.
 *
 * Both refuse to act until the installation has the 1.2 content model.
 */

import type { PluginContext } from "emdash";

import type { ContentReader } from "./content.js";
import { isEntityCollection } from "./entities.js";
import { handlePublished, type PublishMarker } from "./entity-policy.js";
import { claimOf, formatIdentifier, mirrorAssets, parseIdentifiers, RELEASED, releaseEntry } from "./identity.js";
import { record } from "./journal.js";
import { type CollectionSlug, isPowerfarmCollection, SCHEMA_VERSION } from "./model.js";
import { processRuns, type RunCtx } from "./onboarding.js";
import { getReader } from "./runtime.js";

/** Collections and fields the 1.2 plugin code depends on. The seed test keeps this honest. */
export const REQUIRED_SCHEMA: Readonly<Record<string, readonly string[]>> = {
	clients: ["title", "code", "lifecycle", "classification", "identifiers", "review_cadence_days", "merged_into", "merge_rationale", "origin", "prepared_by_ai", "client_kind"],
	products: ["title", "code", "lifecycle", "classification", "identifiers", "review_cadence_days", "origin"],
	services: ["title", "code", "lifecycle", "classification", "identifiers", "review_cadence_days", "origin", "service_kind"],
	service_instances: ["title", "code", "lifecycle", "classification", "identifiers", "review_cadence_days", "origin", "environment", "secret_refs"],
	contracts: ["title", "code", "lifecycle", "classification", "identifiers", "review_cadence_days", "origin", "effective_date", "end_date", "renewal_date", "document"],
	blueprints: ["title", "code", "target_collection", "trigger", "steps"],
	work_items: ["title", "code", "work_kind", "pillar", "work_status", "subject", "due_at", "required_role", "description", "decision", "resolution", "resolved_by", "resolved_at", "control", "run_id", "step_id", "blueprint_code", "blueprint_revision", "initiated_by", "separate_from_initiator", "origin"],
	exceptions: ["title", "code", "subject", "control", "rationale", "expires_at"],
	identifiers: ["title", "identifier", "namespace", "value", "subject", "source", "rationale"],
	evidence: ["subject", "identifier"],
};

export async function schemaStatus(reader: ContentReader): Promise<{ version: string; ok: boolean; missing: string[] }> {
	const types = await reader.readPort.fieldTypes();
	const missing: string[] = [];
	for (const [collection, fields] of Object.entries(REQUIRED_SCHEMA)) {
		const have = types.get(collection);
		if (!have) {
			missing.push(collection);
			continue;
		}
		for (const f of fields) if (!have.has(f)) missing.push(`${collection}.${f}`);
	}
	return { version: SCHEMA_VERSION, ok: missing.length === 0, missing };
}

export async function blueprintTask(ctx: PluginContext): Promise<Record<string, unknown>> {
	const reader = await getReader();
	const schema = await schemaStatus(reader);
	if (!schema.ok) return { skipped: "content model is not 1.2; run scripts/migrate-1.2.sh", missing: schema.missing.slice(0, 10) };
	return processRuns(ctx as unknown as RunCtx, reader);
}

const MARKER_GRACE_MS = 5 * 60_000;

export async function identityTask(ctx: PluginContext, now = Date.now()): Promise<Record<string, unknown>> {
	const reader = await getReader();
	const schema = await schemaStatus(reader);
	if (!schema.ok) return { skipped: "content model is not 1.2", missing: schema.missing.slice(0, 10) };

	// 1. Publishes whose afterPublish did not finish (or that another hook cancelled after our claim).
	let finished = 0;
	for (const { key, value } of await ctx.kv.list("publish:")) {
		const marker = value as PublishMarker;
		if (!marker?.at || now - Date.parse(marker.at) < MARKER_GRACE_MS || !isEntityCollection(marker.collection)) continue;
		// oxlint-disable-next-line no-await-in-loop -- few markers
		await handlePublished(ctx, marker.collection, marker.id, marker);
		// oxlint-disable-next-line no-await-in-loop
		await ctx.kv.delete(key);
		finished++;
	}

	// 2. Registry entries no published record lists (for example a publish another hook cancelled after the claim): released.
	let released = 0;
	for (const e of await reader.list("identifiers", "draft", 500)) {
		const claim = claimOf(e);
		if (claim.source !== "record" || claim.identifier.startsWith(RELEASED) || !e.createdAt || now - Date.parse(e.createdAt) < MARKER_GRACE_MS) continue;
		const at = claim.subject.indexOf(":");
		const collection = claim.subject.slice(0, at);
		if (!isPowerfarmCollection(collection)) continue;
		// oxlint-disable-next-line no-await-in-loop
		const holder = await reader.resolve(collection as CollectionSlug, claim.subject.slice(at + 1), "published");
		const listed = holder ? parseIdentifiers(holder.data.identifiers).identifiers.some((i) => formatIdentifier(i) === claim.identifier) : false;
		if (listed) continue;
		// oxlint-disable-next-line no-await-in-loop
		if (await releaseEntry(ctx, claim, `Released: ${claim.subject} is not published with it.`)) released++;
	}

	// 3. Mission 001 mirror.
	const assets = await reader.list("assets", "published", 200);
	const mirror = await mirrorAssets(
		ctx,
		reader,
		assets.map((a) => ({ key: (a.key ?? a.id).toUpperCase(), serial: typeof a.data.serial_number === "string" ? a.data.serial_number : null, ecid: typeof a.data.ecid === "string" ? a.data.ecid : null })),
	);
	for (const problem of mirror.conflicts) {
		// oxlint-disable-next-line no-await-in-loop
		await record(ctx, { type: "identity.conflict", stream: "system", actor: "powerfarm", source: "reconcile", title: problem.slice(0, 200), idempotencyKey: `identity:conflict:${problem}` });
	}
	return { publishesFinished: finished, staleReleased: released, mirrored: mirror.claimed, conflicts: mirror.conflicts.length };
}
