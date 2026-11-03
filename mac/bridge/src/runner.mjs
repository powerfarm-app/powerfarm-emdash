// The bridge loop: discover devices, claim one approved job, execute it, upload
// evidence, report. Every report carries the lease issued at the claim and the
// exact approved revision.
import { execFile } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { adapterFor } from "./adapters.mjs";
import { Outbox } from "./outbox.mjs";
import { listDevices } from "./devices.mjs";
import { buildCommand, isAllowedOperation, OPERATIONS, parseInventory } from "./operations.mjs";
import { redact } from "./redact.mjs";

export const BRIDGE_VERSION = "1.4.0";
const LOG_TAIL = 3000;

export function normalizeEcid(value) {
	return value ? String(value).trim().toUpperCase().replace(/^0X/, "").replace(/^0+/, "") : null;
}

function log(...args) {
	console.log(new Date().toISOString(), ...args);
}

/** Run a command without a shell, streaming output to a log file. */
function execute(command, logFile, { timeoutMs, onTick, onChild }) {
	return new Promise((resolve) => {
		const out = createWriteStream(logFile, { flags: "a" });
		out.write(`$ ${command.file} ${command.args.map((a) => JSON.stringify(a)).join(" ")}\n`);
		let stdout = "";
		const child = execFile(command.file, command.args, { timeout: timeoutMs, maxBuffer: 64 << 20 }, (error) => {
			clearInterval(ticker);
			out.end(`\n[exit ${error ? (error.code ?? "error") : 0}]\n`, () => resolve({ ok: !error, code: error?.code ?? 0, stdout, error }));
		});
		onChild?.(child);
		child.stdout?.on("data", (chunk) => {
			if (stdout.length < 8 << 20) stdout += chunk;
			out.write(chunk);
		});
		child.stderr?.on("data", (chunk) => out.write(chunk));
		const ticker = setInterval(() => void onTick?.(), 60_000);
	});
}

async function confirmLocally(job, config) {
	if (!config.requireLocalConfirmation) return true;
	if (!process.stdin.isTTY) {
		log(`Refusing destructive ${job.operation} on ${job.assetTag}: local confirmation is required and no terminal is attached.`);
		return false;
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question(
			`\nApproved in EmDash: ${job.opCode} ${job.operation.toUpperCase()} on ${job.assetTag} (ECID ${job.ecid}).\nThis ERASES the device. Type the asset tag to proceed: `,
		);
		return answer.trim().toUpperCase() === String(job.assetTag).toUpperCase();
	} finally {
		rl.close();
	}
}

export class Bridge {
	/**
	 * @param {{ client: object, config: object, validated?: string[] }} options
	 * `validated` lists operations validated on this host (from validation.mjs).
	 * In simulation mode nothing touches a device and validation is not required.
	 */
	constructor({ client, config, validated = [] }) {
		this.client = client;
		this.config = config;
		this.validated = new Set(validated);
		this.current = null;
		this.stopping = false;
		mkdirSync(config.logDir, { recursive: true });
		this.stateFile = path.join(config.logDir, "in-flight.json");
		this.outbox = new Outbox(path.join(config.logDir, "outbox"));
	}

	/** Deliver queued results. Returns how many still wait (EmDash unreachable). */
	flush() {
		return this.outbox.drain(this.client, log);
	}

	get mode() {
		return this.config.simulate ? "simulated" : "real";
	}

	/** If the bridge died mid-job, tell EmDash before doing anything else. */
	async recoverInFlight() {
		if (!existsSync(this.stateFile)) return;
		let state;
		try {
			state = JSON.parse(readFileSync(this.stateFile, "utf8"));
		} catch {
			rmSync(this.stateFile, { force: true });
			return;
		}
		// Its result may already be safely queued (the bridge stopped before delivering it): then it was not interrupted.
		if (!this.outbox.jobsWithFinalReport().has(state.jobId)) {
			log(`Found an interrupted job from a previous run: ${state.opCode}. Reporting it.`);
			this.outbox.put({ type: "report", jobId: state.jobId, phase: "interrupted", extra: { leaseId: state.leaseId, opRevision: state.opRevision, message: "The bridge stopped while this job was running." } });
		}
		rmSync(this.stateFile, { force: true });
		await this.flush();
	}

