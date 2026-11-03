// The bridge's MDM duties: the device CA, per-device identities, enrolment
// profiles, and relaying pushes to Apple over HTTP/2 with the push certificate.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ACCESS_RIGHTS, apnsRequest, apnsSender, enrolmentProfile, initCa, issueIdentity, relayPushes } from "../src/mdm.mjs";

const UDID = "00008110-000A1B2C3D4E5F6A";
const TOPIC = "com.apple.mgmt.External.11111111-2222-3333-4444-555555555555";
const ossl = (cwd, ...args) => execFileSync("openssl", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();

test("the device CA is created once, its key private to the user; replacing it is refused", () => {
	const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "pf-ca-")), "mdm-ca");
	const pem = initCa(dir);
	assert.match(pem, /BEGIN CERTIFICATE/);
	assert.equal(statSync(path.join(dir, "ca.key")).mode & 0o077, 0);
	assert.match(ossl(dir, "x509", "-in", "ca.pem", "-noout", "-text"), /CA:TRUE/);
	assert.throws(() => initCa(dir), /already holds a CA/);
});

test("each device gets its own identity, named by its UDID and signed by the CA; the private key is not left on disk", () => {
	const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "pf-ca-")), "mdm-ca");
	initCa(dir);
	const id = issueIdentity(dir, UDID.toLowerCase());
	assert.match(id.certPem, /BEGIN CERTIFICATE/);
	const work = path.join(dir, "issued", UDID);
	assert.match(ossl(work, "x509", "-in", "device.pem", "-noout", "-subject"), new RegExp(UDID));
	assert.match(ossl(dir, "verify", "-CAfile", "ca.pem", path.join(work, "device.pem")), /OK/);
	assert.equal(existsSync(path.join(work, "device.key")), false);
	writeFileSync(path.join(work, "check.p12"), id.p12);
	assert.match(ossl(work, "pkcs12", "-in", "check.p12", "-passin", `pass:${id.password}`, "-nokeys"), new RegExp(UDID), "the identity opens with its password");
	assert.throws(() => issueIdentity(dir, "not a udid"), /not a UDID/);
});

test("the enrolment profile points at Powerfarm over https, with this push topic, and grants no erase or lock", () => {
	const dir = path.join(mkdtempSync(path.join(os.tmpdir(), "pf-ca-")), "mdm-ca");
	initCa(dir);
	const xml = enrolmentProfile({ emdashUrl: "https://powerfarm.example.com/", topic: TOPIC, udid: UDID, identity: issueIdentity(dir, UDID) });
	assert.match(xml, /<string>https:\/\/powerfarm\.example\.com\/_emdash\/api\/plugins\/powerfarm\/mdm\/connect<\/string>/);
	assert.match(xml, /<string>https:\/\/powerfarm\.example\.com\/_emdash\/api\/plugins\/powerfarm\/mdm\/checkin<\/string>/);
	assert.match(xml, new RegExp(`<key>AccessRights</key>\\s*<integer>${ACCESS_RIGHTS}</integer>`));
	assert.equal(ACCESS_RIGHTS & 8, 0, "no erase");
	assert.equal(ACCESS_RIGHTS & 4, 0, "no lock or passcode removal");
	assert.match(xml, /<key>SignMessage<\/key>\s*<true\/>/);
	const ids = [...xml.matchAll(/<key>(?:PayloadUUID|IdentityCertificateUUID)<\/key>\s*<string>([^<]+)<\/string>/g)].map((m) => m[1]);
	assert.ok(ids.filter((x, i) => ids.indexOf(x) !== i).length === 1, "the MDM payload names the identity payload");
	assert.throws(() => enrolmentProfile({ emdashUrl: "http://powerfarm.example.com", topic: TOPIC, udid: UDID, identity: { p12: new Uint8Array(), password: "x" } }), /https/);
	assert.throws(() => enrolmentProfile({ emdashUrl: "https://p.example.com", topic: "com.example.push", udid: UDID, identity: { p12: new Uint8Array(), password: "x" } }), /push topic/);
});

