// Discover devices attached to the host over USB.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Returns [{ ecid, deviceType, serialNumber? }]. Tries cfgutil's JSON output
 * first and falls back to scanning its text output for ECIDs.
 */
export async function listDevices(config, exec = run) {
	if (config.simulate) return config.simulatedDevices ?? [];
	try {
		const { stdout } = await exec(config.cfgutilPath, ["--format", "JSON", "list"], { timeout: 30_000, maxBuffer: 4 << 20 });
		const parsed = JSON.parse(stdout);
		const output = parsed?.Output ?? parsed?.output ?? parsed;
		const devices = [];
		const visit = (value, key) => {
			if (!value || typeof value !== "object") return;
			const ecid = value.ECID ?? (key && /^0x[0-9a-f]+$/i.test(key) ? key : null);
			if (ecid) devices.push({ ecid: String(ecid), deviceType: value.deviceType ?? value.DeviceType ?? null, serialNumber: value.serialNumber ?? null });
			else for (const [k, v] of Object.entries(value)) visit(v, k);
		};
		visit(output, null);
		return dedupe(devices);
	} catch {
		const { stdout } = await exec(config.cfgutilPath, ["list"], { timeout: 30_000, maxBuffer: 4 << 20 });
		return parseListText(stdout);
	}
}

export function parseListText(text) {
	const devices = [];
	for (const line of text.split(/\r?\n/)) {
		const ecid = line.match(/ECID:\s*(0x[0-9a-f]+)/i)?.[1];
		if (!ecid) continue;
		const type = line.match(/Type:\s*([^\s]+)/i)?.[1] ?? null;
		devices.push({ ecid, deviceType: type, serialNumber: null });
	}
	return dedupe(devices);
}

function dedupe(devices) {
	const seen = new Map();
	for (const d of devices) seen.set(d.ecid.toUpperCase(), d);
	return [...seen.values()];
}
