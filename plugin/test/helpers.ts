import type { Job } from "../src/model.ts";
import type { AssetFacts, EvidenceFacts } from "../src/recovery.ts";

let n = 0;
export function at(hour: number): string {
	return new Date(Date.UTC(2026, 10, 2, hour, 0, 0)).toISOString();
}

export function iphone(over: Partial<AssetFacts> = {}): AssetFacts {
	return {
		assetTag: "IPHONE-13-RED",
		title: "iPhone 13 RED",
		deviceClass: "iphone",
		role: "fleet",
		ecid: "0x001A2B3C4D5E6F",
		serialNumber: "F2LXK0ABCD12",
		osPolicy: ">=18.0",
		inMission: true,
		...over,
	};
}

export function mac(over: Partial<AssetFacts> = {}): AssetFacts {
	return { assetTag: "LAB-8GB", title: "LAB 8GB", deviceClass: "mac_apple_silicon", role: "fleet", ecid: null, serialNumber: "C07ZX1ABCD9Q", osPolicy: ">=15.0", inMission: true, ...over };
}

export function job(over: Partial<Job> = {}): Job {
	n++;
	const finished = over.finishedAt ?? at(1);
	return {
		id: `op${n}:rev${n}`,
		opId: `op${n}`,
		opCode: `OP-${String(n).padStart(4, "0")}`,
		opRevision: `rev${n}`,
		missionCode: "M001",
		assetTag: "IPHONE-13-RED",
		deviceClass: "iphone",
		ecid: "0x1A2B3C4D5E6F",
		serialNumber: "F2LXK0ABCD12",
		procedureCode: "P-INVENTORY",
		operation: "inventory",
		operationClass: "read",
		destructive: false,
		parameters: {},
		dryRun: false,
		dataDecision: null,
		requiredEvidence: [],
		status: "succeeded",
		authorId: "u1",
		approvedBy: "user:u1",
		approvedAt: finished,
		claimedBy: "lab-512-bridge",
		claimedAt: finished,
		leaseId: "lease",
		leaseExpiresAt: null,
		executionMode: "real",
		startedAt: finished,
		finishedAt: finished,
		updatedAt: finished,
		lastMessage: null,
		result: null,
		evidence: [{ kind: "log", evidenceId: "e", mediaId: "m", sha256: "a".repeat(64) }],
		auditGap: false,
		inspection: null,
		...over,
	};
}

export const goodObserved = { ecid: "0x1a2b3c4d5e6f", serialNumber: "f2lxk0abcd12", osVersion: "18.1" };

export function attestation(attests: string, createdAt: string, over: Partial<EvidenceFacts> = {}): EvidenceFacts {
	n++;
	return {
		id: `ev${n}`,
		evidenceType: "attestation",
		attests,
		assetTag: "IPHONE-13-RED",
		opCode: null,
		jobId: null,
		createdAt,
		sha256: null,
		mediaId: null,
		digestVerified: false,
		signedBy: "u1",
		...over,
	};
}
