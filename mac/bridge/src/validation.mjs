// Operation validation on this host.
//
// An operation is "validated" only if the operator has confirmed it on this
// host, with this macOS major version and this exact cfgutil version. The record
// lives in ~/.powerfarm/validated-operations.json:
//
//   { "operations": { "inventory": { "macosMajor": "15", "cfgutilVersion": "2.17",
//       "validatedAt": "...", "method": "executed" | "operator-attested", "note": "..." } } }
//
// `powerfarm-bridge validate inventory|verify` runs the real read-only command
// against a connected device and records it only if the output parses with a
// serial number and ECID. Backup, restore and install_profile change devices, so
// they are recorded only after the operator types an explicit attestation that
// they ran the exact command line on a device they were prepared to erase.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { ADAPTERS } from "./adapters.mjs";

export function loadValidation(file) {
	if (!file || !existsSync(file)) return { operations: {} };
	try {
		const data = JSON.parse(readFileSync(file, "utf8"));
		return data && typeof data.operations === "object" ? data : { operations: {} };
	} catch {
		return { operations: {} };
	}
}

export function saveValidation(file, data) {
	writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export function macosMajor(version) {
	return typeof version === "string" ? version.split(".")[0] : null;
}

/**
 * For every operation the adapters know: is it validated for this host?
 * Returns the structure the bridge reports to EmDash as health.
 */
export function capabilityReport(validation, host) {
	return ADAPTERS.map((adapter) => ({
		id: adapter.id,
		deviceClasses: adapter.deviceClasses,
		operations: [
			...Object.keys(adapter.operations).map((name) => {
				const v = validation.operations?.[name];
				if (!host.cfgutilVersion) return { name, validated: false, reason: "cfgutil not found" };
				if (!v) return { name, validated: false, reason: "not validated on this host" };
				if (v.cfgutilVersion !== host.cfgutilVersion) return { name, validated: false, reason: `validated with cfgutil ${v.cfgutilVersion}, host has ${host.cfgutilVersion}` };
				if (v.macosMajor !== macosMajor(host.macosVersion)) return { name, validated: false, reason: `validated on macOS ${v.macosMajor}, host is ${host.macosVersion}` };
				return { name, validated: true, reason: `${v.method} ${v.validatedAt}` };
			}),
			...Object.entries(adapter.unsupported ?? {}).map(([name, reason]) => ({ name, validated: false, reason })),
		],
	}));
}

export function validatedOperations(report) {
	return report.flatMap((a) => a.operations.filter((o) => o.validated).map((o) => o.name));
}
