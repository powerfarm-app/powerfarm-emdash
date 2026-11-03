// Signed calls to the Powerfarm plugin routes on EmDash.
import { randomUUID } from "node:crypto";

import { sha256Hex, signRequest } from "./sign.mjs";

const MAX_RESPONSE_BYTES = 512 * 1024;

/** Must match plugin/src/bridge.ts `artifactSignedRoute`. */
export function artifactRoute({ jobId, leaseId, kind, sha256, contentType, filename }) {
	return ["powerfarm/bridge/artifact", jobId, leaseId, kind, sha256, contentType, filename].join("|");
}

export class EmDashClient {
	/**
	 * `access` is a Cloudflare Access service token ({ clientId, clientSecret }).
	 * When EmDash runs on Cloudflare behind Access, every bridge request carries
	 * it; Access rejects anything else before it reaches the Worker.
	 */
	constructor({ baseUrl, bridgeId, secret, access = null, fetchImpl = globalThis.fetch, timeoutMs = 30_000 }) {
		if (!baseUrl || !bridgeId || !secret) throw new Error("baseUrl, bridgeId and secret are required");
		if (secret.length < 32) throw new Error("The bridge secret must be at least 32 characters");
		const url = new URL(baseUrl);
		const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname) || /\.(internal|local|lan)$/.test(url.hostname) || !url.hostname.includes(".");
		if (url.protocol !== "https:" && !local) throw new Error("emdashUrl must be https:// unless it is a private address");
		if (access && (!access.clientId || !access.clientSecret)) throw new Error("A Cloudflare Access service token needs clientId and clientSecret");
		this.access = access;
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.bridgeId = bridgeId;
		this.secret = secret;
		this.fetch = fetchImpl;
		this.timeoutMs = timeoutMs;
	}

	async send(name, body, headers, signedRoute) {
		const signature = signRequest({ bridgeId: this.bridgeId, secret: this.secret, route: signedRoute, body });
		const accessHeaders = this.access ? { "cf-access-client-id": this.access.clientId, "cf-access-client-secret": this.access.clientSecret } : {};
		const response = await this.fetch(`${this.baseUrl}/_emdash/api/plugins/powerfarm/${name}`, {
			method: "POST",
			headers: { ...headers, ...accessHeaders, ...signature },
			body,
			// Access answers an unauthenticated request with a redirect to its login page: never follow it.
			redirect: "manual",
			signal: AbortSignal.timeout(this.timeoutMs),
		});
		const text = await response.text();
		// Refused at Cloudflare's edge (not by EmDash): a configuration problem, kept as retryable so no result is dropped.
		const edge = (response.status >= 300 && response.status < 400) || ((response.status === 401 || response.status === 403) && !/^\s*\{/.test(text));
		if (edge) throw new Error(`Cloudflare Access refused ${name} (HTTP ${response.status}). Check the service token in the bridge config and the Access policy for the bridge path.`);
		if (text.length > MAX_RESPONSE_BYTES) throw new Error(`EmDash response for ${name} is too large`);
		let json;
		try {
			json = JSON.parse(text);
		} catch {
			throw new Error(`EmDash returned ${response.status} with a non-JSON body for ${name}`);
		}
		if (!response.ok || json?.success === false) {
			const code = json?.error?.code ?? response.status;
			throw Object.assign(new Error(`EmDash rejected ${name}: ${code} ${json?.error?.message ?? ""}`.trim()), { code, status: response.status });
		}
		return json && typeof json === "object" && "data" in json ? json.data : json;
	}

	call(name, payload) {
		return this.send(name, JSON.stringify(payload ?? {}), { "content-type": "application/json" }, `powerfarm/${name}`);
	}

	claim(request) {
		return this.call("bridge/claim", request);
	}

	check(jobId, leaseId) {
		return this.call("bridge/check", { jobId, leaseId });
	}

	/** `extra` carries leaseId and opRevision; a fresh reportId makes the report idempotent across retries. */
	report(jobId, phase, extra = {}) {
		return this.call("bridge/report", { jobId, phase, reportId: extra.reportId ?? `rep_${randomUUID()}`, ...extra });
	}

	health(payload) {
		return this.call("bridge/health", payload);
	}

	uploadArtifact({ jobId, leaseId, kind, filename, contentType, bytes }) {
		const sha256 = sha256Hex(bytes);
		const safeName = String(filename).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
		const headers = {
			"content-type": contentType,
			"x-powerfarm-job": jobId,
			"x-powerfarm-lease": leaseId,
			"x-powerfarm-kind": kind,
			"x-powerfarm-filename": safeName,
			"x-powerfarm-sha256": sha256,
		};
		return this.send("bridge/artifact", bytes, headers, artifactRoute({ jobId, leaseId, kind, sha256, contentType, filename: safeName }));
	}
}
