/**
 * Verifies the `Mdm-Signature` header Apple devices send with every MDM
 * message: a detached CMS SignedData (RFC 5652), signed with the device
 * identity whose certificate was issued by the Powerfarm device CA during
 * enrolment (on the lab Mac; the CA's private key never reaches Cloudflare).
 *
 * Only WebCrypto is used, so it runs in a Cloudflare Worker and in Node. The
 * DER reader below accepts BER indefinite lengths too, because some CMS
 * producers emit them for the outer structure.
 *
 * What a successful verification establishes: the body was signed by the
 * holder of a key whose certificate the Powerfarm CA issued, and that
 * certificate is within its validity period. Binding that certificate to one
 * device (UDID) is the protocol layer's job (protocol.ts).
 */

export class SignatureError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// DER / BER reading
// ---------------------------------------------------------------------------

export interface Tlv {
	tag: number; // the full identifier octet (class + constructed + number); multi-byte tags are refused
	start: number; // offset of the identifier octet
	contentStart: number;
	contentEnd: number; // exclusive
	end: number; // exclusive, including any end-of-contents octets
}

function fail(message: string): never {
	throw new SignatureError("MALFORMED", message);
}

export function readTlv(b: Uint8Array, at: number, limit = b.length, depth = 0): Tlv {
	if (depth > 40) fail("ASN.1 nested too deeply");
	if (at + 2 > limit) fail("ASN.1 truncated");
	const tag = b[at]!;
	if ((tag & 0x1f) === 0x1f) fail("Multi-byte ASN.1 tags are not supported");
	let p = at + 1;
	let len = b[p++]!;
	if (len === 0x80) {
		if (!(tag & 0x20)) fail("Indefinite length on a primitive value");
		let q = p;
		for (;;) {
			if (q + 2 > limit) fail("Unterminated indefinite length");
			if (b[q] === 0 && b[q + 1] === 0) return { tag, start: at, contentStart: p, contentEnd: q, end: q + 2 };
			q = readTlv(b, q, limit, depth + 1).end;
		}
	}
	if (len & 0x80) {
		const n = len & 0x7f;
		if (n === 0 || n > 4 || p + n > limit) fail("Bad ASN.1 length");
		len = 0;
		for (let k = 0; k < n; k++) len = len * 256 + b[p++]!;
	}
	if (p + len > limit) fail("ASN.1 value runs past its container");
	return { tag, start: at, contentStart: p, contentEnd: p + len, end: p + len };
}

export function children(b: Uint8Array, t: Tlv): Tlv[] {
	const out: Tlv[] = [];
	for (let p = t.contentStart; p < t.contentEnd; ) {
		const c = readTlv(b, p, t.contentEnd);
		out.push(c);
		p = c.end;
	}
	return out;
}

const content = (b: Uint8Array, t: Tlv) => b.subarray(t.contentStart, t.contentEnd);
const whole = (b: Uint8Array, t: Tlv) => b.subarray(t.start, t.end);

export function oid(b: Uint8Array, t: Tlv): string {
	if (t.tag !== 0x06) fail("Expected an OBJECT IDENTIFIER");
	const c = content(b, t);
	const parts: number[] = [];
	let v = 0;
	for (let k = 0; k < c.length; k++) {
		v = v * 128 + (c[k]! & 0x7f);
		if (!(c[k]! & 0x80)) {
			if (parts.length === 0) parts.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80);
			else parts.push(v);
			v = 0;
		}
	}
	return parts.join(".");
}

function expect(t: Tlv | undefined, tag: number, what: string): Tlv {
	if (!t || t.tag !== tag) fail(`Expected ${what}`);
	return t;
}

