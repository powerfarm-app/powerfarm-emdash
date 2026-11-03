/**
 * The closed set of MDM commands Powerfarm can send, how each is built into
 * the command plist, and how each result becomes device facts.
 *
 * Read-only queries are queued by vigilance on a schedule (or by an editor).
 * Profile installs come only from profiles an administrator has published
 * (`mdm_profiles` content). Nothing here can erase, lock, or clear a passcode:
 * the enrolment does not grant those rights (model.ts ACCESS_RIGHTS).
 */

import type { DeviceFacts } from "./model.js";
import type { PlistDict, PlistValue } from "./plist.js";

export const QUERY_COMMANDS = ["DeviceInformation", "SecurityInfo", "ProfileList", "CertificateList", "InstalledApplicationList"] as const;
export const PROFILE_COMMANDS = ["InstallProfile", "RemoveProfile"] as const;
export type RequestType = (typeof QUERY_COMMANDS)[number] | (typeof PROFILE_COMMANDS)[number];

export function isAllowedCommand(t: string): t is RequestType {
	return (QUERY_COMMANDS as readonly string[]).includes(t) || (PROFILE_COMMANDS as readonly string[]).includes(t);
}

/** DeviceInformation keys asked for and kept. Anything else the device sends is ignored. */
export const DEVICE_QUERIES = [
	"DeviceName",
	"OSVersion",
	"BuildVersion",
	"ProductName",
	"Model",
	"ModelName",
	"SerialNumber",
	"UDID",
	"IsSupervised",
	"IsActivationLockEnabled",
	"IsCloudBackupEnabled",
	"IsDeviceLocatorServiceEnabled",
	"IsDoNotDisturbInEffect",
	"IsMDMLostModeEnabled",
	"SupplementalBuildVersion",
	"AvailableDeviceCapacity",
] as const;

const SECURITY_KEYS = [
	"PasscodePresent",
	"PasscodeCompliant",
	"PasscodeCompliantWithProfiles",
	"HardwareEncryptionCaps",
	"FDE_Enabled",
	"FDE_HasPersonalRecoveryKey",
	"FDE_HasInstitutionalRecoveryKey",
	"SystemIntegrityProtectionEnabled",
	"AuthenticatedRootVolumeEnabled",
	"IsRecoveryLockEnabled",
	"IsActivationLockManageable",
	"EnrolledViaDEP",
	"IsUserEnrollment",
	"UserApprovedEnrollment",
	"FirewallEnabled",
	"BlockAllIncoming",
	"StealthMode",
	"SecureBootLevel",
	"ExternalBootLevel",
	"RemoteDesktopEnabled",
	"BootstrapTokenAllowedForAuthentication",
] as const;

/** Build the inner `Command` dict for a queued command. `profileBytes` is supplied for InstallProfile. */
export function buildCommand(requestType: RequestType, params: Record<string, unknown>, profileBytes?: Uint8Array): PlistDict {
	switch (requestType) {
		case "DeviceInformation":
			return { RequestType: requestType, Queries: [...DEVICE_QUERIES] };
		case "InstalledApplicationList":
			return { RequestType: requestType, ManagedAppsOnly: false };
		case "InstallProfile":
			if (!profileBytes) throw new Error("InstallProfile needs the profile");
			return { RequestType: requestType, Payload: profileBytes };
		case "RemoveProfile":
			if (typeof params.identifier !== "string") throw new Error("RemoveProfile needs an identifier");
			return { RequestType: requestType, Identifier: params.identifier };
		default:
			return { RequestType: requestType };
	}
}

type Scalar = string | number | boolean | null;
const scalar = (v: PlistValue | undefined): Scalar => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : v instanceof Date ? v.toISOString() : null);

function pick(source: PlistDict, keys: readonly string[]): Record<string, Scalar> {
	const out: Record<string, Scalar> = {};
	for (const k of keys) if (k in source) out[k] = scalar(source[k]);
	return out;
}

const dict = (v: PlistValue | undefined): PlistDict => (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array) ? v : {});
const list = (v: PlistValue | undefined): PlistValue[] => (Array.isArray(v) ? v : []);
const str = (v: PlistValue | undefined, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

/** Facts from an acknowledged command's result. Returns only the part this result updates. */
export function factsFromResult(requestType: string, result: PlistDict, at: string): Partial<DeviceFacts> {
	switch (requestType) {
		case "DeviceInformation":
			return { information: { at, values: pick(dict(result.QueryResponses), DEVICE_QUERIES) } };
		case "SecurityInfo": {
			const s = dict(result.SecurityInfo);
			const fw = dict(s.FirewallSettings);
			const sb = dict(s.SecureBoot);
			const mgmt = dict(s.ManagementStatus);
			return { security: { at, values: pick({ ...s, ...fw, ...mgmt, SecureBootLevel: sb.SecureBootLevel ?? s.SecureBootLevel, ExternalBootLevel: sb.ExternalBootLevel ?? s.ExternalBootLevel } as PlistDict, SECURITY_KEYS) } };
		}
		case "ProfileList":
			return {
				profiles: {
					at,
					items: list(result.ProfileList)
						.slice(0, 200)
						.map((p) => dict(p))
						.map((p) => ({ identifier: str(p.PayloadIdentifier), name: str(p.PayloadDisplayName), managed: p.IsManaged === true, uuid: str(p.PayloadUUID) || null })),
				},
			};
		case "CertificateList":
			return { certificates: { at, items: list(result.CertificateList).slice(0, 200).map((c) => dict(c)).map((c) => ({ commonName: str(c.CommonName), isIdentity: c.IsIdentity === true })) } };
		case "InstalledApplicationList": {
			const apps = list(result.InstalledApplicationList).map((a) => dict(a));
			return { apps: { at, count: apps.length, items: apps.slice(0, 1000).map((a) => ({ identifier: str(a.Identifier), name: str(a.Name), version: str(a.ShortVersion || a.Version, 60) })) } };
		}
		default:
			return {};
	}
}
