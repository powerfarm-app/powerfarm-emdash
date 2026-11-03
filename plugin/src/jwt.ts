/**
 * Minimal RS256 JWTs with WebCrypto (Workers and Node): signing ID tokens for
 * the OIDC provider, and verifying Cloudflare Access assertions.
 */

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array | string): string {
	const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
	let s = "";
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
	const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
}

const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

export interface PrivateJwk extends JsonWebKey {
	kid: string;
}

/** A new RS256 signing key, exported as a private JWK (stored encrypted in plugin settings) with its kid. */
export async function generateSigningKey(): Promise<PrivateJwk> {
	const pair = (await crypto.subtle.generateKey({ ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ["sign", "verify"])) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
	const kid = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(String(jwk.n))))).slice(0, 16);
	return { ...jwk, kid, alg: "RS256", use: "sig" };
}

export function publicJwk(jwk: PrivateJwk): JsonWebKey & { kid: string } {
	return { kty: "RSA", n: jwk.n, e: jwk.e, kid: jwk.kid, alg: "RS256", use: "sig" };
}

export async function signJwt(payload: Record<string, unknown>, jwk: PrivateJwk): Promise<string> {
	const { kid, ...keyData } = jwk;
	const key = await crypto.subtle.importKey("jwk", { ...keyData, key_ops: ["sign"] }, ALG, false, ["sign"]);
	const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
	const body = b64url(JSON.stringify(payload));
	const sig = new Uint8Array(await crypto.subtle.sign(ALG, key, enc.encode(`${head}.${body}`)));
	return `${head}.${body}.${b64url(sig)}`;
}

export class JwtError extends Error {}

/** Verify an RS256 JWT against a key set; checks issuer, audience (one of), expiry and not-before. */
export async function verifyJwt(token: string, keys: Array<JsonWebKey & { kid?: string }>, expect: { issuer: string; audiences: string[]; now?: number; leewaySeconds?: number }): Promise<Record<string, unknown>> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new JwtError("Not a JWT");
	let header: { alg?: string; kid?: string };
	let payload: Record<string, unknown>;
	try {
		header = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]!)));
		payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]!)));
	} catch {
		throw new JwtError("Unreadable JWT");
	}
	if (header.alg !== "RS256") throw new JwtError("Only RS256 is accepted");
	const jwk = keys.find((k) => k.kid === header.kid) ?? (keys.length === 1 ? keys[0] : undefined);
	if (!jwk) throw new JwtError("Unknown signing key");
	const key = await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, ALG, false, ["verify"]);
	const ok = await crypto.subtle.verify(ALG, key, b64urlDecode(parts[2]!) as unknown as BufferSource, enc.encode(`${parts[0]}.${parts[1]}`));
	if (!ok) throw new JwtError("Bad signature");
	const now = expect.now ?? Math.floor(Date.now() / 1000);
	const leeway = expect.leewaySeconds ?? 60;
	if (payload.iss !== expect.issuer) throw new JwtError("Wrong issuer");
	const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	if (!aud.some((a) => expect.audiences.includes(String(a)))) throw new JwtError("Wrong audience");
	if (typeof payload.exp !== "number" || payload.exp + leeway < now) throw new JwtError("Expired");
	if (typeof payload.nbf === "number" && payload.nbf - leeway > now) throw new JwtError("Not yet valid");
	return payload;
}
