#!/usr/bin/env node
// Powerfarm Apple Hardware Bridge.
//
//   powerfarm-bridge doctor              diagnostics: macOS, cfgutil, validated operations, EmDash connection, devices
//   powerfarm-bridge validate <op>       validate one operation on this host (see src/validation.mjs)
//   powerfarm-bridge devices             list connected devices
//   powerfarm-bridge once                handle at most one job and exit (use this for restores)
//   powerfarm-bridge run [--simulate]    poll EmDash and execute approved, validated jobs (and relay MDM pushes)
//   powerfarm-bridge mdm-ca init         create the Powerfarm device CA on this Mac (once); prints its certificate
//   powerfarm-bridge mdm-profile <UDID>  write the enrolment profile for one device into profilesDir
//
// Configuration: --config <file> (default ~/.powerfarm/bridge.json). The signing
// secret comes from POWERFARM_BRIDGE_SECRET or config.secretFile, never the config.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";

import { ADAPTERS, iosCfgutil } from "../src/adapters.mjs";
import { EmDashClient } from "../src/client.mjs";
import { listDevices } from "../src/devices.mjs";
import { parseInventory } from "../src/operations.mjs";
import { apnsSender, enrolmentProfile, initCa, issueIdentity } from "../src/mdm.mjs";
import { Bridge, BRIDGE_VERSION } from "../src/runner.mjs";
import { capabilityReport, loadValidation, macosMajor, saveValidation, validatedOperations } from "../src/validation.mjs";

const run = promisify(execFile);
const home = (p) => (typeof p === "string" ? p.replace(/^~(?=\/)/, os.homedir()) : p);

function loadConfig(argv) {
	const i = argv.indexOf("--config");
	const file = i >= 0 ? argv[i + 1] : path.join(os.homedir(), ".powerfarm", "bridge.json");
	if (!existsSync(file)) throw new Error(`Config not found: ${file}. Copy config.example.json there.`);
	const config = JSON.parse(readFileSync(file, "utf8"));
	return {
		cfgutilPath: "/Applications/Apple Configurator.app/Contents/MacOS/cfgutil",
		hostAssetTag: "LAB-512",
		pollSeconds: 20,
		requireLocalConfirmation: true,
		...config,
		simulate: argv.includes("--simulate") || config.simulate === true,
		configFile: file,
		logDir: home(config.logDir ?? "~/.powerfarm/logs"),
		profilesDir: home(config.profilesDir ?? "~/.powerfarm/profiles"),
		secretFile: home(config.secretFile),
		accessSecretFile: home(config.accessSecretFile),
		mdmCaDir: home(config.mdm?.caDir ?? "~/.powerfarm/mdm-ca"),
		mdmPushFile: config.mdm?.pushCertificateFile ? home(config.mdm.pushCertificateFile) : null,
		mdmPushPasswordFile: config.mdm?.pushPasswordFile ? home(config.mdm.pushPasswordFile) : null,
		mdmTopic: config.mdm?.topic ?? null,
		validationFile: home(config.validationFile ?? "~/.powerfarm/validated-operations.json"),
	};
}

function loadSecret(config) {
	if (process.env.POWERFARM_BRIDGE_SECRET) return process.env.POWERFARM_BRIDGE_SECRET.trim();
	if (!config.secretFile) throw new Error("Set POWERFARM_BRIDGE_SECRET or secretFile in the config.");
	const mode = statSync(config.secretFile).mode & 0o777;
	if (mode & 0o077) throw new Error(`${config.secretFile} is readable by others (mode ${mode.toString(8)}). Run: chmod 600 ${config.secretFile}`);
	return readFileSync(config.secretFile, "utf8").trim();
}

async function hostFacts(config) {
	const facts = { macosVersion: null, cfgutilVersion: null, cfgutilPath: null };
	try {
		facts.macosVersion = (await run("sw_vers", ["-productVersion"])).stdout.trim();
	} catch {
		/* not macOS */
	}
	try {
		facts.cfgutilVersion = (await run(config.cfgutilPath, ["version"])).stdout.trim();
		facts.cfgutilPath = config.cfgutilPath;
	} catch {
		/* not installed */
	}
	return facts;
}

async function capabilities(config) {
	const facts = await hostFacts(config);
	const report = capabilityReport(loadValidation(config.validationFile), facts);
	return { facts, report, validated: config.simulate ? [] : validatedOperations(report) };
}

