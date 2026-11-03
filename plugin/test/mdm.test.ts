// Powerfarm MDM end to end through the real plugin code: devices sign their
// messages with identities from a Powerfarm CA (made here with openssl, as the
// bridge does on the Mac), check in, receive commands and report; vigilance
// turns findings into incidents; Cloudflare reads a posture score; people
// approve profiles and close incidents through EmDash's hooks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, test } from "node:test";

import { ContentReader } from "../src/content.ts";
import { MDM_SETTINGS, type MdmCommand, type MdmDevice } from "../src/mdm/model.ts";
import { buildPlist, parsePlistDict, type PlistDict } from "../src/mdm/plist.ts";
import { profileProblems } from "../src/mdm/policy.ts";
import { claimPushes, postureScores, pushResult } from "../src/mdm/posture.ts";
import { handleCheckin, handleConnect } from "../src/mdm/protocol.ts";
import { vigilanceTask } from "../src/mdm/vigilance.ts";
import { ADMIN, ADMIN2, AI, EDITOR, makeWorld, type World } from "./entity-world.ts";

const TOPIC = "com.apple.mgmt.External.11111111-2222-3333-4444-555555555555";
const UDID = "00008110-000A1B2C3D4E5F6A";
const SERIAL = "F2LXK0ABCD12";

const ossl = (dir: string, ...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });

/** The CA and device identities, made exactly as the bridge makes them on the Mac. */
const ca = (() => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "pf-mdmca-"));
	ossl(dir, "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key");
	ossl(dir, "req", "-x509", "-new", "-key", "ca.key", "-subj", "/CN=Powerfarm Device CA", "-days", "3650", "-out", "ca.pem", "-addext", "basicConstraints=critical,CA:TRUE");
	return { dir, pem: readFileSync(path.join(dir, "ca.pem"), "utf8") };
})();

