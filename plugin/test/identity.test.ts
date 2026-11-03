// Identity registry as EmDash content (`identifiers`): normalisation, uniqueness
// across record types enforced by the collection's unique field (including
// races), release to the trash, administrator transfers and merges by editing
// and publishing, derived status, and the read-only Mission 001 mirror.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { ContentReader } from "../src/content.ts";
import { identityTask } from "../src/entity-tasks.ts";
import { claimAll, claimsForSubject, identifierStatus, lookup, mirrorAssets, parseIdentifiers } from "../src/identity.ts";
import { streamEntries } from "../src/journal.ts";
import { ADMIN, AI, EDITOR, makeWorld, type World } from "./entity-world.ts";

let w: World;
let reader: ContentReader;
beforeEach(() => {
	w = makeWorld();
	reader = new ContentReader(w.db.port());
});

const entry = (identifier: string) => w.db.db.prepare("select * from ec_identifiers where identifier = ? and deleted_at is null").get(identifier) as Record<string, string> | undefined;

test("identifiers are normalised per namespace; invalid, repeated and Mission 001 namespaces are refused on records", () => {
	const ok = parseIdentifiers([
		{ namespace: "vat", value: "pt 123.456.789" },
		{ namespace: "domain", value: "HTTPS://Example.COM/path" },
		{ namespace: "LEI", value: "5493001kjtiigc8y1r12" },
		{ namespace: "ext:hmrc", value: " 12345 " },
	]);
	assert.deepEqual(ok.errors, []);
	assert.deepEqual(ok.identifiers, [
		{ namespace: "vat", value: "PT123456789" },
		{ namespace: "domain", value: "example.com" },
		{ namespace: "lei", value: "5493001KJTIIGC8Y1R12" },
		{ namespace: "ext:hmrc", value: "12345" },
	]);
	assert.match(parseIdentifiers([{ namespace: "vat", value: "12" }]).errors.join(), /not a valid VAT/);
	assert.match(parseIdentifiers([{ namespace: "passport", value: "X" }]).errors.join(), /unknown namespace/);
	assert.match(parseIdentifiers([{ namespace: "vat", value: "PT123456789" }, { namespace: "vat", value: "pt123456789" }]).errors.join(), /listed twice/);
	assert.match(parseIdentifiers([{ namespace: "apple_serial", value: "C07ZX1ABCD9Q" }]).errors.join(), /Mission 001 inventory/);
});

test("publishing a record registers its identifiers as published registry entries", async () => {
	const c = await w.draftAs(EDITOR, "clients", { title: "Acme", client_kind: "organization", identifiers: [{ namespace: "domain", value: "acme.example" }] });
	assert.equal(entry("domain:acme.example"), undefined, "a draft claims nothing");
	assert.equal(await w.publishAs(EDITOR, "clients", c.id), undefined);
	const e = entry("domain:acme.example")!;
	assert.equal(e.subject, "clients:CL-0001");
	assert.equal(e.source, "record");
	assert.equal(e.status, "published");
});

test("an identifier belongs to one record across every type: duplicates are refused on save and on publish", async () => {
	const client = await w.draftAs(EDITOR, "clients", { title: "Acme", client_kind: "organization", identifiers: [{ namespace: "domain", value: "acme.example" }] });
	assert.equal(await w.publishAs(EDITOR, "clients", client.id), undefined);
	await assert.rejects(w.draftAs(EDITOR, "products", { title: "Acme Cloud", identifiers: [{ namespace: "domain", value: "ACME.example." }] }), /already identifies clients:CL-0001/);
	const a = await w.draftAs(EDITOR, "clients", { title: "Beta", client_kind: "organization", identifiers: [{ namespace: "vat", value: "PT500000001" }] });
	const b = await w.draftAs(EDITOR, "products", { title: "Beta product", identifiers: [{ namespace: "vat", value: "PT500000001" }] });
	assert.equal(await w.publishAs(EDITOR, "clients", a.id), undefined);
	assert.match(String(await w.publishAs(EDITOR, "products", b.id)), /already identifies clients:CL-0002/);
});

