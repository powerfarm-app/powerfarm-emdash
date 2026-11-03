/**
 * Request signing between EmDash and the Apple Hardware Bridge.
 *
 * The bridge routes are EmDash plugin routes marked `public`, because EmDash
 * only lets an API token call plugin routes when it carries the full `admin`
 * scope. Rather than give the Mac an admin token, each bridge request is signed
 * with a shared secret that lives encrypted in this plugin's EmDash settings.
 *
 * Canonical string (UTF-8), joined with "\n":
 *   v1, <unix seconds>, <nonce>, <route>, <sha256 hex of the raw body>
 * Signature: hex(HMAC-SHA256(secret, canonical)).
 *
 * The bridge client (bridge/src/sign.mjs) implements the same format.
 */

export const SIGNATURE_VERSION = "v1";
export const MAX_CLOCK_SKEW_SECONDS = 300;
export const HEADER = {
	bridge: "x-powerfarm-bridge",
	timestamp: "x-powerfarm-timestamp",
	nonce: "x-powerfarm-nonce",
	signature: "x-powerfarm-signature",
} as const;

const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(body: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
}

export async function sha256HexBytes(body: Uint8Array): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", new Uint8Array(body)));
}

export function canonicalString(timestamp: string, nonce: string, route: string, bodyHash: string): string {
	return [SIGNATURE_VERSION, timestamp, nonce, route, bodyHash].join("\n");
}

export async function sign(secret: string, canonical: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical)));
}

function timingSafeEqualHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export type VerifyFailure =
	| "NOT_CONFIGURED"
	| "MISSING_HEADERS"
	| "UNKNOWN_BRIDGE"
	| "CLOCK_SKEW"
	| "BAD_NONCE"
	| "BAD_SIGNATURE"
	| "REPLAYED";

export interface VerifyInput {
	headers: Headers;
	route: string;
	/** Raw body exactly as received: text for JSON routes, bytes for artifact uploads. */
	body: string | Uint8Array;
	expectedBridgeId: string | null;
	/** The current secret. */
	secret: string | null;
	/** During rotation: the next secret, also accepted until it replaces the current one. */
	nextSecret?: string | null;
	nowSeconds?: number;
	/** Returns true if the nonce was unused and has now been recorded. */
	claimNonce: (nonce: string, timestamp: number) => Promise<boolean>;
}

export async function verifyBridgeRequest(input: VerifyInput): Promise<{ ok: true; bridgeId: string } | { ok: false; reason: VerifyFailure }> {
	const secrets = [input.secret, input.nextSecret].filter((s): s is string => typeof s === "string" && s.length >= 32);
	if (secrets.length === 0 || !input.expectedBridgeId) return { ok: false, reason: "NOT_CONFIGURED" };
	const bridgeId = input.headers.get(HEADER.bridge);
	const timestamp = input.headers.get(HEADER.timestamp);
	const nonce = input.headers.get(HEADER.nonce);
	const signature = input.headers.get(HEADER.signature);
	if (!bridgeId || !timestamp || !nonce || !signature) return { ok: false, reason: "MISSING_HEADERS" };
	if (bridgeId !== input.expectedBridgeId) return { ok: false, reason: "UNKNOWN_BRIDGE" };
	if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return { ok: false, reason: "BAD_NONCE" };
	const ts = Number(timestamp);
	const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
	if (!Number.isInteger(ts) || Math.abs(now - ts) > MAX_CLOCK_SKEW_SECONDS) return { ok: false, reason: "CLOCK_SKEW" };

	const canonical = canonicalString(timestamp, nonce, input.route, typeof input.body === "string" ? await sha256Hex(input.body) : await sha256HexBytes(input.body));
	let valid = false;
	for (const secret of secrets) {
		// oxlint-disable-next-line no-await-in-loop -- at most two secrets
		if (timingSafeEqualHex(await sign(secret, canonical), signature.toLowerCase())) valid = true;
	}
	if (!valid) return { ok: false, reason: "BAD_SIGNATURE" };
	// Record the nonce only after the signature checks out, so unsigned traffic cannot fill the store.
	if (!(await input.claimNonce(nonce, ts))) return { ok: false, reason: "REPLAYED" };
	return { ok: true, bridgeId };
}

/**
 * The signed "route" for artifact uploads binds the metadata headers into the
 * signature, so job, lease, kind, digest, type and filename cannot be altered in
 * transit. Must match bridge/src/client.mjs `artifactRoute`.
 */
export function artifactSignedRoute(h: Headers): string {
	return [
		"powerfarm/bridge/artifact",
		h.get("x-powerfarm-job") ?? "",
		h.get("x-powerfarm-lease") ?? "",
		h.get("x-powerfarm-kind") ?? "",
		h.get("x-powerfarm-sha256") ?? "",
		h.get("content-type") ?? "",
		h.get("x-powerfarm-filename") ?? "",
	].join("|");
}
