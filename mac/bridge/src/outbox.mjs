// Results that must reach EmDash, kept on disk until it has accepted them.
//
// The lab's connection is less available than Cloudflare. A job's evidence and
// its final report are written here first, then delivered in order; if the
// connection is down they wait (across restarts) and are retried. Each report
// keeps the reportId it was given when it was written, so a retry after a lost
// response is recognised by EmDash as the same report.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** EmDash answered and refused: retrying the same request cannot succeed. */
const PERMANENT = new Set([400, 404, 409, 410, 413, 422]);
/**
 * 403s that are about the job, not about this bridge's credentials: the lease
 * expired and was released while the lab was offline. Credential and address
 * refusals (BRIDGE_DISABLED, FORBIDDEN_SOURCE, 401s) stay queued: once fixed,
 * the results are still delivered.
 */
const PERMANENT_CODES = new Set(["NOT_YOUR_JOB"]);

export function isPermanent(error) {
	return typeof error?.status === "number" && (PERMANENT.has(error.status) || PERMANENT_CODES.has(error.code));
}

export class Outbox {
	constructor(dir) {
		this.dir = dir;
		this.rejectedDir = path.join(dir, "rejected");
		mkdirSync(this.rejectedDir, { recursive: true, mode: 0o700 });
		this.seq = 0;
	}

	/** Persist one delivery. `item` is a report ({type, jobId, phase, extra}) or an artifact ({type, artifact}). */
	put(item) {
		const stored = item.type === "report" ? { ...item, extra: { reportId: `rep_${randomUUID()}`, ...item.extra } } : { ...item, artifact: { ...item.artifact, bytes: Buffer.from(item.artifact.bytes).toString("base64") } };
		const name = `${String(Date.now()).padStart(15, "0")}-${String(this.seq++).padStart(6, "0")}-${randomUUID().slice(0, 8)}.json`;
		const tmp = path.join(this.dir, `.${name}.tmp`);
		writeFileSync(tmp, JSON.stringify({ ...stored, queuedAt: new Date().toISOString() }), { mode: 0o600 });
		renameSync(tmp, path.join(this.dir, name));
		return name;
	}

	pending() {
		if (!existsSync(this.dir)) return [];
		return readdirSync(this.dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort();
	}

	rejected() {
		return existsSync(this.rejectedDir) ? readdirSync(this.rejectedDir).filter((f) => f.endsWith(".json")).sort() : [];
	}

	/** Jobs with a final report still waiting to be delivered. */
	jobsWithFinalReport() {
		const out = new Set();
		for (const f of this.pending()) {
			try {
				const item = JSON.parse(readFileSync(path.join(this.dir, f), "utf8"));
				if (item.type === "report" && item.phase !== "progress" && item.phase !== "started") out.add(item.jobId);
			} catch {
				/* unreadable: drain() sets it aside */
			}
		}
		return out;
	}

	/**
	 * Deliver in order. Stops at the first delivery that could not reach EmDash
	 * (it stays queued); a delivery EmDash refused is moved to rejected/ for a
	 * person to look at. Returns how many are still queued.
	 */
	async drain(client, log = () => {}) {
		for (const f of this.pending()) {
			const file = path.join(this.dir, f);
			let item;
			try {
				item = JSON.parse(readFileSync(file, "utf8"));
			} catch {
				renameSync(file, path.join(this.rejectedDir, f));
				log(`outbox: ${f} is unreadable; moved to rejected/`);
				continue;
			}
			try {
				// oxlint-disable-next-line no-await-in-loop -- deliveries are ordered: evidence before the report that needs it
				if (item.type === "report") await client.report(item.jobId, item.phase, item.extra);
				else await client.uploadArtifact({ ...item.artifact, bytes: Buffer.from(item.artifact.bytes, "base64") });
				rmSync(file, { force: true });
			} catch (error) {
				if (isPermanent(error)) {
					writeFileSync(path.join(this.rejectedDir, f), JSON.stringify({ ...item, rejectedAt: new Date().toISOString(), error: error.message }), { mode: 0o600 });
					rmSync(file, { force: true });
					log(`outbox: EmDash refused ${item.type} ${item.phase ?? item.artifact?.kind} for ${item.jobId ?? item.artifact?.jobId}: ${error.message}. Kept in ${this.rejectedDir}.`);
					continue;
				}
				log(`outbox: EmDash not reachable (${error.message}); ${this.pending().length} delivery(ies) wait and will be retried.`);
				break;
			}
		}
		return this.pending().length;
	}
}
