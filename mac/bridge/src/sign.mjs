// Request signing. Must match plugin/src/bridge-auth.ts exactly.
import { createHash, createHmac, randomBytes } from "node:crypto";

export const SIGNATURE_VERSION = "v1";
export const HEADER = {
	bridge: "x-powerfarm-bridge",
	timestamp: "x-powerfarm-timestamp",
	nonce: "x-powerfarm-nonce",
	signature: "x-powerfarm-signature",
};

export function sha256Hex(data) {
	return createHash("sha256").update(data).digest("hex");
}

export function canonicalString(timestamp, nonce, route, bodyHash) {
	return [SIGNATURE_VERSION, timestamp, nonce, route, bodyHash].join("\n");
}

export function signRequest({ bridgeId, secret, route, body, now = Date.now(), nonce = randomBytes(18).toString("base64url") }) {
	const timestamp = String(Math.floor(now / 1000));
	const signature = createHmac("sha256", secret).update(canonicalString(timestamp, nonce, route, sha256Hex(body))).digest("hex");
	return {
		[HEADER.bridge]: bridgeId,
		[HEADER.timestamp]: timestamp,
		[HEADER.nonce]: nonce,
		[HEADER.signature]: signature,
	};
}