test("races are decided by the collection's unique field: one record wins, the loser's other claims are released", async () => {
	const ids = [{ namespace: "vat", value: "PT500000002" }];
	const [x, y] = await Promise.all([
		claimAll(w.ctx as never, reader, "clients:CL-0100", [...ids, { namespace: "domain", value: "x.example" }]),
		claimAll(w.ctx as never, reader, "products:PR-0100", [...ids, { namespace: "domain", value: "y.example" }]),
	]);
	assert.equal([x.ok, y.ok].filter(Boolean).length, 1);
	const winner = x.ok ? "clients:CL-0100" : "products:PR-0100";
	assert.equal(entry("vat:PT500000002")!.subject, winner);
	assert.equal(entry(x.ok ? "domain:y.example" : "domain:x.example"), undefined, "the loser's other claim was released again");
	assert.equal((w.db.db.prepare("select count(*) as n from ec_identifiers where identifier = 'vat:PT500000002'").get() as { n: number }).n, 1);
});

test("dropping an identifier from a published record releases it: the entry keeps its history and the value is free again", async () => {
	const c = await w.draftAs(EDITOR, "clients", { title: "Gamma", client_kind: "organization", identifiers: [{ namespace: "vat", value: "PT500000003" }, { namespace: "domain", value: "gamma.example" }] });
	assert.equal(await w.publishAs(EDITOR, "clients", c.id), undefined);
	const first = entry("vat:PT500000003")!;
	await w.editAs(EDITOR, "clients", c.id, { identifiers: [{ namespace: "domain", value: "gamma.example" }] });
	assert.equal(await w.publishAs(EDITOR, "clients", c.id), undefined);
	assert.equal(entry("vat:PT500000003"), undefined);
	const released = w.row("identifiers", first.id)!;
	assert.equal(released.identifier, `released/${first.id}/vat:PT500000003`, "kept, renamed, with its revisions");
	assert.match(String(released.rationale), /no longer listed on clients:CL-0001/);
	const other = await w.draftAs(EDITOR, "clients", { title: "Delta", client_kind: "organization", identifiers: [{ namespace: "vat", value: "PT500000003" }] });
	assert.equal(await w.publishAs(EDITOR, "clients", other.id), undefined);
	assert.equal(entry("vat:PT500000003")!.subject, "clients:CL-0002");
});

test("the registry is changed only by Powerfarm and administrators: no creates, no edits of the value, transfers need a rationale", async () => {
	const a = await w.draftAs(EDITOR, "clients", { title: "Dup", client_kind: "organization", identifiers: [{ namespace: "domain", value: "dup.example" }] });
	const b = await w.draftAs(EDITOR, "clients", { title: "Real", client_kind: "organization" });
	assert.equal(await w.publishAs(EDITOR, "clients", a.id), undefined);
	assert.equal(await w.publishAs(EDITOR, "clients", b.id), undefined);
	const e = entry("domain:dup.example")!;
	await assert.rejects(w.draftAs(ADMIN, "identifiers", { title: "x", identifier: "vat:PT1", namespace: "vat", value: "PT1", subject: "clients:CL-0001", source: "record" }), /on the record itself/);
	await assert.rejects(w.editAs(EDITOR, "identifiers", e.id, { subject: "clients:CL-0002" }), /administrator/);
	await assert.rejects(w.editAs(AI, "identifiers", e.id, { subject: "clients:CL-0002" }, "mcp"), /AI clients/);
	await assert.rejects(w.editAs(ADMIN, "identifiers", e.id, { value: "other.example" }), /cannot change/);
	await assert.rejects(w.editAs(ADMIN, "identifiers", e.id, { subject: "clients:CL-0002", rationale: "short" }), /rationale/);
	assert.equal(await w.trashAs("identifiers", e.id), false, "registry entries are never deleted by people");
	// The transfer: an administrator edits the subject, with a rationale. EmDash keeps the revision.
	await w.editAs(ADMIN, "identifiers", e.id, { subject: "clients:CL-0002", rationale: "Domain belongs to the real record, confirmed by DNS." });
	assert.equal(entry("domain:dup.example")!.subject, "clients:CL-0002");
	assert.equal(entry("domain:dup.example")!.source, "transfer");
	// The old holder can no longer publish it; the receiving record keeps it even before it lists it.
	await w.editAs(EDITOR, "clients", a.id, { title: "Dup Lda" });
	assert.match(String(await w.publishAs(EDITOR, "clients", a.id)), /transferred by an administrator/);
	await w.editAs(EDITOR, "clients", b.id, { title: "Real Lda" });
	assert.equal(await w.publishAs(EDITOR, "clients", b.id), undefined);
	assert.ok(entry("domain:dup.example"), "not released while the receiving record has not listed it yet");
	await w.editAs(EDITOR, "clients", b.id, { identifiers: [{ namespace: "domain", value: "dup.example" }] });
	assert.equal(await w.publishAs(EDITOR, "clients", b.id), undefined);
	assert.equal(entry("domain:dup.example")!.source, "record", "listed on the record, it is an ordinary entry again");
});