/** Cloudflare Access service token: id in the config, secret from POWERFARM_ACCESS_CLIENT_SECRET or accessSecretFile (mode 600). */
function loadAccess(config) {
	if (!config.accessClientId) return null;
	let clientSecret = process.env.POWERFARM_ACCESS_CLIENT_SECRET?.trim();
	if (!clientSecret) {
		if (!config.accessSecretFile) throw new Error("accessClientId is set: set accessSecretFile or POWERFARM_ACCESS_CLIENT_SECRET too.");
		const mode = statSync(config.accessSecretFile).mode & 0o777;
		if (mode & 0o077) throw new Error(`${config.accessSecretFile} is readable by others (mode ${mode.toString(8)}). Run: chmod 600 ${config.accessSecretFile}`);
		clientSecret = readFileSync(config.accessSecretFile, "utf8").trim();
	}
	return { clientId: config.accessClientId, clientSecret };
}

function clientFor(config) {
	return new EmDashClient({ baseUrl: config.emdashUrl, bridgeId: config.bridgeId, secret: loadSecret(config), access: loadAccess(config) });
}

async function sendHealth(config, client) {
	const { facts, report } = await capabilities(config);
	const devices = await listDevices(config).catch(() => []);
	return client.health({ bridgeVersion: BRIDGE_VERSION, macosVersion: facts.macosVersion, cfgutilPath: facts.cfgutilPath, cfgutilVersion: facts.cfgutilVersion, mode: config.simulate ? "simulated" : "real", adapters: report, devices: devices.length });
}

async function doctor(config) {
	const results = [];
	const check = async (name, fn) => {
		try {
			results.push(["ok", name, (await fn()) ?? ""]);
		} catch (error) {
			results.push(["FAIL", name, error.message]);
		}
	};
	const { facts, report } = await capabilities(config);
	await check("bridge version", () => BRIDGE_VERSION);
	await check("platform is macOS", () => {
		if (process.platform !== "darwin") throw new Error(`running on ${process.platform}; Apple Configurator needs macOS`);
		return facts.macosVersion;
	});
	await check("Node.js 22+", () => {
		if (Number(process.versions.node.split(".")[0]) < 22) throw new Error(process.version);
		return process.version;
	});
	await check("cfgutil", () => {
		if (!facts.cfgutilVersion) throw new Error(`not found at ${config.cfgutilPath}`);
		return `${facts.cfgutilVersion} at ${facts.cfgutilPath}`;
	});
	for (const sub of ["list", "get", "backup", "restore", "install-profile"]) {
		await check(`cfgutil help ${sub}`, async () => (await run(config.cfgutilPath, ["help", sub])).stdout.split("\n").slice(0, 2).join(" | "));
	}
	await check("signing secret", () => `${loadSecret(config).length} characters`);
	await check("EmDash reachable, signature accepted, health recorded", async () => {
		const r = await sendHealth(config, clientFor(config));
		return `validated on EmDash: ${r.validatedOperations.join(", ") || "none"}`;
	});
	await check("results waiting for EmDash", () => {
		const outbox = new Bridge({ client: null, config }).outbox;
		const waiting = outbox.pending().length;
		const refused = outbox.rejected().length;
		if (refused) throw new Error(`${refused} result(s) refused by EmDash, kept in ${outbox.rejectedDir}: a person must look at them`);
		return waiting ? `${waiting} queued, will be delivered when EmDash is reachable` : "none";
	});
	await check("devices", async () => (await listDevices(config)).map((d) => `${d.deviceType ?? "?"} ${d.ecid}`).join(", ") || "none connected");
	for (const [status, name, detail] of results) console.log(`${status.padEnd(4)} ${name}${detail ? ` — ${detail}` : ""}`);
	console.log("\nOperations on this host:");
	for (const adapter of report) {
		console.log(`  ${adapter.id} (${adapter.deviceClasses.join(", ")})`);
		for (const op of adapter.operations) console.log(`    ${op.validated ? "VALIDATED  " : "not enabled"} ${op.name}${op.reason ? ` — ${op.reason}` : ""}`);
	}
	process.exitCode = results.some(([s]) => s === "FAIL") ? 1 : 0;
}

