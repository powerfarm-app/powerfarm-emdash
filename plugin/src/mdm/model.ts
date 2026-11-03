/**
 * Powerfarm's thin MDM: types, settings and storage.
 *
 * Device state and the command queue are plugin storage (operational data, per
 * EmDash's guidance); what a person decides is content (profiles to install,
 * incidents to triage); what was observed goes to the hash-chained journal.
 */

import type { PluginContext, StorageCollection } from "emdash";

/**
 * Rights the enrolment profile grants Powerfarm (Apple's AccessRights bits):
 * inspect and install/remove configuration profiles (1, 2), device information
 * (16), network information (32), inspect apps (256), restriction queries (512),
 * security queries (1024). Deliberately NOT: lock and passcode removal (4),
 * erase (8), app and settings management. A compromised Powerfarm cannot wipe or
 * lock the fleet. Adding a right means re-enrolling, deliberately.
 */
export const ACCESS_RIGHTS = 1 + 2 + 16 + 32 + 256 + 512 + 1024;

export const MDM_SETTINGS = {
	enabled: "mdmEnabled",
	topic: "mdmTopic",
	caCertificate: "mdmCaCertificate",
	staleHours: "mdmStaleHours",
	queryEveryHours: "mdmQueryEveryHours",
	alertEmail: "mdmAlertEmail",
} as const;

export const MDM_DEFAULTS = { staleHours: 24, queryEveryHours: 6 };

export type DeviceStatus = "enrolled" | "checked_out";

export interface MdmDevice {
	udid: string;
	serial: string;
	assetTag: string;
	model: string | null;
	productName: string | null;
	osVersion: string | null;
	buildVersion: string | null;
	topic: string;
	pushToken: string | null; // hex
	pushMagic: string | null;
	certFingerprint: string;
	certNotAfter: string;
	status: DeviceStatus;
	enrolledAt: string;
	lastSeenAt: string;
	checkedOutAt: string | null;
	facts: DeviceFacts;
}

export interface DeviceFacts {
	information?: { at: string; values: Record<string, string | number | boolean | null> };
	security?: { at: string; values: Record<string, string | number | boolean | null> };
	profiles?: { at: string; items: Array<{ identifier: string; name: string; managed: boolean; uuid: string | null }> };
	certificates?: { at: string; items: Array<{ commonName: string; isIdentity: boolean }> };
	apps?: { at: string; count: number; items: Array<{ identifier: string; name: string; version: string }> };
}

export type CommandStatus = "queued" | "sent" | "acknowledged" | "error" | "not_now" | "cancelled";

export interface MdmCommand {
	id: string; // CommandUUID
	udid: string;
	assetTag: string;
	requestType: string;
	params: Record<string, unknown>; // JSON-safe; built into the command plist when sent
	status: CommandStatus;
	issuedBy: string; // "vigilance" | "user:<id>"
	reason: string;
	queuedAt: string;
	sentAt: string | null;
	doneAt: string | null;
	attempts: number;
	error: string | null;
}

export interface PushRequest {
	id: string; // udid: at most one pending push per device
	udid: string;
	token: string;
	pushMagic: string;
	topic: string;
	status: "pending" | "claimed";
	requestedAt: string;
	claimedAt: string | null;
}

export const MDM_STORAGE = {
	mdm_devices: { indexes: ["status", "serial", "assetTag", "lastSeenAt"] },
	mdm_commands: { indexes: ["udid", "status", "queuedAt", ["udid", "status"], "requestType"] },
	mdm_pushes: { indexes: ["status", "requestedAt"] },
};

export type MdmCtx = Pick<PluginContext, "storage" | "kv" | "settings" | "log" | "content">;

type Store = Record<string, StorageCollection<unknown>>;
export const devicesOf = (ctx: Pick<PluginContext, "storage">) => (ctx.storage as Store).mdm_devices as StorageCollection<MdmDevice>;
export const commandsOf = (ctx: Pick<PluginContext, "storage">) => (ctx.storage as Store).mdm_commands as StorageCollection<MdmCommand>;
export const pushesOf = (ctx: Pick<PluginContext, "storage">) => (ctx.storage as Store).mdm_pushes as StorageCollection<PushRequest>;

export class MdmRefusal extends Error {
	readonly code: string;
	readonly status: number;
	constructor(code: string, message: string, status = 400) {
		super(message);
		this.code = code;
		this.status = status;
	}
}
