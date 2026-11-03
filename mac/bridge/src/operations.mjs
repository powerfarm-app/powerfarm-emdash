// Compatibility surface for v1 imports: command building and output parsing.
import { iosCfgutil, IOS_PROPERTIES, isAllowedOperation, operationSpec } from "./adapters.mjs";

export { isAllowedOperation, operationSpec };
export const INVENTORY_PROPERTIES = IOS_PROPERTIES;

/** v1 shape: `OPERATIONS[name].destructive / readOnly`. */
export const OPERATIONS = iosCfgutil.operations;

export function buildCommand(job, targetEcid, config) {
	if (!isAllowedOperation(job.operation)) throw new Error(`Operation "${job.operation}" is not allowed on this bridge`);
	return iosCfgutil.command(job, targetEcid ?? job.ecid, config);
}

/** Pull identity fields out of cfgutil's JSON output, tolerating its nesting by ECID. */
export function parseInventory(stdout, ecid) {
	let parsed;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return { raw: String(stdout).slice(0, 4000) };
	}
	const output = parsed?.Output ?? parsed?.output ?? parsed;
	let record = output;
	if (output && typeof output === "object" && !("serialNumber" in output)) {
		const key = Object.keys(output).find((k) => k.toLowerCase() === String(ecid).toLowerCase()) ?? Object.keys(output)[0];
		record = key ? output[key] : output;
	}
	const pick = (k) => (record && typeof record[k] === "string" ? record[k] : record && record[k] != null ? String(record[k]) : undefined);
	const out = {
		ecid: pick("ECID") ?? ecid ?? undefined,
		serialNumber: pick("serialNumber"),
		deviceType: pick("deviceType"),
		osVersion: pick("firmwareVersion"),
		buildVersion: pick("buildVersion"),
		activationState: pick("activationState"),
	};
	// Drop absent fields so the server sees "not reported", never an empty string.
	return Object.fromEntries(Object.entries(out).filter(([, v]) => typeof v === "string" && v.length > 0));
}