async function validate(config, operation) {
	if (!operation || !Object.hasOwn(iosCfgutil.operations, operation)) {
		throw new Error(`Usage: powerfarm-bridge validate <${Object.keys(iosCfgutil.operations).join("|")}>. Mac operations are manual procedures and are not validated here.`);
	}
	const facts = await hostFacts(config);
	if (!facts.cfgutilVersion || !facts.macosVersion) throw new Error("Run this on the macOS bridge host with Apple Configurator installed.");
	const devices = await listDevices(config);
	if (devices.length !== 1) throw new Error(`Connect exactly one test device (found ${devices.length}).`);
	const device = devices[0];
	const command = iosCfgutil.command({ operation, parameters: { profile: "validation.mobileconfig" } }, device.ecid, config);
	const spec = iosCfgutil.operations[operation];
	const data = loadValidation(config.validationFile);
	let method;
	if (spec.readOnly) {
		console.log(`Running: ${command.file} ${command.args.join(" ")}`);
		const { stdout } = await run(command.file, command.args, { timeout: 120_000, maxBuffer: 4 << 20 });
		const parsed = parseInventory(stdout, device.ecid);
		if (!parsed.serialNumber || !parsed.ecid || !parsed.osVersion) throw new Error(`Output did not contain serialNumber, ECID and firmwareVersion: ${JSON.stringify(parsed).slice(0, 300)}`);
		console.log(`Parsed: ${JSON.stringify(parsed)}`);
		method = "executed";
	} else {
		const help = await run(config.cfgutilPath, ["help", command.args[2] ?? operation]).then((r) => r.stdout).catch((e) => e.message);
		console.log(`cfgutil's own help:\n${help}\n`);
		console.log(`The bridge would run exactly:\n  ${command.file} ${command.args.join(" ")}\n`);
		console.log(spec.destructive ? "This ERASES the device. Validate it only on a device you are prepared to erase.\n" : "");
		console.log("Run that command yourself on the connected test device, check the result, then attest here.");
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		const phrase = `I ran ${operation} on ${device.ecid}`;
		const answer = await rl.question(`Type "${phrase}" to record it, or anything else to cancel: `);
		rl.close();
		if (answer.trim() !== phrase) throw new Error("Not recorded.");
		method = "operator-attested";
	}
	data.operations ??= {};
	data.operations[operation] = { macosMajor: macosMajor(facts.macosVersion), macosVersion: facts.macosVersion, cfgutilVersion: facts.cfgutilVersion, validatedAt: new Date().toISOString(), method, deviceEcid: device.ecid, deviceType: device.deviceType ?? null };
	saveValidation(config.validationFile, data);
	console.log(`Recorded ${operation} as validated (${method}) for macOS ${facts.macosVersion}, cfgutil ${facts.cfgutilVersion}.`);
}

async function main() {
	const argv = process.argv.slice(2);
	const configAt = argv.indexOf("--config");
	const positional = argv.filter((a, i) => !a.startsWith("--") && !(configAt >= 0 && i === configAt + 1));
	const command = positional[0] ?? "run";
	const config = loadConfig(argv);

	if (command === "doctor") return doctor(config);
	if (command === "validate") return validate(config, positional[1]);
	if (command === "devices") return console.log(JSON.stringify(await listDevices(config), null, 2));
	if (command === "mdm-ca") {
		if (positional[1] !== "init") throw new Error("Usage: powerfarm-bridge mdm-ca init");
		const pem = initCa(config.mdmCaDir);
		console.log(`Device CA created in ${config.mdmCaDir} (private key mode 600; back it up offline).\nPaste this certificate into EmDash → Plugins → Powerfarm → "MDM: device CA certificate":\n\n${pem}`);
		return;
	}
	if (command === "mdm-profile") {
		const udid = positional[1];
		if (!udid || !config.mdmTopic) throw new Error("Usage: powerfarm-bridge mdm-profile <UDID>  (and set mdm.topic in the bridge config)");
		const xml = enrolmentProfile({ emdashUrl: config.emdashUrl, topic: config.mdmTopic, udid, identity: issueIdentity(config.mdmCaDir, udid) });
		const { mkdirSync, writeFileSync } = await import("node:fs");
		mkdirSync(config.profilesDir, { recursive: true, mode: 0o700 });
		const file = path.join(config.profilesDir, `enrol-${udid.toUpperCase()}.mobileconfig`);
		writeFileSync(file, xml, { mode: 0o600 });
		console.log(`Wrote ${file}. It contains the device's private key: install it with an approved install_profile operation (profile: ${path.basename(file)}), then delete it.`);
		return;
	}
	if (command === "adapters") return console.log(JSON.stringify(ADAPTERS.map((a) => ({ id: a.id, deviceClasses: a.deviceClasses, operations: Object.keys(a.operations), unsupported: a.unsupported ?? {} })), null, 2));

	const client = clientFor(config);
	const { validated } = await capabilities(config);
	const bridge = new Bridge({ client, config, validated });
	if (config.mdmPushFile) {
		const passphrase = config.mdmPushPasswordFile ? readFileSync(config.mdmPushPasswordFile, "utf8").trim() : undefined;
		bridge.setPushSender(apnsSender({ pfx: readFileSync(config.mdmPushFile), passphrase }));
	}
	if (command === "once") {
		await bridge.recoverInFlight();
		await sendHealth(config, client).catch((e) => console.error("health:", e.message));
		console.log((await bridge.tick()) ? "Handled one job." : "Nothing to do.");
		return;
	}
	if (command === "run") {
		const controller = new AbortController();
		for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => controller.abort());
		await bridge.run({ intervalSeconds: config.pollSeconds, signal: controller.signal, health: () => sendHealth(config, client) });
		return;
	}
	throw new Error(`Unknown command ${command}`);
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
