// Powerfarm MDM on the lab Mac: the device CA, device identities and
// enrolment profiles, and the relay that sends MDM pushes to Apple.
//
// Why here and not on Cloudflare: the CA's private key and the MDM push
// certificate are the two keys that would let someone impersonate or wake the
// fleet. They stay on a Mac a person controls. Cloudflare only ever holds the
// CA's public certificate.
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import path from "node:path";

/** Must match plugin/src/mdm/model.ts ACCESS_RIGHTS: no erase (8), no lock or passcode removal (4). */
export const ACCESS_RIGHTS = 1 + 2 + 16 + 32 + 256 + 512 + 1024;
export const ENROLMENT_ID = "org.powerfarm.mdm.enrolment";
const UDID = /^[0-9A-Fa-f-]{24,40}$/;

// OpenSSL 3 (Homebrew) or LibreSSL 3.x; POWERFARM_OPENSSL picks a specific binary.
const openssl = (cwd, ...args) => execFileSync(process.env.POWERFARM_OPENSSL || "openssl", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

/** Create the device CA once. Refuses to overwrite: replacing the CA un-enrols every device. */
export function initCa(dir, { days = 3650 } = {}) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	if (existsSync(path.join(dir, "ca.key"))) throw new Error(`${dir} already holds a CA. Replacing it would cut every enrolled device off; move it away deliberately if that is what you want.`);
	openssl(dir, "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key");
	chmodSync(path.join(dir, "ca.key"), 0o600);
	openssl(dir, "req", "-x509", "-new", "-key", "ca.key", "-subj", "/O=Powerfarm/CN=Powerfarm Device CA", "-days", String(days), "-out", "ca.pem", "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
	return readFileSync(path.join(dir, "ca.pem"), "utf8");
}

/** One identity per device, its common name the device's UDID (the server checks that). */
export function issueIdentity(caDir, udid, { days = 825 } = {}) {
	if (!UDID.test(udid)) throw new Error(`"${udid}" is not a UDID`);
	if (!existsSync(path.join(caDir, "ca.key"))) throw new Error(`No CA in ${caDir}. Run: powerfarm-bridge mdm-ca init`);
	const work = path.join(caDir, "issued", udid.toUpperCase());
	rmSync(work, { recursive: true, force: true });
	mkdirSync(work, { recursive: true, mode: 0o700 });
	const caPem = path.join(caDir, "ca.pem");
	const caKey = path.join(caDir, "ca.key");
	writeFileSync(path.join(work, "ext.cnf"), "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n");
	openssl(work, "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "device.key");
	openssl(work, "req", "-new", "-key", "device.key", "-subj", `/O=Powerfarm/CN=${udid.toUpperCase()}`, "-out", "device.csr");
	openssl(work, "x509", "-req", "-in", "device.csr", "-CA", caPem, "-CAkey", caKey, "-CAcreateserial", "-days", String(days), "-extfile", "ext.cnf", "-out", "device.pem");
	const password = randomBytes(18).toString("base64url");
	// 3DES/SHA-1 PKCS#12: the encoding Apple's profile installer reliably imports (OpenSSL 3's AES default is refused by some OS versions).
	// It protects the key only in transit inside the profile, which is installed over USB and then deleted.
	openssl(work, "pkcs12", "-export", "-inkey", "device.key", "-in", "device.pem", "-name", "Powerfarm device identity", "-certpbe", "PBE-SHA1-3DES", "-keypbe", "PBE-SHA1-3DES", "-macalg", "sha1", "-passout", `pass:${password}`, "-out", "device.p12");
	const p12 = readFileSync(path.join(work, "device.p12"));
	const certPem = readFileSync(path.join(work, "device.pem"), "utf8");
	// The private key leaves the Mac only inside the profile; nothing else keeps it.
	rmSync(path.join(work, "device.key"), { force: true });
	rmSync(path.join(work, "device.p12"), { force: true });
	return { p12, password, certPem };
}

// ---- A minimal XML plist writer (enough for profiles) ----
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function emit(v, ind) {
	const n = `${ind}\t`;
	if (typeof v === "string") return `${ind}<string>${esc(v)}</string>`;
	if (typeof v === "boolean") return `${ind}<${v}/>`;
	if (typeof v === "number") return Number.isInteger(v) ? `${ind}<integer>${v}</integer>` : `${ind}<real>${v}</real>`;
	if (v instanceof Uint8Array) return `${ind}<data>${Buffer.from(v).toString("base64")}</data>`;
	if (Array.isArray(v)) return `${ind}<array>\n${v.map((x) => emit(x, n)).join("\n")}\n${ind}</array>`;
	return `${ind}<dict>\n${Object.entries(v).map(([k, x]) => `${n}<key>${esc(k)}</key>\n${emit(x, n)}`).join("\n")}\n${ind}</dict>`;
}
export function plist(v) {
	return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${emit(v, "")}\n</plist>\n`;
}

/** The enrolment profile for one device: its identity plus the MDM payload pointing at Powerfarm. */
export function enrolmentProfile({ emdashUrl, topic, udid, identity }) {
	const base = new URL(emdashUrl);
	if (base.protocol !== "https:") throw new Error("Devices enrol only over https");
	if (!/^com\.apple\.mgmt\.External\.[0-9a-fA-F-]{36}$/.test(topic)) throw new Error("The MDM push topic must be the push certificate's UID (com.apple.mgmt.External.<uuid>)");
	const root = `${base.origin}/_emdash/api/plugins/powerfarm`;
	const identityUuid = randomUUID().toUpperCase();
	return plist({
		PayloadType: "Configuration",
		PayloadVersion: 1,
		PayloadIdentifier: `${ENROLMENT_ID}.${udid.toUpperCase()}`,
		PayloadUUID: randomUUID().toUpperCase(),
		PayloadDisplayName: "Powerfarm device management",
		PayloadDescription: "Lets Powerfarm see this device's security state and install the profiles its administrators approve. It cannot erase or lock the device.",
		PayloadOrganization: "Powerfarm",
		PayloadRemovalDisallowed: true,
		PayloadContent: [
			{
				PayloadType: "com.apple.security.pkcs12",
				PayloadVersion: 1,
				PayloadIdentifier: `${ENROLMENT_ID}.identity`,
				PayloadUUID: identityUuid,
				PayloadDisplayName: "Powerfarm device identity",
				PayloadContent: new Uint8Array(identity.p12),
				Password: identity.password,
			},
			{
				PayloadType: "com.apple.mdm",
				PayloadVersion: 1,
				PayloadIdentifier: `${ENROLMENT_ID}.mdm`,
				PayloadUUID: randomUUID().toUpperCase(),
				PayloadDisplayName: "Powerfarm MDM",
				ServerURL: `${root}/mdm/connect`,
				CheckInURL: `${root}/mdm/checkin`,
				Topic: topic,
				IdentityCertificateUUID: identityUuid,
				AccessRights: ACCESS_RIGHTS,
				SignMessage: true,
				CheckOutWhenRemoved: true,
			},
		],
	});
}

// ---- Push relay ----

/** The HTTP/2 request Apple's push service expects for an MDM wake-up. */
export function apnsRequest(push) {
	if (!/^[0-9a-f]{16,200}$/i.test(push.token)) throw new Error("Bad push token");
	return {
		path: `/3/device/${push.token}`,
		headers: { ":method": "POST", ":path": `/3/device/${push.token}`, "apns-topic": push.topic, "apns-push-type": "mdm", "apns-priority": "10", "content-type": "application/json" },
		body: JSON.stringify({ mdm: push.pushMagic }),
	};
}

/** A sender over one HTTP/2 connection to Apple, authenticated with the MDM push certificate. */
export function apnsSender({ pfx, passphrase, host = "https://api.push.apple.com", connect = http2.connect }) {
	let session = null;
	const open = () => {
		if (session && !session.closed && !session.destroyed) return session;
		session = connect(host, { pfx, passphrase });
		session.on("error", () => {});
		return session;
	};
	const send = (push) =>
		new Promise((resolve) => {
			const req = apnsRequest(push);
			const stream = open().request(req.headers);
			let status = 0;
			let body = "";
			stream.setTimeout(15_000, () => stream.close(http2.constants.NGHTTP2_CANCEL));
			stream.on("response", (h) => (status = Number(h[":status"])));
			stream.on("data", (c) => (body += c));
			stream.on("end", () => {
				let reason;
				try {
					reason = body ? JSON.parse(body).reason : undefined;
				} catch {}
				resolve({ ok: status === 200, status, reason });
			});
			stream.on("error", (e) => resolve({ ok: false, status: 0, reason: e.message }));
			stream.end(req.body);
		});
	send.close = () => session?.close();
	return send;
}

/** One relay pass: claim pending pushes from Powerfarm, send them, report Apple's answers. */
export async function relayPushes(client, send, log = () => {}) {
	const { pushes = [] } = (await client.call("bridge/mdm-pushes", { limit: 50 })) ?? {};
	if (!pushes.length) return 0;
	const results = [];
	for (const p of pushes) {
		try {
			// oxlint-disable-next-line no-await-in-loop -- one connection, few devices
			const r = await send(p);
			results.push({ id: p.id, ok: r.ok, status: r.status || undefined, reason: r.reason });
		} catch (e) {
			results.push({ id: p.id, ok: false, reason: String(e.message ?? e).slice(0, 200) });
		}
	}
	await client.call("bridge/mdm-push-result", { results });
	const failed = results.filter((r) => !r.ok);
	if (failed.length) log(`MDM push: ${failed.length} of ${results.length} not accepted by Apple (${failed.map((f) => f.status ?? f.reason).join(", ")})`);
	return results.length;
}
