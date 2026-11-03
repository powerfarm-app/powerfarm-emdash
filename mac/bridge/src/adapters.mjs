// Capability registry: which adapter can do which operation for which device class.
//
// Only the iPhone/iPad adapter executes anything. Mac operations (inventory,
// macOS Recovery reinstall, DFU revive and restore, verification) are manual
// Finder or on-device procedures recorded in EmDash: no automated Apple-silicon
// DFU route has been validated, so none is offered.
//
// An operation is offered to EmDash only when it has been validated on THIS host
// for THIS tool version (see validation.mjs). The presence of cfgutil is not
// enough.
import path from "node:path";

export const IOS_PROPERTIES = ["ECID", "serialNumber", "deviceType", "firmwareVersion", "buildVersion", "activationState"];

function requireEcid(ecid) {
	if (!ecid || !/^(0x)?[0-9a-f]{1,20}$/i.test(ecid)) throw new Error("A valid ECID is required");
	return ecid;
}

/** iPhone and iPad through Apple Configurator's cfgutil. */
export const iosCfgutil = {
	id: "ios-cfgutil",
	deviceClasses: ["iphone", "ipad"],
	operations: {
		inventory: { destructive: false, readOnly: true, evidence: "inventory_report" },
		verify: { destructive: false, readOnly: true, evidence: "verification_report" },
		backup: { destructive: false, readOnly: false, evidence: "backup_manifest" },
		restore: { destructive: true, readOnly: false, evidence: "restore_log" },
		install_profile: { destructive: false, readOnly: false, evidence: "install_log" },
	},
	/** Fixed argv per operation. Never a shell; the device is always pinned by ECID. */
	command(job, targetEcid, config) {
		const ecid = requireEcid(targetEcid);
		const cfgutil = config.cfgutilPath;
		const base = ["--ecid", ecid];
		switch (job.operation) {
			case "inventory":
			case "verify":
				return { file: cfgutil, args: ["--format", "JSON", ...base, "get", ...IOS_PROPERTIES] };
			case "backup":
				return { file: cfgutil, args: [...base, "backup"] };
			case "restore":
				return { file: cfgutil, args: [...base, "restore"] };
			case "install_profile": {
				const name = job.parameters?.profile;
				if (typeof name !== "string" || !/^[A-Za-z0-9._-]+\.mobileconfig$/.test(name)) {
					throw new Error("install_profile needs parameters.profile: a .mobileconfig file name in the profiles folder");
				}
				const file = path.join(config.profilesDir, name);
				if (path.dirname(file) !== path.resolve(config.profilesDir)) throw new Error("Profile path escapes the profiles folder");
				return { file: cfgutil, args: [...base, "install-profile", file] };
			}
			default:
				throw new Error(`Operation "${job.operation}" is not allowed on this bridge`);
		}
	},
};

/** Mac operations exist in EmDash as manual procedures; the bridge declares them unsupported. */
export const macManual = {
	id: "mac-manual",
	deviceClasses: ["mac_apple_silicon", "mac_intel"],
	operations: {},
	unsupported: {
		mac_inventory_manual: "Manual procedure (About This Mac / System Information).",
		mac_recovery_reinstall: "Manual procedure in macOS Recovery on the Mac itself.",
		mac_dfu_revive: "Manual Finder procedure on a second Mac with macOS 14 or later; no automated route validated.",
		mac_dfu_restore: "Manual Finder procedure on a second Mac with macOS 14 or later; no automated route validated.",
		mac_verify_manual: "Manual procedure.",
	},
};

export const ADAPTERS = [iosCfgutil, macManual];

export function adapterFor(operation, deviceClass) {
	for (const adapter of ADAPTERS) {
		if (Object.hasOwn(adapter.operations, operation) && (!deviceClass || adapter.deviceClasses.includes(deviceClass))) return adapter;
	}
	return null;
}

export function operationSpec(operation) {
	const adapter = adapterFor(operation);
	return adapter ? adapter.operations[operation] : null;
}

export function isAllowedOperation(name) {
	return typeof name === "string" && !!adapterFor(name);
}
