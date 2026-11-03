/**
 * Load the plain facts the recovery rules work on from EmDash content.
 *
 * Safety decisions read the published (live) state of assets, procedures and
 * missions: an unpublished draft edit of an asset never changes what the policy
 * sees. Evidence is append-only and is read in every state.
 */

import type { ContentReader, Entity } from "./content.js";
import { MISSION_001 } from "./model.js";
import type { AssetFacts, EvidenceFacts, OperationFacts } from "./recovery.js";

function str(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function assetFactsOf(entity: Entity, inMissionGroups: ReadonlySet<string>): AssetFacts {
	return {
		assetTag: (entity.key ?? entity.id).toUpperCase(),
		title: entity.title,
		deviceClass: str(entity.data.device_class),
		role: str(entity.data.role),
		ecid: str(entity.data.ecid),
		serialNumber: str(entity.data.serial_number),
		osPolicy: str(entity.data.os_policy),
		inMission: inMissionGroups.has(entity.group),
	};
}

export function evidenceFactsOf(entity: Entity): EvidenceFacts {
	return {
		id: entity.id,
		evidenceType: str(entity.data.evidence_type) ?? "",
		attests: str(entity.data.attests),
		assetTag: str(entity.data.asset_tag)?.toUpperCase() ?? null,
		opCode: str(entity.data.op_code)?.toUpperCase() ?? null,
		jobId: str(entity.data.job_id),
		createdAt: entity.createdAt ?? entity.updatedAt ?? "",
		sha256: str(entity.data.sha256),
		mediaId: str(entity.data.media_id),
		digestVerified: entity.data.digest_status === "server_verified",
		signedBy: str(entity.data.signed_by),
	};
}

export function operationFactsOf(entity: Entity): OperationFacts {
	return {
		opCode: (entity.key ?? entity.id).toUpperCase(),
		status: entity.status,
		operation: str(entity.data.operation) ?? "",
		assetTag: str(entity.data.asset_tag)?.toUpperCase() ?? "",
		dataDecision: str(entity.data.data_decision),
	};
}

/** Translation groups of assets in a mission's scope, from EmDash's live relation edges. */
export async function missionScope(reader: ContentReader, missionCode = MISSION_001): Promise<{ mission: Entity | null; assetGroups: Set<string> }> {
	const mission = await reader.resolve("missions", missionCode, "published");
	if (!mission) return { mission: null, assetGroups: new Set() };
	const edges = await reader.readPort.edgesTouching([mission.group]);
	return {
		mission,
		assetGroups: new Set(edges.filter((e) => e.relation === "missions_assets" && e.parent_group === mission.group).map((e) => e.child_group)),
	};
}

export async function loadAssets(reader: ContentReader, missionCode = MISSION_001): Promise<{ facts: AssetFacts[]; entities: Entity[] }> {
	const [entities, scope] = await Promise.all([reader.list("assets", "published", 500), missionScope(reader, missionCode)]);
	return { facts: entities.map((e) => assetFactsOf(e, scope.assetGroups)), entities };
}

export async function loadAsset(reader: ContentReader, assetTag: string, missionCode = MISSION_001): Promise<{ facts: AssetFacts; entity: Entity } | null> {
	const entity = await reader.resolve("assets", assetTag, "published");
	if (!entity) return null;
	const scope = await missionScope(reader, missionCode);
	return { facts: assetFactsOf(entity, scope.assetGroups), entity };
}

export async function loadEvidence(reader: ContentReader, assetTags: readonly string[]): Promise<EvidenceFacts[]> {
	if (assetTags.length === 0) return [];
	const entities = await reader.byField("evidence", "asset_tag", assetTags.map((t) => t.toUpperCase()), "draft", 2000);
	return entities.map(evidenceFactsOf);
}