test("pushes are relayed: claimed from Powerfarm, sent as MDM pushes, and Apple's answers reported back", async () => {
	assert.deepEqual(apnsRequest({ token: "deadbeef00112233", topic: TOPIC, pushMagic: "m" }).headers["apns-push-type"], "mdm");
	assert.equal(apnsRequest({ token: "deadbeef00112233", topic: TOPIC, pushMagic: "m" }).body, '{"mdm":"m"}');
	assert.throws(() => apnsRequest({ token: "../x", topic: TOPIC, pushMagic: "m" }), /token/);
	const calls = [];
	const client = { call: async (name, body) => (calls.push([name, body]), name === "bridge/mdm-pushes" ? { pushes: [{ id: "u1", token: "deadbeef00112233", topic: TOPIC, pushMagic: "m1" }, { id: "u2", token: "aaaaaaaaaaaaaaaa", topic: TOPIC, pushMagic: "m2" }] } : { recorded: 2 }) };
	const sent = await relayPushes(client, async (p) => (p.id === "u1" ? { ok: true, status: 200 } : { ok: false, status: 410, reason: "Unregistered" }));
	assert.equal(sent, 2);
	assert.deepEqual(calls[1], ["bridge/mdm-push-result", { results: [{ id: "u1", ok: true, status: 200, reason: undefined }, { id: "u2", ok: false, status: 410, reason: "Unregistered" }] }]);
});

test("the push sender speaks HTTP/2 to the push service and presents the MDM push certificate", async () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pf-apns-"));
	ossl(dir, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.pem", "-subj", "/CN=localhost", "-days", "2");
	ossl(dir, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "push.key", "-out", "push.pem", "-subj", `/UID=${TOPIC}/CN=APSP:test`, "-days", "2");
	ossl(dir, "pkcs12", "-export", "-inkey", "push.key", "-in", "push.pem", "-passout", "pass:pw", "-out", "push.p12");
	const seen = [];
	const server = http2.createSecureServer({ key: readFileSync(path.join(dir, "server.key")), cert: readFileSync(path.join(dir, "server.pem")), requestCert: true, rejectUnauthorized: false });
	server.on("stream", (stream, headers) => {
		let body = "";
		stream.on("data", (c) => (body += c));
		stream.on("end", () => {
			seen.push({ headers, body, client: stream.session.socket.getPeerCertificate().subject });
			stream.respond({ ":status": headers[":path"].endsWith("bad0bad0bad0bad0") ? 410 : 200 });
			stream.end(headers[":path"].endsWith("bad0bad0bad0bad0") ? '{"reason":"Unregistered"}' : "");
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const ca = readFileSync(path.join(dir, "server.pem"));
	const send = apnsSender({ pfx: readFileSync(path.join(dir, "push.p12")), passphrase: "pw", host: `https://localhost:${server.address().port}`, connect: (host, opts) => http2.connect(host, { ...opts, ca }) });
	try {
		assert.deepEqual(await send({ token: "deadbeef00112233", topic: TOPIC, pushMagic: "magic" }), { ok: true, status: 200, reason: undefined });
		assert.deepEqual(await send({ token: "bad0bad0bad0bad0", topic: TOPIC, pushMagic: "magic" }), { ok: false, status: 410, reason: "Unregistered" });
	} finally {
		send.close();
		server.close();
	}
	assert.equal(seen[0].headers["apns-topic"], TOPIC);
	assert.equal(seen[0].headers["apns-push-type"], "mdm");
	assert.equal(seen[0].headers[":path"], "/3/device/deadbeef00112233");
	assert.equal(seen[0].body, '{"mdm":"magic"}');
	assert.equal(seen[0].client.UID, TOPIC, "the push certificate was presented");
});