function identity(cn: string, name: string, caDir = ca.dir) {
	ossl(caDir, "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", `${name}.key`);
	ossl(caDir, "req", "-new", "-key", `${name}.key`, "-subj", `/CN=${cn}`, "-out", `${name}.csr`);
	ossl(caDir, "x509", "-req", "-in", `${name}.csr`, "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "825", "-out", `${name}.pem`);
	return { dir: caDir, name };
}

const DEV = identity(UDID, "dev");
const OTHER_KEY_SAME_UDID = identity(UDID, "dev2");
const WRONG_CN = identity("00008110-FFFFFFFFFFFFFFFF", "dev3");

function signed(id: { dir: string; name: string }, message: PlistDict) {
	const body = buildPlist(message);
	writeFileSync(path.join(id.dir, "msg.plist"), body);
	ossl(id.dir, "cms", "-sign", "-binary", "-md", "sha256", "-in", "msg.plist", "-signer", `${id.name}.pem`, "-inkey", `${id.name}.key`, "-outform", "DER", "-out", "msg.sig");
	return { body: new TextEncoder().encode(body), sig: readFileSync(path.join(id.dir, "msg.sig")).toString("base64") };
}

let w: World;
const reader = () => new ContentReader(w.db.port());
const ctx = () => w.ctx as never;
const settings = () => (w.ctx as unknown as { settings: { values: Record<string, unknown> } }).settings.values;

beforeEach(() => {
	w = makeWorld();
	Object.assign(settings(), { [MDM_SETTINGS.enabled]: true, [MDM_SETTINGS.topic]: TOPIC, [MDM_SETTINGS.caCertificate]: ca.pem });
	w.db.insert("assets", { title: "iPhone 13 RED", asset_tag: "IPHONE-13-RED", device_class: "iphone", serial_number: SERIAL, os_policy: ">=18.0" }, { status: "published" });
});

async function checkin(message: PlistDict, id = DEV, now?: Date) {
	const m = signed(id, message);
	return handleCheckin(ctx(), reader(), m.body, m.sig, now);
}
async function connect(message: PlistDict, id = DEV, now?: Date) {
	const m = signed(id, { UDID, ...message });
	const r = await handleConnect(ctx(), reader(), m.body, m.sig, now);
	return { ...r, command: r.body ? parsePlistDict(r.body) : null };
}
const refusal = async (p: Promise<unknown>) => ((await p.then(() => null, (e) => e)) as { code: string; status: number } | null);

const devices = () => [...(w.ctx.storage.mdm_devices.rows.values() as Iterable<{ value: MdmDevice }>)].map((r) => r.value);
const commands = () => [...(w.ctx.storage.mdm_commands.rows.values() as Iterable<{ value: MdmCommand }>)].map((r) => r.value);
const incidents = () => w.db.db.prepare("select * from ec_incidents").all() as Array<Record<string, string | number>>;

async function enrol() {
	assert.deepEqual(await checkin({ MessageType: "Authenticate", Topic: TOPIC, UDID, SerialNumber: SERIAL, ProductName: "iPhone14,5", OSVersion: "18.2", BuildVersion: "22C152" }), { status: 200, body: null });
	assert.deepEqual(await checkin({ MessageType: "TokenUpdate", Topic: TOPIC, UDID, Token: new Uint8Array([0xde, 0xad, 0xbe, 0xef]), PushMagic: "magic-1", UnlockToken: new Uint8Array([1, 2, 3]) }), { status: 200, body: null });
}

test("a device with a Powerfarm identity for its own UDID and a registered serial enrols; the first inventory is queued and a push requested", async () => {
	await enrol();
	const [d] = devices();
	assert.equal(d!.assetTag, "IPHONE-13-RED");
	assert.equal(d!.status, "enrolled");
	assert.equal(d!.pushToken, "deadbeef");
	assert.ok(!JSON.stringify(d).includes("UnlockToken") && !("unlockToken" in d!), "the unlock token is never kept");
	assert.deepEqual(commands().map((c) => c.requestType).sort(), ["DeviceInformation", "ProfileList", "SecurityInfo"]);
	assert.equal((await claimPushes(ctx())).length, 1, "a push is waiting for the Mac to send");
	const journal = [...w.ctx.storage.journal.rows.values()].map((r) => (r.value as { type: string }).type);
	assert.ok(journal.includes("mdm.enrolled"));
});

test("enrolment is refused without a signature, from another CA, for another device's identity, an unknown serial, a wrong topic, or when MDM is off", async () => {
	const auth = { MessageType: "Authenticate", Topic: TOPIC, UDID, SerialNumber: SERIAL };
	const m = signed(DEV, auth);
	assert.equal((await refusal(handleCheckin(ctx(), reader(), m.body, null)))?.code, "UNSIGNED");

	const foreign = mkdtempSync(path.join(os.tmpdir(), "pf-foreign-"));
	ossl(foreign, "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key");
	ossl(foreign, "req", "-x509", "-new", "-key", "ca.key", "-subj", "/CN=Powerfarm Device CA", "-days", "3650", "-out", "ca.pem", "-addext", "basicConstraints=critical,CA:TRUE");
	assert.equal((await refusal(checkin(auth, identity(UDID, "x", foreign))))?.code, "UNTRUSTED_SIGNER", "a look-alike CA with the same name is not ours");

	assert.equal((await refusal(checkin(auth, WRONG_CN)))?.code, "IDENTITY_NOT_FOR_DEVICE");
	assert.equal((await refusal(checkin({ ...auth, SerialNumber: "NOTOURS0001" })))?.code, "UNKNOWN_DEVICE");
	assert.equal((await refusal(checkin({ ...auth, Topic: "com.apple.mgmt.External.other" })))?.code, "WRONG_TOPIC");
	settings()[MDM_SETTINGS.enabled] = false;
	assert.equal((await refusal(checkin(auth)))?.code, "MDM_DISABLED");
	assert.equal(devices().length, 0);
	const refused = incidents().filter((i) => i.rule === "enrolment_refused");
	assert.equal(refused.length, 1, "both refusals for this UDID are one open incident");
	assert.equal(Number(refused[0]!.occurrences), 2);
});

test("commands go out one at a time and results become facts; NotNow waits; errors are recorded; nothing outside the allowlist is ever sent", async () => {
	await enrol();
	const first = await connect({ Status: "Idle" });
	const cmd = first.command!.Command as PlistDict;
	assert.equal(cmd.RequestType, "DeviceInformation");
	assert.ok((cmd.Queries as string[]).includes("IsSupervised"));
	const uuid = String(first.command!.CommandUUID);

	const second = await connect({ Status: "Acknowledged", CommandUUID: uuid, QueryResponses: { OSVersion: "18.3", ProductName: "iPhone14,5", IsSupervised: true, SerialNumber: SERIAL, SomethingElse: "ignored" } });
	assert.equal(devices()[0]!.osVersion, "18.3");
	assert.equal(devices()[0]!.facts.information!.values.IsSupervised, true);
	assert.ok(!("SomethingElse" in devices()[0]!.facts.information!.values));
	const next = second.command!.Command as PlistDict;
	const third = await connect({ Status: "NotNow", CommandUUID: String(second.command!.CommandUUID) });
	assert.notEqual((third.command?.Command as PlistDict | undefined)?.RequestType, next.RequestType, "a NotNow command is not offered again in the same session");
	await connect({ Status: "Error", CommandUUID: String(third.command!.CommandUUID), ErrorChain: [{ ErrorDomain: "MCMDMErrorDomain", LocalizedDescription: "Not allowed" }] });
	assert.ok(commands().some((c) => c.status === "error" && /Not allowed/.test(c.error ?? "")));
	assert.ok(commands().every((c) => ["DeviceInformation", "SecurityInfo", "ProfileList", "CertificateList", "InstalledApplicationList", "InstallProfile", "RemoveProfile"].includes(c.requestType)));
});

test("a second CA-signed identity for an enrolled UDID is refused as a critical incident; a CheckOut leaves management and scores 0", async () => {
	await enrol();
	assert.equal((await refusal(connect({ Status: "Idle" }, OTHER_KEY_SAME_UDID)))?.code, "IDENTITY_MISMATCH");
	assert.ok(incidents().some((i) => i.rule === "identity_mismatch" && i.severity === "critical"));

	assert.equal((await postureScores(ctx(), reader(), { devices: [{ device_id: "cf-1", serial_number: SERIAL.toLowerCase() }] })).result["cf-1"]!.score, 0, "a critical incident is open");
	await checkin({ MessageType: "CheckOut", Topic: TOPIC, UDID });
	assert.equal(devices()[0]!.status, "checked_out");
	assert.ok(incidents().some((i) => i.rule === "left_management"));
	assert.equal((await refusal(connect({ Status: "Idle" })))?.code, "NOT_ENROLLED");
});

test("vigilance: an unapproved profile is a critical incident (repeats are counted, not duplicated); required profiles are installed; posture follows", async () => {
	await enrol();
	const answer = async (status: string, extra: PlistDict = {}) => {
		let r = await connect({ Status: "Idle" });
		while (r.command) {
			const type = (r.command.Command as PlistDict).RequestType;
			const result: PlistDict =
				type === "ProfileList"
					? { ProfileList: [{ PayloadIdentifier: "org.powerfarm.mdm.enrolment.x", PayloadDisplayName: "Powerfarm", IsManaged: true }, { PayloadIdentifier: "com.evil.proxy", PayloadDisplayName: "Network helper", IsManaged: false }, ...((extra.more as PlistDict[]) ?? [])] }
					: type === "SecurityInfo"
						? { SecurityInfo: { PasscodePresent: true, PasscodeCompliant: true } }
						: type === "DeviceInformation"
							? { QueryResponses: { OSVersion: "18.2", IsSupervised: true } }
							: {};
			r = await connect({ Status: status, CommandUUID: String(r.command.CommandUUID), ...result });
		}
	};
	await answer("Acknowledged");
	assert.equal((await postureScores(ctx(), reader(), { devices: [{ device_id: "cf-1", serial_number: SERIAL }] })).result["cf-1"]!.score, 100, "healthy before vigilance has looked");

	// An administrator approves a required baseline profile.
	const xml = buildPlist({ PayloadType: "Configuration", PayloadIdentifier: "org.powerfarm.baseline.passcode", PayloadUUID: "A1", PayloadVersion: 1, PayloadContent: [{ PayloadType: "com.apple.mobiledevice.passwordpolicy", PayloadIdentifier: "org.powerfarm.baseline.passcode.p", PayloadUUID: "A2", PayloadVersion: 1, minLength: 6 }] });
	const prof = await w.draftAs(EDITOR, "mdm_profiles", { title: "Passcode", identifier: "org.powerfarm.baseline.passcode", install: "required", platform: "all", mobileconfig: xml });
	assert.equal(await w.publishAs(ADMIN, "mdm_profiles", prof.id), undefined);

	const run1 = await vigilanceTask(ctx(), reader());
	assert.ok(run1.findings >= 1);
	const unknown = incidents().filter((i) => i.rule === "unknown_profile");
	assert.equal(unknown.length, 1);
	assert.equal(unknown[0]!.severity, "critical");
	assert.match(String(unknown[0]!.detail), /com\.evil\.proxy/);
	assert.ok(commands().some((c) => c.requestType === "InstallProfile" && c.status === "queued"));
	assert.equal((await postureScores(ctx(), reader(), { devices: [{ device_id: "cf-1", serial_number: SERIAL }] })).result["cf-1"]!.score, 0);

	// The install goes out with the approved profile's bytes and is recorded when acknowledged.
	let r = await connect({ Status: "Idle" });
	while (r.command && (r.command.Command as PlistDict).RequestType !== "InstallProfile") r = await connect({ Status: "Acknowledged", CommandUUID: String(r.command.CommandUUID) });
	assert.match(new TextDecoder().decode((r.command!.Command as PlistDict).Payload as Uint8Array), /org\.powerfarm\.baseline\.passcode/);
	await connect({ Status: "Acknowledged", CommandUUID: String(r.command!.CommandUUID) });
	assert.equal(await w.ctx.kv.get(`mdm:installed:${UDID}:org.powerfarm.baseline.passcode`), w.row("mdm_profiles", prof.id)!.live_revision_id);

	await vigilanceTask(ctx(), reader());
	const again = incidents().filter((i) => i.rule === "unknown_profile");
	assert.equal(again.length, 1, "one open incident per rule and device");
	assert.equal(Number(again[0]!.occurrences), 2);
});

test("a device that stops checking in is reported; an OS downgrade is critical", async () => {
	await enrol();
	const later = new Date(Date.now() + 30 * 3_600_000);
	await vigilanceTask(ctx(), reader(), later);
	assert.ok(incidents().some((i) => i.rule === "not_seen" && i.severity === "high"));
	await w.ctx.kv.set(`mdm:maxos:${UDID}`, "18.4");
	await vigilanceTask(ctx(), reader());
	assert.ok(incidents().some((i) => i.rule === "os_downgrade" && i.severity === "critical"));
});

test("device profiles: checked before saving, approved only by an administrator (a second one when required), never by AI; withdrawing removes them", async () => {
	const good = buildPlist({ PayloadType: "Configuration", PayloadIdentifier: "org.powerfarm.baseline.lockdown", PayloadUUID: "B1", PayloadVersion: 1, PayloadContent: [{ PayloadType: "com.apple.applicationaccess", PayloadIdentifier: "x", PayloadUUID: "B2", PayloadVersion: 1, allowAirDrop: false }] });
	assert.deepEqual(profileProblems(good, "org.powerfarm.baseline.lockdown"), []);
	const mitm = good.replace("com.apple.applicationaccess", "com.apple.security.root");
	assert.match(profileProblems(mitm, "org.powerfarm.baseline.lockdown").join(" "), /root/);
	assert.match(profileProblems(good.replace("com.apple.applicationaccess", "com.apple.mdm"), "org.powerfarm.baseline.lockdown").join(" "), /com\.apple\.mdm/);
	assert.match(profileProblems(good, "org.other").join(" "), /PayloadIdentifier/);

	await assert.rejects(w.draftAs(AI, "mdm_profiles", { title: "x", identifier: "org.powerfarm.x", install: "required", platform: "all", mobileconfig: good }, {}, "mcp"), /AI clients/);
	await assert.rejects(w.draftAs(EDITOR, "mdm_profiles", { title: "x", identifier: "org.powerfarm.baseline.lockdown", install: "required", platform: "all", mobileconfig: mitm }), /root/);
	const p = await w.draftAs(EDITOR, "mdm_profiles", { title: "Lockdown baseline", identifier: "org.powerfarm.baseline.lockdown", install: "required", platform: "all", mobileconfig: good });
	assert.match(String(await w.publishAs(EDITOR, "mdm_profiles", p.id)), /administrator/);
	settings().requireSecondPerson = true;
	const own = await w.draftAs(ADMIN, "mdm_profiles", { title: "Own", identifier: "org.powerfarm.baseline.own", install: "required", platform: "all", mobileconfig: good.replace(/org\.powerfarm\.baseline\.lockdown/, "org.powerfarm.baseline.own") });
	assert.match(String(await w.publishAs(ADMIN, "mdm_profiles", own.id)), /second person/);
	assert.equal(await w.publishAs(ADMIN2, "mdm_profiles", own.id), undefined);
	assert.equal(await w.publishAs(ADMIN, "mdm_profiles", p.id), undefined);
	assert.equal(await w.trashAs("mdm_profiles", p.id), false, "an approved profile stays as history");

	// Withdrawing a profile a device has: Powerfarm removes it.
	await enrol();
	const d = devices()[0]!;
	w.ctx.storage.mdm_devices.rows.set(UDID, { value: { ...d, facts: { profiles: { at: new Date().toISOString(), items: [{ identifier: "org.powerfarm.baseline.lockdown", name: "x", managed: true, uuid: null }] } } }, version: 99 } as never);
	assert.match(String(await w.unpublishAs(EDITOR, "mdm_profiles", p.id)), /administrator/);
	assert.equal(await w.unpublishAs(ADMIN, "mdm_profiles", p.id), undefined);
	const { afterUnpublish } = await import("../src/policy.ts");
	await afterUnpublish({ collection: "mdm_profiles", content: { id: p.id, data: { identifier: "org.powerfarm.baseline.lockdown", install: "required" } } }, w.ctx as never);
	assert.ok(commands().some((c) => c.requestType === "RemoveProfile" && c.params.identifier === "org.powerfarm.baseline.lockdown"));
});

test("incidents: opened by Powerfarm only; people change status and resolution, must explain a closure, cannot reopen or delete; AI cannot touch them", async () => {
	await assert.rejects(w.draftAs(EDITOR, "incidents", { title: "x", severity: "low", incident_status: "open", rule: "x", detail: "x", first_seen: new Date().toISOString(), last_seen: new Date().toISOString() }), /opened by Powerfarm/);
	await enrol();
	await checkin({ MessageType: "CheckOut", Topic: TOPIC, UDID });
	const inc = incidents().find((i) => i.rule === "left_management")!;
	const id = String(inc.id);
	await assert.rejects(w.editAs(AI, "incidents", id, { incident_status: "resolved", resolution: "AI says fine" }, "mcp"), /AI clients/);
	await assert.rejects(w.editAs(EDITOR, "incidents", id, { severity: "low" }), /recorded by Powerfarm/);
	await assert.rejects(w.editAs(EDITOR, "incidents", id, { incident_status: "resolved" }), /at least 10 characters/);
	const saved = await w.editAs(EDITOR, "incidents", id, { incident_status: "resolved", resolution: "Removed by Ana while re-enrolling after the erase." });
	assert.equal(saved.resolved_by, EDITOR.id);
	await assert.rejects(w.editAs(EDITOR, "incidents", id, { incident_status: "open" }), /stays closed/);
	assert.equal(await w.trashAs("incidents", id), false);
});

test("the Mac sends pushes: claimed once, confirmed and removed; Apple's 410 clears the token until the device sends a new one", async () => {
	await enrol();
	const [p] = await claimPushes(ctx());
	assert.equal(p!.token, "deadbeef");
	assert.equal(p!.topic, TOPIC);
	assert.equal((await claimPushes(ctx())).length, 0, "not handed out twice while claimed");
	await pushResult(ctx(), { id: p!.id, ok: false, status: 410, reason: "Unregistered" });
	assert.equal(devices()[0]!.pushToken, null);
	assert.equal((await claimPushes(ctx())).length, 0);
});

test("an identity and enrolment profile made by the bridge on the Mac are accepted by the plugin as they are", async () => {
	const { enrolmentProfile, initCa, issueIdentity } = (await import("../../mac/bridge/src/mdm.mjs")) as typeof import("../../mac/bridge/src/mdm.mjs");
	const caDir = path.join(mkdtempSync(path.join(os.tmpdir(), "pf-bridgeca-")), "mdm-ca");
	settings()[MDM_SETTINGS.caCertificate] = initCa(caDir);
	const xml = enrolmentProfile({ emdashUrl: "https://powerfarm.example.com", topic: TOPIC, udid: UDID, identity: issueIdentity(caDir, UDID) });

	// What the device does with the profile: install the identity, then sign with it.
	const profile = parsePlistDict(xml);
	assert.equal(profile.PayloadIdentifier, `org.powerfarm.mdm.enrolment.${UDID}`);
	const [pkcs12, mdm] = profile.PayloadContent as PlistDict[];
	assert.equal(mdm!.Topic, TOPIC);
	assert.equal(mdm!.IdentityCertificateUUID, pkcs12!.PayloadUUID);
	const dir = mkdtempSync(path.join(os.tmpdir(), "pf-device-"));
	writeFileSync(path.join(dir, "id.p12"), pkcs12!.PayloadContent as Uint8Array);
	ossl(dir, "pkcs12", "-in", "id.p12", "-passin", `pass:${String(pkcs12!.Password)}`, "-nodes", "-nocerts", "-out", "device.key");
	ossl(dir, "pkcs12", "-in", "id.p12", "-passin", `pass:${String(pkcs12!.Password)}`, "-nokeys", "-clcerts", "-out", "device.pem");
	assert.deepEqual(await checkin({ MessageType: "Authenticate", Topic: TOPIC, UDID, SerialNumber: SERIAL, OSVersion: "18.2" }, { dir, name: "device" }), { status: 200, body: null });
	assert.equal(devices()[0]!.status, "enrolled");
	// The enrolment profile itself is one of Powerfarm's own: vigilance does not flag it.
	const { evaluateDevice } = await import("../src/mdm/vigilance.ts");
	const d = { ...devices()[0]!, facts: { profiles: { at: new Date().toISOString(), items: [{ identifier: String(profile.PayloadIdentifier), name: "Powerfarm", managed: true, uuid: null }] } } };
	assert.deepEqual(evaluateDevice(d, ">=18.0", [], new Date(), 24, null), []);
});