	/** One poll: returns true if a job was handled. */
	async tick() {
		// Never take new work while results of earlier work have not reached EmDash.
		if ((await this.flush()) > 0) return false;
		const devices = await listDevices(this.config);
		if (devices.length === 0) return false;
		const claimed = await this.client.claim({
			devices: devices.map((d) => ({ ecid: d.ecid, deviceType: d.deviceType ?? undefined, serialNumber: d.serialNumber ?? undefined })),
			mode: this.mode,
			validatedOperations: this.mode === "simulated" ? [] : [...this.validated],
			bridgeVersion: BRIDGE_VERSION,
		});
		if (!claimed?.job) return false;
		await this.handle(claimed.job, claimed.procedure, devices);
		return true;
	}

	async handle(job, procedure, devices) {
		const config = this.config;
		const lease = { leaseId: job.leaseId, opRevision: job.opRevision };
		const logFile = path.join(config.logDir, `${job.opCode}-${Date.now()}.log`);
		const fail = async (message, extra = {}) => {
			log(`FAILED ${job.opCode}: ${message}`);
			this.outbox.put({ type: "report", jobId: job.id, phase: "failed", extra: { ...lease, message, ...extra } });
			rmSync(this.stateFile, { force: true });
			await this.flush();
		};

		log(`Claimed ${job.opCode}: ${job.operation} on ${job.assetTag}${job.dryRun ? " (dry run)" : ""}${this.mode === "simulated" ? " (SIMULATION)" : ""}`);
		if (procedure?.physicalSteps) log(`Operator: ${procedure.physicalSteps}`);

		// Local guards, independent of the server.
		if (!isAllowedOperation(job.operation)) return fail(`Operation ${job.operation} is not allowed on this bridge.`);
		if (String(job.assetTag).toUpperCase() === String(config.hostAssetTag).toUpperCase()) return fail("Refusing to operate on the bridge host itself.");
		if (!adapterFor(job.operation, job.deviceClass ?? "iphone")) return fail(`No adapter for ${job.operation} on ${job.deviceClass}.`);
		if (this.mode === "real" && !job.dryRun && !this.validated.has(job.operation)) {
			return fail(`${job.operation} is not validated on this host. Run powerfarm-bridge validate ${job.operation}.`);
		}
		const target = job.ecid
			? devices.find((d) => normalizeEcid(d.ecid) === normalizeEcid(job.ecid))
			: job.operation === "inventory" && devices.length === 1
				? devices[0]
				: null;
		if (!target) return fail("Target device is not connected.");

		let command;
		try {
			command = buildCommand(job, target.ecid, config);
		} catch (error) {
			return fail(error.message);
		}

		const started = await this.client.report(job.id, "started", { ...lease, message: `Bridge ${BRIDGE_VERSION} starting ${job.operation}` });
		if (!started?.proceed) {
			log(`Not proceeding with ${job.opCode}: ${started?.reason ?? started?.status}`);
			return;
		}

		const spec = OPERATIONS[job.operation];
		const simulateOnly = config.simulate || (job.dryRun && !spec.readOnly);
		if (simulateOnly) {
			const message = `${config.simulate ? "Simulated" : "Dry run"}: would run ${command.file} ${command.args.join(" ")}`;
			log(message);
			this.outbox.put({ type: "report", jobId: job.id, phase: "succeeded", extra: { ...lease, message, result: { simulated: true, command: [command.file, ...command.args].join(" ") } } });
			await this.flush();
			return;
		}

		if (spec.destructive) {
			// Immediately before an irreversible step: device still present, approval
			// still in force, a person at the host agrees, approval checked once more.
			const now = await listDevices(config);
			if (!now.some((d) => normalizeEcid(d.ecid) === normalizeEcid(target.ecid))) return fail("Device disconnected before the destructive step.");
			const check = await this.client.check(job.id, job.leaseId);
			if (!check?.proceed) return fail(`Approval no longer valid: ${check?.reason ?? check?.status}`);
			if (!(await confirmLocally(job, config))) return fail("Local confirmation was not given.");
			const recheck = await this.client.check(job.id, job.leaseId);
			if (!recheck?.proceed) return fail(`Approval withdrawn during confirmation: ${recheck?.reason ?? recheck?.status}`);
		}

		// From here the device may change: remember the job so a crash is reported as interrupted.
		writeFileSync(this.stateFile, JSON.stringify({ jobId: job.id, opCode: job.opCode, ...lease, at: new Date().toISOString() }), { mode: 0o600 });
		this.current = { job, destructive: spec.destructive, child: null };
		log(`Running: ${command.file} ${command.args.join(" ")}`);
		const result = await execute(command, logFile, {
			timeoutMs: (config.operationTimeoutMinutes?.[job.operation] ?? 120) * 60_000,
			onChild: (child) => {
				if (this.current) this.current.child = child;
			},
			onTick: async () => {
				try {
					const r = await this.client.report(job.id, "progress", { ...lease });
					if (r && r.proceed === false) log(`EmDash reports ${job.opCode} is ${r.status}. A running command is not interrupted.`);
				} catch (error) {
					log("heartbeat failed:", error.message);
				}
			},
		});
		const interrupted = this.stopping && !spec.destructive;
		this.current = null;

		const logText = redact(await readFile(logFile, "utf8").catch(() => ""));
		const observed = spec.readOnly && result.ok ? parseInventory(result.stdout, target.ecid) : undefined;
		const uploads = [{ kind: spec.evidence, filename: path.basename(logFile), contentType: "text/plain", bytes: Buffer.from(logText) }];
		if (observed) uploads.push({ kind: spec.evidence, filename: `${job.opCode}-${spec.evidence}.json`, contentType: "application/json", bytes: Buffer.from(JSON.stringify({ observed, command: command.args.join(" ") }, null, 2)) });
		// Evidence first, then the outcome: queued on disk, so a lost connection or a restart loses neither.
		for (const u of uploads) this.outbox.put({ type: "artifact", artifact: { jobId: job.id, leaseId: job.leaseId, ...u } });
		if (interrupted) {
			this.outbox.put({ type: "report", jobId: job.id, phase: "interrupted", extra: { ...lease, message: "Stopped by shutdown." } });
		} else if (!result.ok) {
			this.outbox.put({ type: "report", jobId: job.id, phase: "failed", extra: { ...lease, message: `cfgutil exited with ${result.code}`, result: { logTail: logText.slice(-LOG_TAIL) } } });
			log(`FAILED ${job.opCode}: cfgutil exited with ${result.code}`);
		} else {
			this.outbox.put({ type: "report", jobId: job.id, phase: "succeeded", extra: { ...lease, message: `${job.operation} completed`, observed, result: { logTail: logText.slice(-LOG_TAIL) } } });
			log(`Completed ${job.opCode}`);
		}
		rmSync(this.stateFile, { force: true });
		const waiting = await this.flush();
		if (waiting > 0) log(`${job.opCode}: result saved locally; it will be delivered when EmDash is reachable.`);
	}

