// The MDM wire: XML plists, and the device signature on every message
// (detached CMS, made here with openssl exactly as a device would sign).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseCertificate, pemToDer, SignatureError, verifyDetachedCms } from "../src/mdm/cms.ts";
import { buildPlist, parsePlist, parsePlistDict, PlistError } from "../src/mdm/plist.ts";

test("plists round-trip every type the MDM protocol uses, and refuse what it does not", () => {
	const v = { MessageType: "Authenticate", UDID: "00008110-000A", Count: 3, Big: 9007199254740993, Ratio: 1.5, Supervised: true, Lost: false, When: new Date("2026-11-03T09:00:00Z"), Token: new Uint8Array([1, 2, 250]), List: [{ a: "x & <y>" }, []], Empty: {} };
	const back = parsePlistDict(buildPlist(v as never));
	assert.equal(back.MessageType, "Authenticate");
	assert.equal(back.Count, 3);
	assert.equal(back.Ratio, 1.5);
	assert.equal(back.Supervised, true);
	assert.deepEqual([...(back.Token as Uint8Array)], [1, 2, 250]);
	assert.equal((back.When as Date).toISOString(), "2026-11-03T09:00:00.000Z");
	assert.equal(((back.List as never[])[0] as { a: string }).a, "x & <y>");
	assert.equal(parsePlistDict('<?xml version="1.0"?><plist version="1.0"><dict><key>Big</key><integer>9007199254740993</integer></dict></plist>').Big, "9007199254740993", "integers beyond 2^53 stay exact as strings");
	assert.throws(() => parsePlist("bplist00..."), PlistError);
	assert.throws(() => parsePlist('<!DOCTYPE plist [<!ENTITY x "y">]><plist><string>&x;</string></plist>'), PlistError, "no entity definitions");
	assert.throws(() => parsePlist("<plist><dict><key>__proto__</key><string>x</string></dict></plist>"), PlistError);
	assert.throws(() => parsePlist("<plist><dict><key>a</key></dict></plist>"), PlistError);
	assert.throws(() => parsePlist(`<plist>${"<array>".repeat(40)}${"</array>".repeat(40)}</plist>`), PlistError);
});

const ossl = (dir: string, ...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });

function pki(kind: "ec" | "rsa") {
	const dir = mkdtempSync(path.join(os.tmpdir(), `pf-mdm-${kind}-`));
	const key = (name: string) => (kind === "ec" ? ossl(dir, "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", name) : ossl(dir, "genrsa", "-out", name, "2048"));
	key("ca.key");
	ossl(dir, "req", "-x509", "-new", "-key", "ca.key", "-subj", "/CN=Powerfarm Device CA", "-days", "3650", "-out", "ca.pem", "-addext", "basicConstraints=critical,CA:TRUE");
	key("dev.key");
	ossl(dir, "req", "-new", "-key", "dev.key", "-subj", "/CN=00008110-000A1B2C3D4E5F6A", "-out", "dev.csr");
	ossl(dir, "x509", "-req", "-in", "dev.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "825", "-out", "dev.pem");
	return dir;
}

function sign(dir: string, body: string, signer = "dev") {
	writeFileSync(path.join(dir, "body.plist"), body);
	ossl(dir, "cms", "-sign", "-binary", "-md", "sha256", "-in", "body.plist", "-signer", `${signer}.pem`, "-inkey", `${signer}.key`, "-outform", "DER", "-out", "sig.der");
	return readFileSync(path.join(dir, "sig.der")).toString("base64");
}

const body = buildPlist({ MessageType: "Authenticate", Topic: "com.apple.mgmt.External.x", UDID: "00008110-000A1B2C3D4E5F6A" });
const bytes = new TextEncoder().encode(body);

for (const kind of ["ec", "rsa"] as const) {
	test(`a ${kind.toUpperCase()} device signature from the Powerfarm CA verifies and identifies the certificate`, async () => {
		const dir = pki(kind);
		const ca = parseCertificate(pemToDer(readFileSync(path.join(dir, "ca.pem"), "utf8")));
		assert.equal(ca.isCA, true);
		const v = await verifyDetachedCms(sign(dir, body), bytes, ca);
		assert.equal(v.certificate.subjectCN, "00008110-000A1B2C3D4E5F6A");
		assert.match(v.fingerprint, /^[0-9a-f]{64}$/);
	});
}

test("a changed message, a certificate from another CA, an expired certificate and garbage are all refused", async () => {
	const dir = pki("ec");
	const ca = parseCertificate(pemToDer(readFileSync(path.join(dir, "ca.pem"), "utf8")));
	const sig = sign(dir, body);
	const code = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as SignatureError | null)?.code;

	assert.equal(await code(verifyDetachedCms(sig, new TextEncoder().encode(body.replace("Authenticate", "TokenUpdate")), ca)), "DIGEST_MISMATCH");

	const other = pki("ec");
	const otherSig = sign(other, body);
	assert.equal(await code(verifyDetachedCms(otherSig, bytes, ca)), "UNTRUSTED_SIGNER", "a self-made identity from another CA is not a Powerfarm device");

	assert.equal(await code(verifyDetachedCms(sig, bytes, ca, new Date("2040-01-01T00:00:00Z"))), "UNTRUSTED_SIGNER", "expired");
	assert.equal(await code(verifyDetachedCms("bm90IGNtcw==", bytes, ca)), "MALFORMED");

	// A signature that carries the message inside (not detached) is refused.
	writeFileSync(path.join(dir, "body.plist"), body);
	ossl(dir, "cms", "-sign", "-binary", "-nodetach", "-in", "body.plist", "-signer", "dev.pem", "-inkey", "dev.key", "-outform", "DER", "-out", "att.der");
	assert.equal(await code(verifyDetachedCms(readFileSync(path.join(dir, "att.der")).toString("base64"), bytes, ca)), "NOT_DETACHED");
});