const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, k) => x === b[k]);
const hex = (a: Uint8Array) => Array.from(a, (x) => x.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------------------
// Certificates
// ---------------------------------------------------------------------------

export interface Certificate {
	der: Uint8Array;
	tbs: Uint8Array;
	signatureAlgorithm: string;
	signature: Uint8Array;
	serial: Uint8Array;
	issuer: Uint8Array; // DER of the Name
	subject: Uint8Array;
	subjectCN: string | null;
	notBefore: Date;
	notAfter: Date;
	spki: Uint8Array;
	keyAlgorithm: string;
	namedCurve: string | null;
	subjectKeyId: Uint8Array | null;
	isCA: boolean;
}

function parseTime(b: Uint8Array, t: Tlv): Date {
	const s = new TextDecoder().decode(content(b, t));
	let m: RegExpMatchArray | null;
	if (t.tag === 0x17 && (m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
		const y = Number(m[1]);
		return new Date(Date.UTC(y < 50 ? 2000 + y : 1900 + y, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
	}
	if (t.tag === 0x18 && (m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
		return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
	}
	fail("Unsupported certificate time");
}

function commonName(b: Uint8Array, name: Tlv): string | null {
	for (const rdn of children(b, name)) {
		for (const atv of children(b, rdn)) {
			const [type, val] = children(b, atv);
			if (type && val && oid(b, type) === "2.5.4.3") return new TextDecoder().decode(content(b, val));
		}
	}
	return null;
}

export function parseCertificate(der: Uint8Array): Certificate {
	const cert = expect(readTlv(der, 0), 0x30, "a certificate");
	const [tbsT, algT, sigT] = children(der, cert);
	expect(tbsT, 0x30, "tbsCertificate");
	const alg = oid(der, children(der, expect(algT, 0x30, "signatureAlgorithm"))[0]!);
	const sigBits = content(der, expect(sigT, 0x03, "signatureValue"));
	let f = children(der, tbsT!);
	if (f[0]!.tag === 0xa0) f = f.slice(1); // version
	const serial = content(der, expect(f[0], 0x02, "serialNumber"));
	const issuer = expect(f[2], 0x30, "issuer");
	const validity = children(der, expect(f[3], 0x30, "validity"));
	const subject = expect(f[4], 0x30, "subject");
	const spkiT = expect(f[5], 0x30, "subjectPublicKeyInfo");
	const spkiAlg = children(der, children(der, spkiT)[0]!);
	const keyAlgorithm = oid(der, spkiAlg[0]!);
	const namedCurve = keyAlgorithm === "1.2.840.10045.2.1" && spkiAlg[1]?.tag === 0x06 ? oid(der, spkiAlg[1]) : null;
	let subjectKeyId: Uint8Array | null = null;
	let isCA = false;
	const extWrap = f.slice(6).find((x) => x.tag === 0xa3);
	if (extWrap) {
		for (const ext of children(der, children(der, extWrap)[0]!)) {
			const parts = children(der, ext);
			const id = oid(der, parts[0]!);
			const valueT = parts.at(-1)!;
			const inner = content(der, valueT);
			if (id === "2.5.29.14") subjectKeyId = content(inner, readTlv(inner, 0)).slice();
			if (id === "2.5.29.19") {
				const bc = readTlv(inner, 0);
				const first = children(inner, bc)[0];
				isCA = !!first && first.tag === 0x01 && inner[first.contentStart] !== 0;
			}
		}
	}
	return {
		der,
		tbs: whole(der, tbsT!),
		signatureAlgorithm: alg,
		signature: sigBits.subarray(1), // skip the unused-bits octet
		serial,
		issuer: whole(der, issuer),
		subject: whole(der, subject),
		subjectCN: commonName(der, subject),
		notBefore: parseTime(der, validity[0]!),
		notAfter: parseTime(der, validity[1]!),
		spki: whole(der, spkiT),
		keyAlgorithm,
		namedCurve,
		subjectKeyId,
		isCA,
	};
}

export function pemToDer(pem: string): Uint8Array {
	const m = pem.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
	if (!m) throw new SignatureError("BAD_CA", "Not a PEM certificate");
	const bin = atob(m[1]!.replace(/\s+/g, ""));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------

const DIGESTS: Record<string, string> = {
	"1.3.14.3.2.26": "SHA-1",
	"2.16.840.1.101.3.4.2.1": "SHA-256",
	"2.16.840.1.101.3.4.2.2": "SHA-384",
	"2.16.840.1.101.3.4.2.3": "SHA-512",
};
const SIGNATURES: Record<string, { kind: "rsa" | "ecdsa"; hash: string | null }> = {
	"1.2.840.113549.1.1.1": { kind: "rsa", hash: null }, // rsaEncryption: hash from the digest algorithm
	"1.2.840.113549.1.1.5": { kind: "rsa", hash: "SHA-1" },
	"1.2.840.113549.1.1.11": { kind: "rsa", hash: "SHA-256" },
	"1.2.840.113549.1.1.12": { kind: "rsa", hash: "SHA-384" },
	"1.2.840.113549.1.1.13": { kind: "rsa", hash: "SHA-512" },
	"1.2.840.10045.4.1": { kind: "ecdsa", hash: "SHA-1" },
	"1.2.840.10045.4.3.2": { kind: "ecdsa", hash: "SHA-256" },
	"1.2.840.10045.4.3.3": { kind: "ecdsa", hash: "SHA-384" },
	"1.2.840.10045.4.3.4": { kind: "ecdsa", hash: "SHA-512" },
	"1.2.840.10045.2.1": { kind: "ecdsa", hash: null }, // id-ecPublicKey used as signature algorithm
};
const CURVES: Record<string, { name: string; size: number }> = {
	"1.2.840.10045.3.1.7": { name: "P-256", size: 32 },
	"1.3.132.0.34": { name: "P-384", size: 48 },
	"1.3.132.0.35": { name: "P-521", size: 66 },
};

function ecdsaDerToRaw(sig: Uint8Array, size: number): Uint8Array {
	const seq = expect(readTlv(sig, 0), 0x30, "an ECDSA signature");
	const [r, s] = children(sig, seq).map((t) => content(sig, t));
	const out = new Uint8Array(size * 2);
	const put = (v: Uint8Array, offset: number) => {
		let x = v;
		while (x.length > size && x[0] === 0) x = x.subarray(1);
		if (x.length > size) fail("ECDSA value too long");
		out.set(x, offset + size - x.length);
	};
	put(r!, 0);
	put(s!, size);
	return out;
}

/** WebCrypto's typings want ArrayBuffer-backed views; ours always are. */
const buf = (u: Uint8Array) => u as unknown as BufferSource;

async function verifyWith(cert: Certificate, algorithm: string, digestHash: string | null, signature: Uint8Array, data: Uint8Array): Promise<boolean> {
	const spec = SIGNATURES[algorithm];
	if (!spec) throw new SignatureError("UNSUPPORTED_ALGORITHM", `Signature algorithm ${algorithm} is not supported`);
	const hash = spec.hash ?? digestHash;
	if (!hash) throw new SignatureError("UNSUPPORTED_ALGORITHM", "No hash for the signature");
	const subtle = globalThis.crypto.subtle;
	if (spec.kind === "rsa") {
		if (cert.keyAlgorithm !== "1.2.840.113549.1.1.1") return false;
		const key = await subtle.importKey("spki", buf(cert.spki), { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
		return subtle.verify("RSASSA-PKCS1-v1_5", key, buf(signature), buf(data));
	}
	const curve = cert.namedCurve ? CURVES[cert.namedCurve] : undefined;
	if (cert.keyAlgorithm !== "1.2.840.10045.2.1" || !curve) return false;
	const key = await subtle.importKey("spki", buf(cert.spki), { name: "ECDSA", namedCurve: curve.name }, false, ["verify"]);
	return subtle.verify({ name: "ECDSA", hash }, key, buf(ecdsaDerToRaw(signature, curve.size)), buf(data));
}

async function digest(hash: string, data: Uint8Array): Promise<Uint8Array> {
	return new Uint8Array(await globalThis.crypto.subtle.digest(hash, buf(data)));
}

export interface VerifiedSigner {
	certificate: Certificate;
	/** SHA-256 of the signer certificate, hex: what the protocol layer binds to a device. */
	fingerprint: string;
}

/** Is `cert` issued by `ca` (name match and a valid signature) and within its validity at `now`? */
export async function issuedBy(cert: Certificate, ca: Certificate, now: Date): Promise<boolean> {
	if (!equalBytes(cert.issuer, ca.subject)) return false;
	if (now < cert.notBefore || now > cert.notAfter) return false;
	return verifyWith(ca, cert.signatureAlgorithm, null, cert.signature, cert.tbs);
}

/**
 * Verify a detached CMS signature over `body`. `signatureB64` is the
 * `Mdm-Signature` header value. Throws SignatureError unless the signature is
 * valid and made with a certificate the CA issued.
 */
export async function verifyDetachedCms(signatureB64: string, body: Uint8Array, caCertificate: Certificate, now = new Date()): Promise<VerifiedSigner> {
	let cms: Uint8Array;
	try {
		cms = Uint8Array.from(atob(signatureB64.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
	} catch {
		throw new SignatureError("MALFORMED", "Mdm-Signature is not base64");
	}
	const ci = expect(readTlv(cms, 0), 0x30, "ContentInfo");
	const [typeT, wrapT] = children(cms, ci);
	if (oid(cms, typeT!) !== "1.2.840.113549.1.7.2") fail("Not a CMS SignedData");
	const sd = expect(children(cms, expect(wrapT, 0xa0, "[0] content"))[0], 0x30, "SignedData");
	const parts = children(cms, sd);
	const encap = children(cms, expect(parts[2], 0x30, "encapContentInfo"));
	if (encap.length > 1) throw new SignatureError("NOT_DETACHED", "The signature must be detached from the message");
	const certs = (parts.find((p) => p.tag === 0xa0) ? children(cms, parts.find((p) => p.tag === 0xa0)!) : []).map((t) => parseCertificate(whole(cms, t).slice()));
	const signerInfos = children(cms, expect(parts.at(-1), 0x31, "signerInfos"));
	if (signerInfos.length !== 1) throw new SignatureError("SIGNERS", "Exactly one signer is expected");
	const si = children(cms, signerInfos[0]!);
	const sid = si[1]!;
	const signer = certs.find((c) => {
		if (sid.tag === 0x30) {
			const [issuer, serial] = children(cms, sid);
			return equalBytes(whole(cms, issuer!), c.issuer) && equalBytes(content(cms, serial!), c.serial);
		}
		return sid.tag === 0x80 && !!c.subjectKeyId && equalBytes(content(cms, sid), c.subjectKeyId);
	});
	if (!signer) throw new SignatureError("NO_SIGNER_CERT", "The signer's certificate is not in the signature");
	const digestAlg = DIGESTS[oid(cms, children(cms, si[2]!)[0]!)];
	if (!digestAlg) throw new SignatureError("UNSUPPORTED_ALGORITHM", "Unsupported digest algorithm");
	let k = 3;
	let signedData = body;
	if (si[k]?.tag === 0xa0) {
		const attrsT = si[k]!;
		let messageDigest: Uint8Array | null = null;
		for (const attr of children(cms, attrsT)) {
			const [type, values] = children(cms, attr);
			if (oid(cms, type!) === "1.2.840.113549.1.9.4") messageDigest = content(cms, children(cms, values!)[0]!);
		}
		if (!messageDigest) throw new SignatureError("MALFORMED", "Signed attributes lack the message digest");
		if (!equalBytes(messageDigest, await digest(digestAlg, body))) throw new SignatureError("DIGEST_MISMATCH", "The message does not match its signature");
		// The signature covers the attributes encoded as a SET (tag 0x31), not as [0].
		signedData = whole(cms, attrsT).slice();
		signedData[0] = 0x31;
		k++;
	}
	const sigAlg = oid(cms, children(cms, si[k]!)[0]!);
	const signature = content(cms, expect(si[k + 1], 0x04, "signature"));
	if (!(await verifyWith(signer, sigAlg, digestAlg, signature, signedData))) throw new SignatureError("BAD_SIGNATURE", "The signature does not verify");
	if (!(await issuedBy(signer, caCertificate, now))) throw new SignatureError("UNTRUSTED_SIGNER", "The signing certificate was not issued by the Powerfarm device CA, or has expired");
	return { certificate: signer, fingerprint: hex(await digest("SHA-256", signer.der)) };
}

export { hex as toHex };