	/**
	 * Safe shutdown: a running read-only command is stopped and reported as
	 * interrupted; a running destructive command is left to finish, because
	 * killing a restore can leave the device unusable.
	 */
	requestStop() {
		this.stopping = true;
		if (this.current && !this.current.destructive) this.current.child?.kill("SIGTERM");
		if (this.current?.destructive) log("A destructive command is running; the bridge will stop when it finishes.");
	}

	/** Optional: an MDM push sender (mdm.mjs apnsSender). Pushes are relayed every poll, independent of jobs. */
	setPushSender(send) {
		this.pushSender = send;
	}

	async relay() {
		if (!this.pushSender) return 0;
		const { relayPushes } = await import("./mdm.mjs");
		return relayPushes(this.client, this.pushSender, log);
	}

	async run({ intervalSeconds = 20, signal, health } = {}) {
		log(`Powerfarm bridge ${BRIDGE_VERSION} polling ${this.client.baseUrl} every ${intervalSeconds}s${this.config.simulate ? " (SIMULATION)" : ""}`);
		signal?.addEventListener("abort", () => this.requestStop());
		await this.recoverInFlight();
		let lastHealth = 0;
		while (!signal?.aborted) {
			if (health && Date.now() - lastHealth > 5 * 60_000) {
				lastHealth = Date.now();
				await health().catch((e) => log("health report failed:", e.message));
			}
			await this.relay().catch((e) => log("MDM push relay:", e.message));
			try {
				if (await this.tick()) continue;
			} catch (error) {
				log("poll error:", error.message);
			}
			await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
		}
	}
}