test("merging: an administrator retires the duplicate into the survivor in one publish; its identifiers move with the rationale", async () => {
	const dup = await w.draftAs(EDITOR, "clients", { title: "Acme (dup)", client_kind: "organization", identifiers: [{ namespace: "vat", value: "PT500000004" }] });
	const real = await w.draftAs(EDITOR, "clients", { title: "Acme", client_kind: "organization" });
	assert.equal(await w.publishAs(EDITOR, "clients", dup.id), undefined);
	assert.equal(await w.publishAs(EDITOR, "clients", real.id), undefined);
	await assert.rejects(w.editAs(EDITOR, "clients", dup.id, { merged_into: "CL-0002" }), /Only an administrator merges/);
	await w.editAs(ADMIN, "clients", dup.id, { merged_into: "cl-0002", merge_rationale: "short" });
	assert.match(String(await w.publishAs(ADMIN, "clients", dup.id)), /set Lifecycle to retired/);
	await w.editAs(ADMIN, "clients", dup.id, { lifecycle: "retired" });
	assert.match(String(await w.publishAs(ADMIN, "clients", dup.id)), /at least 20 characters/);
	await w.editAs(ADMIN, "clients", dup.id, { merge_rationale: "Same legal entity registered twice; keeping CL-0002." });
	assert.equal(await w.publishAs(ADMIN, "clients", dup.id), undefined);
	const moved = entry("vat:PT500000004")!;
	assert.equal(moved.subject, "clients:CL-0002");
	assert.equal(moved.source, "transfer");
	assert.match(moved.rationale!, /Merged from clients:CL-0001: Same legal entity/);
	assert.equal(w.row("clients", dup.id)!.lifecycle, "retired");
	assert.equal(w.row("clients", dup.id)!.merged_into, "CL-0002");
});

test("identifier status is derived: reported, imported, attested, verified", () => {
	const id = { namespace: "vat", value: "PT500000005" };
	assert.equal(identifierStatus({ source: "record" }, id, []), "reported");
	assert.equal(identifierStatus({ source: "asset_mirror" }, id, []), "imported");
	const e = { attests: "identity_verified", identifier: "vat:PT500000005", digestVerified: false, signedBy: "u", createdAt: "2026-11-02" };
	assert.equal(identifierStatus({ source: "record" }, id, [e]), "attested");
	assert.equal(identifierStatus({ source: "record" }, id, [{ ...e, digestVerified: true }]), "verified");
	assert.equal(identifierStatus({ source: "record" }, id, [{ ...e, identifier: "vat:PT000000000" }]), "reported", "an attestation of another identifier does not count");
});

test("Mission 001 identifiers are mirrored read-only as registry entries; conflicts are reported, never resolved; asset journals are untouched", async () => {
	const result = await mirrorAssets(w.ctx as never, reader, [
		{ key: "IPHONE-13-RED", serial: "F2LXK0ABCD12", ecid: "0x001A2B" },
		{ key: "IPHONE-14-PURPLE", serial: "f2lxk0abcd12", ecid: null },
	]);
	assert.equal(result.claimed, 2);
	assert.match(result.conflicts[0]!, /recorded on IPHONE-14-PURPLE and on IPHONE-13-RED/);
	const ecid = (await lookup(reader, { namespace: "apple_ecid", value: "0x1a2b" }))!;
	assert.equal(ecid.subject, "assets:IPHONE-13-RED");
	assert.equal(ecid.source, "asset_mirror");
	await assert.rejects(w.editAs(ADMIN, "identifiers", ecid.id, { subject: "assets:IPHONE-14-PURPLE", rationale: "Moving a device ECID between records." }), /cannot be transferred/);
	assert.equal((await streamEntries(w.ctx as never, "asset:IPHONE-13-RED", 10)).entries.length, 0);
});

test("the identity task releases entries no published record lists (a publish cancelled after its claim)", async () => {
	await claimAll(w.ctx as never, reader, "clients:CL-0900", [{ namespace: "vat", value: "PT500000006" }]);
	w.db.db.prepare("update ec_identifiers set created_at = ? where identifier = 'vat:PT500000006'").run("2026-01-01T00:00:00Z");
	const result = await identityTask(w.ctx as never);
	assert.equal(result.staleReleased, 1);
	assert.equal((await claimsForSubject(reader, "clients:CL-0900")).length, 0);
});
