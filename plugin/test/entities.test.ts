// 1.2 entities: the entity contract, lifecycle gates, controls, exceptions,
// classification-based visibility, secret hygiene and AI limits, through the
// real hooks over a seed-shaped SQLite database.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { accessFor } from "../src/access.ts";
import { ContentReader } from "../src/content.ts";
import { controlReport, loadEntityState } from "../src/controls.ts";
import { schemaStatus } from "../src/entity-tasks.ts";
import { GraphService } from "../src/graph.ts";
import { ADMIN, ADMIN2, AI, CONTRIBUTOR, EDITOR, makeWorld, person, type World } from "./entity-world.ts";
import { loadSeed, TestDb } from "./sqlite-port.ts";

let w: World;
beforeEach(() => {
	w = makeWorld();
});

const reader = () => new ContentReader(w.db.port());

async function registeredClient(extra: Record<string, unknown> = {}, refs: Record<string, string[]> = {}) {
	const draft = await w.draftAs(EDITOR, "clients", { title: "Acme Lda", client_kind: "organization", identifiers: [{ namespace: "vat", value: "PT 123 456 789" }], ...extra }, refs);
	const refused = await w.publishAs(EDITOR, "clients", draft.id);
	assert.equal(refused, undefined, refused);
	return draft;
}

test("the 1.2 content model is in the seed and the plugin's schema check passes; a 1.1 database is reported, not silently used", async () => {
	assert.deepEqual((await schemaStatus(reader())).missing, []);
	const seed = loadSeed();
	const old = { ...seed, collections: seed.collections.filter((c) => !["clients", "products", "services", "service_instances", "contracts", "blueprints", "work_items", "exceptions"].includes(c.slug)), relations: seed.relations.filter((r) => !r.slug.match(/clients|products|services|instances|contracts|work_items/)) };
	const status = await schemaStatus(new ContentReader(new TestDb(old).port()));
	assert.equal(status.ok, false);
	assert.ok(status.missing.includes("clients"));
});

test("codes are allocated, defaults applied, identifiers normalised; a published code never changes; renaming keeps identity", async () => {
	const a = await registeredClient();
	assert.equal(a.data.code, "CL-0001");
	assert.equal(a.data.lifecycle, "intake");
	assert.equal(a.data.classification, "internal");
	assert.deepEqual(a.data.identifiers, [{ namespace: "vat", value: "PT123456789" }]);
	const b = await w.draftAs(EDITOR, "contracts", { title: "MSA" });
	assert.equal(b.data.code, "CT-0001");
	assert.equal(b.data.classification, "confidential", "contracts default to confidential");

	const g = new GraphService(w.ctx as never, reader(), accessFor(EDITOR));
	const before = await g.resolve("clients", "CL-0001");
	await w.editAs(EDITOR, "clients", a.id, { title: "Acme Portugal Lda" });
	assert.equal(await w.publishAs(EDITOR, "clients", a.id), undefined);
	assert.equal(await g.resolve("clients", "CL-0001"), before, "graph identity is the translation group, not the name");
	await assert.rejects(w.editAs(EDITOR, "clients", a.id, { code: "CL-9999" }), /keeps its code/);
});

test("credentials are refused anywhere in an entity; secret references are locations, not values", async () => {
	await assert.rejects(w.draftAs(EDITOR, "services", { title: "DB", service_kind: "data", description: "-----BEGIN OPENSSH PRIVATE KEY----- abc" }), /PEM/);
	await assert.rejects(w.draftAs(EDITOR, "clients", { title: "X", client_kind: "organization", website: "https://user:hunter22@example.com" }), /embedded password/);
	const svc = await w.draftAs(EDITOR, "services", { title: "Postgres", service_kind: "data" });
	assert.equal(await w.publishAs(EDITOR, "services", svc.id), undefined);
	await assert.rejects(
		w.draftAs(EDITOR, "service_instances", { title: "pg-prod", environment: "production", secret_refs: [{ name: "db", store: "vault", reference: "q8Zt3vK9pL2mN7xR4wY6sA1bC5dE0fGh" }] }, { service: [svc.id] }),
		/looks like a secret value/,
	);
	const ok = await w.draftAs(EDITOR, "service_instances", { title: "pg-prod", environment: "production", secret_refs: [{ name: "db", store: "vault", reference: "kv/powerfarm/pg-prod" }] }, { service: [svc.id] });
	assert.ok(ok.id);
});

test("AI clients draft only: no publishing, no lifecycle changes, no lowering classification; drafts are marked", async () => {
	const draft = await w.draftAs(AI, "clients", { title: "Beta SA", client_kind: "organization" }, {}, "mcp");
	assert.equal(draft.data.prepared_by_ai, true);
	assert.match(String(await w.publishAs(AI, "clients", draft.id, "mcp")), /person/);
	assert.equal(await w.publishAs(EDITOR, "clients", draft.id), undefined);
	await assert.rejects(w.editAs(AI, "clients", draft.id, { lifecycle: "active" }, "mcp"), /cannot change a lifecycle/);
	await w.editAs(EDITOR, "clients", draft.id, { classification: "confidential" });
	assert.equal(await w.publishAs(EDITOR, "clients", draft.id), undefined);
	await assert.rejects(w.editAs(AI, "clients", draft.id, { classification: "public" }, "mcp"), /cannot lower/);
	await assert.rejects(w.draftAs(AI, "work_items", { title: "x", work_kind: "task", work_status: "open" }, {}, "mcp"), /not by AI/);
});

test("lifecycle: register as intake; activation is cancelled until every control is met; retired is final", async () => {
	const owner = person(w);
	const draft = await w.draftAs(EDITOR, "clients", { title: "Gamma", client_kind: "organization", lifecycle: "active" });
	assert.match(String(await w.publishAs(EDITOR, "clients", draft.id)), /as intake first/);
	await w.editAs(EDITOR, "clients", draft.id, { lifecycle: "intake", identifiers: [{ namespace: "domain", value: "https://Gamma.example/" }] });
	assert.equal(await w.publishAs(EDITOR, "clients", draft.id), undefined);

	await w.editAs(EDITOR, "clients", draft.id, { lifecycle: "active" });
	const refused = String(await w.publishAs(EDITOR, "clients", draft.id));
	for (const gap of ["Accountable owner", "Identity verified", "Classification reviewed", "maintenance plan"]) assert.match(refused, new RegExp(gap, "i"));

	// Meet the controls with real records: owner relation, attestations naming the subject.
	w.link("clients", draft.group, "owner", [owner.id]);
	await w.attest(EDITOR, "clients:CL-0001", "identity_verified", { identifier: "domain:gamma.example" });
	await w.attest(EDITOR, "clients:CL-0001", "classification_reviewed");
	await w.editAs(EDITOR, "clients", draft.id, { review_cadence_days: 180 });
	await w.attest(EDITOR, "clients:CL-0001", "maintenance_plan");
	assert.equal(await w.publishAs(EDITOR, "clients", draft.id), undefined);
	assert.equal(w.row("clients", draft.id)!.lifecycle, "active");

	// Retirement needs an administrator and its own approval.
	await w.editAs(EDITOR, "clients", draft.id, { lifecycle: "retired" });
	assert.match(String(await w.publishAs(EDITOR, "clients", draft.id)), /administrator/);
	assert.match(String(await w.publishAs(ADMIN, "clients", draft.id)), /Retirement approved/);
	await w.attest(ADMIN, "clients:CL-0001", "retirement_approved");
	assert.equal(await w.publishAs(ADMIN, "clients", draft.id), undefined);
	await w.editAs(ADMIN, "clients", draft.id, { lifecycle: "active" });
	assert.match(String(await w.publishAs(ADMIN, "clients", draft.id)), /Retired is final/);

	// History is EmDash's own: every publish above is a revision (and an audit-log entry); Powerfarm keeps no copy.
	assert.equal(w.row("clients", draft.id)!.lifecycle, "retired");
	assert.equal((await w.ctx.kv.list("publish:")).length, 0, "every publish marker was consumed by afterPublish");
});

test("attestations: control attestations need the right role and a subject; identity attestations must name a published identifier", async () => {
	await registeredClient();
	await assert.rejects(w.attest(EDITOR, "clients:CL-0001", "access_reviewed"), /administrator/);
	await assert.rejects(w.draftAs(EDITOR, "evidence", { title: "x", evidence_type: "attestation", attests: "classification_reviewed" }), /need a subject/);
	await assert.rejects(w.attest(EDITOR, "clients:CL-0001", "identity_verified", { identifier: "vat:PT999999999" }), /not a published identifier/);
	await assert.rejects(w.attest(EDITOR, "clients:CL-9999", "classification_reviewed"), /does not exist/);
	const ok = await w.attest(EDITOR, "clients:CL-0001", "identity_verified", { identifier: "vat:pt123456789" });
	assert.equal(ok.data.identifier, "vat:PT123456789");
	assert.equal(ok.data.signed_by, EDITOR.id);
});

test("contracts activate only with a signed copy attested by an administrator and hashed by the server", async () => {
	const owner = person(w);
	const client = await registeredClient();
	const c = await w.draftAs(EDITOR, "contracts", { title: "MSA Acme", contract_kind: "msa", effective_date: "2026-11-01T00:00:00Z", end_date: "2027-10-31T00:00:00Z" }, { client: [client.id], owner: [owner.id] });
	assert.equal(await w.publishAs(EDITOR, "contracts", c.id), undefined);
	await w.attest(EDITOR, "contracts:CT-0001", "classification_reviewed");
	await w.editAs(EDITOR, "contracts", c.id, { lifecycle: "active" });
	assert.match(String(await w.publishAs(EDITOR, "contracts", c.id)), /administrator/, "contracts need an administrator to activate");
	assert.match(String(await w.publishAs(ADMIN, "contracts", c.id)), /Signed copy/);
	await assert.rejects(w.attest(EDITOR, "contracts:CT-0001", "contract_signed"), /administrator/);
	await w.attest(ADMIN, "contracts:CT-0001", "contract_signed"); // no file attached
	assert.match(String(await w.publishAs(ADMIN, "contracts", c.id)), /signed copy attached/);
	// With a file: the evidence hook hashes the stored bytes on the server.
	const upload = await w.ctx.media.upload("signed.pdf", "application/pdf", new TextEncoder().encode("%PDF signed").buffer as ArrayBuffer);
	await w.attest(ADMIN, "contracts:CT-0001", "contract_signed", { file: { id: upload.mediaId } });
	assert.equal(await w.publishAs(ADMIN, "contracts", c.id), undefined);
});

test("security exceptions waive only waivable controls, need an administrator, expire, and respect second-person approval", async () => {
	const owner = person(w);
	const client = await registeredClient({}, {});
	w.link("clients", client.group, "owner", [owner.id]);
	await assert.rejects(w.draftAs(EDITOR, "exceptions", { title: "x", subject: "clients:CL-0001", control: "owner_assigned", rationale: "Owner not decided yet, reviewing.", expires_at: "2027-01-01T00:00:00Z" }), /cannot be waived/);
	const ex = await w.draftAs(EDITOR, "exceptions", { title: "Identity pending", subject: "clients:CL-0001", control: "identity_verified", rationale: "Registry office is closed; verify by phone meanwhile.", expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString() });
	assert.match(String(await w.publishAs(EDITOR, "exceptions", ex.id)), /administrator/);
	w.ctx.settings.values.requireSecondPerson = true;
	assert.match(String(await w.publishAs(EDITOR.role === 50 ? EDITOR : { ...EDITOR, role: 50 }, "exceptions", ex.id)), /second person/);
	assert.equal(await w.publishAs(ADMIN2, "exceptions", ex.id), undefined);
	w.ctx.settings.values.requireSecondPerson = false;

	const state = (await loadEntityState(w.ctx as never, reader(), "clients", "CL-0001", "published"))!;
	const identity = controlReport(state).activation.find((c) => c.control === "identity_verified")!;
	assert.equal(identity.status, "waived");
	assert.equal(identity.exception, "EX-0001");
	// Expired: no longer waives, and is reported.
	w.db.db.prepare("update ec_exceptions set expires_at = ? where id = ?").run("2020-01-01T00:00:00Z", ex.id);
	const later = controlReport((await loadEntityState(w.ctx as never, reader(), "clients", "CL-0001", "published"))!);
	assert.equal(later.activation.find((c) => c.control === "identity_verified")!.status, "missing");
	assert.deepEqual(later.expiredExceptions, ["EX-0001"]);
});

test("a service cannot be retired while an active instance depends on it", async () => {
	const owner = person(w);
	const svc = await w.draftAs(EDITOR, "services", { title: "Object storage", service_kind: "storage", review_cadence_days: 90 }, { owner: [owner.id] });
	assert.equal(await w.publishAs(EDITOR, "services", svc.id), undefined);
	const inst = await w.draftAs(EDITOR, "service_instances", { title: "s3-prod", environment: "production" }, { service: [svc.id] });
	assert.equal(await w.publishAs(EDITOR, "service_instances", inst.id), undefined);
	w.db.db.prepare("update ec_service_instances set lifecycle='active' where id=?").run(inst.id);
	await w.attest(ADMIN, "services:SV-0001", "retirement_approved");
	await w.editAs(ADMIN, "services", svc.id, { lifecycle: "retired" });
	assert.match(String(await w.publishAs(ADMIN, "services", svc.id)), /Still used by SI-0001/);
});

test("classification limits who sees an entity: contributors and tokens see internal, editors confidential, administrators restricted", async () => {
	const conf = await w.draftAs(EDITOR, "clients", { title: "Confidential Co", client_kind: "organization", classification: "confidential" });
	assert.equal(await w.publishAs(EDITOR, "clients", conf.id), undefined);
	const internal = await w.draftAs(EDITOR, "clients", { title: "Internal Co", client_kind: "organization" });
	assert.equal(await w.publishAs(EDITOR, "clients", internal.id), undefined);
	const restricted = await w.draftAs(ADMIN, "clients", { title: "Restricted Co", client_kind: "organization", classification: "restricted" });
	assert.match(String(await w.publishAs(EDITOR, "clients", restricted.id)), /cannot publish restricted/);
	assert.equal(await w.publishAs(ADMIN, "clients", restricted.id), undefined);

	// Stand-in for EmDash's FTS search: every client row matches; visibility is the graph's job.
	const search = async () => ({ items: (w.db.db.prepare("select id from ec_clients").all() as Array<{ id: string }>).map((r) => ({ collection: "clients", id: r.id })) });
	const titles = async (access: ReturnType<typeof accessFor>) => (await new GraphService(w.ctx as never, reader(), access, search).search("Co", { types: ["client"] })).map((n) => n.title).sort();
	assert.deepEqual(await titles(accessFor(CONTRIBUTOR)), ["Internal Co"]);
	assert.deepEqual(await titles(accessFor(EDITOR)), ["Confidential Co", "Internal Co"]);
	assert.deepEqual(await titles(accessFor(ADMIN)), ["Confidential Co", "Internal Co", "Restricted Co"]);
	assert.deepEqual(await titles(accessFor(ADMIN, {}, { token: true })), ["Internal Co"], "an administrator's API token is capped at internal by default");
	assert.deepEqual(await titles(accessFor(EDITOR, {}, { token: true, tokenMaxClassification: "confidential" })), ["Confidential Co", "Internal Co"]);
	const g = new GraphService(w.ctx as never, reader(), accessFor(CONTRIBUTOR));
	assert.equal(await g.getNode(`client:${conf.group}`), null, "hidden nodes are not found, not just filtered from lists");
});

test("contract documents and secret references never appear in graph answers for ordinary callers", async () => {
	const svc = await w.draftAs(EDITOR, "services", { title: "Queue", service_kind: "messaging" });
	assert.equal(await w.publishAs(EDITOR, "services", svc.id), undefined);
	const inst = await w.draftAs(EDITOR, "service_instances", { title: "mq", environment: "production", secret_refs: [{ name: "mq", store: "password_manager", reference: "Powerfarm/MQ prod" .replace(/ /g, "-") }] }, { service: [svc.id] });
	assert.equal(await w.publishAs(EDITOR, "service_instances", inst.id), undefined);
	const editorView = await new GraphService(w.ctx as never, reader(), accessFor(EDITOR)).getNode(`service_instance:${inst.group}`);
	assert.equal(editorView!.data!.secret_refs, "1 reference(s)");
	const adminView = await new GraphService(w.ctx as never, reader(), accessFor(ADMIN)).getNode(`service_instance:${inst.group}`);
	assert.ok(Array.isArray(adminView!.data!.secret_refs));
	const adminToken = await new GraphService(w.ctx as never, reader(), accessFor(ADMIN, {}, { token: true })).getNode(`service_instance:${inst.group}`);
	assert.equal(adminToken!.data!.secret_refs, "1 reference(s)", "tokens never get secret locations");
});

test("work items: approvals cannot be created or resolved in the editor; Powerfarm-maintained fields are protected", async () => {
	await registeredClient();
	await assert.rejects(w.draftAs(EDITOR, "work_items", { title: "x", work_kind: "approval", work_status: "open", subject: "clients:CL-0001" }), /created by blueprint runs/);
	const task = await w.draftAs(EDITOR, "work_items", { title: "Call them", work_kind: "task", work_status: "open", subject: "clients:cl-0001" });
	assert.equal(task.data.subject, "clients:CL-0001");
	assert.equal(task.data.code, "WI-0001");
	await assert.rejects(w.editAs(EDITOR, "work_items", task.id, { origin: "x#y" }), /origin is set by Powerfarm/);
	await assert.rejects(w.draftAs(EDITOR, "work_items", { title: "x", work_kind: "task", work_status: "open", subject: "clients:CL-4040" }), /does not exist/);
});

test("the graph connects an entity to its identifier entries and work items, and hides them from people who may not see them", async () => {
	w.publishedBlueprint([{ id: "call", action: "create_task", title: "Call {{subject.title}}" }], "BP-T");
	const c = await registeredClient();
	const editor = new GraphService(w.ctx as never, reader(), accessFor(EDITOR));
	const around = await editor.neighbours(`client:${c.group}`);
	const types = around!.neighbours.map((n) => `${n.edge.type}:${n.node.type}`).sort();
	assert.ok(types.includes("identifies:identifier"), types.join(","));
	assert.ok(types.includes("concerns:work_item"), types.join(","));
	const task = around!.neighbours.find((n) => n.node.type === "work_item")!;
	const fromTask = await editor.neighbours(task.node.id);
	assert.ok(fromTask!.neighbours.some((n) => n.edge.type === "uses_template" && n.node.type === "blueprint"), "a work item links to the blueprint that created it");
	const contributor = await new GraphService(w.ctx as never, reader(), accessFor(CONTRIBUTOR)).neighbours(`client:${c.group}`);
	assert.deepEqual(contributor!.neighbours.map((n) => n.node.type), [], "operational records are for editors");
	// The identifier is masked unless an administrator asks.
	const id = around!.neighbours.find((n) => n.node.type === "identifier")!.node;
	assert.equal(id.title, "vat:••••6789");
	const revealed = await new GraphService(w.ctx as never, reader(), accessFor(ADMIN, { revealIdentifiers: true })).getNode(id.id);
	assert.equal(revealed!.title, "vat:PT123456789");
});

test("the migration seed is additive: new collections and relations, evidence in full, nothing else from 1.1, and only a draft blueprint", async () => {
	const { readFileSync } = await import("node:fs");
	const migration = JSON.parse(readFileSync(new URL("../../site/seed/migrations/1.2.0.json", import.meta.url), "utf8"));
	const seed = loadSeed();
	const slugs = migration.collections.map((c: { slug: string }) => c.slug).sort();
	assert.deepEqual(slugs, ["blueprints", "clients", "contracts", "evidence", "exceptions", "identifiers", "products", "service_instances", "services", "work_items"]);
	assert.deepEqual(migration.collections.find((c: { slug: string }) => c.slug === "evidence"), seed.collections.find((c) => c.slug === "evidence"), "evidence is listed with every field, so --on-conflict update keeps them all");
	for (const r of migration.relations) assert.ok(seed.relations.some((s) => s.slug === r.slug), r.slug);
	assert.equal(migration.relations.length, 17);
	assert.deepEqual(Object.keys(migration.content), ["blueprints"]);
	assert.ok(migration.content.blueprints.every((b: { status: string }) => b.status === "draft"), "a migration never activates automation");
	assert.equal(migration.settings, undefined, "site settings are not overwritten");
});

test("a shared service is registered once and referenced: projects and products link to it, a copy is caught, credentials stay out", async () => {
	const svc = await w.draftAs(EDITOR, "services", { title: "Shared Postgres", service_kind: "data", identifiers: [{ namespace: "ext:powerfarm-catalogue", value: "pg-shared" }] });
	assert.equal(await w.publishAs(EDITOR, "services", svc.id), undefined);
	const p1 = w.db.insert("projects", { title: "Project One", code: "P-ONE" });
	const p2 = w.db.insert("projects", { title: "Project Two", code: "P-TWO" });
	w.db.link("projects_services", p1.group, svc.group);
	w.db.link("projects_services", p2.group, svc.group);
	const product = await w.draftAs(EDITOR, "products", { title: "Analytics" }, { services: [svc.id] });
	assert.equal(await w.publishAs(EDITOR, "products", product.id), undefined);
	const { serviceCatalogue, registrationCheck } = await import("../src/entity-services.ts");
	const cat = await serviceCatalogue(w.ctx as never, reader(), accessFor(EDITOR));
	assert.equal(cat.services.length, 1, "one service, not one per project");
	assert.deepEqual(cat.services[0]!.usedByProjects.map((p) => p.code).sort(), ["P-ONE", "P-TWO"]);
	assert.deepEqual(cat.services[0]!.usedByProducts.map((p) => p.code), ["PR-0001"]);
	// Registering it again is caught before a draft exists.
	const again = await registrationCheck(w.ctx as never, reader(), accessFor(EDITOR), { collection: "services", title: "Shared  postgres", identifiers: [{ namespace: "ext:powerfarm-catalogue", value: "pg-shared" }] });
	assert.equal(again.ok, false);
	assert.deepEqual(again.duplicates.map((d) => d.reason).sort(), ["Same name", "ext:powerfarm-catalogue:pg-shared is already registered"]);
	// A blueprint cannot copy credentials into anything it creates.
	const { validateSteps } = await import("../src/blueprints.ts");
	assert.match(validateSteps([{ id: "i", action: "create_record", collection: "service_instances", fields: { title: "x", secret_refs: "[]" }, references: { service: ["$subject"] } }], "services").errors.join(), /cannot be set by a blueprint/);
});

test("operation health needs a recorded maintenance review within the cadence; a scheduled task running is not a review", async () => {
	const svc = await w.draftAs(EDITOR, "services", { title: "Backups", service_kind: "storage", review_cadence_days: 30 });
	assert.equal(await w.publishAs(EDITOR, "services", svc.id), undefined);
	const health = async () => controlReport((await loadEntityState(w.ctx as never, reader(), "services", "SV-0001", "published"))!).operation.find((c) => c.control === "review_current")!;
	assert.equal((await health()).status, "missing");
	const old = await w.attest(EDITOR, "services:SV-0001", "maintenance_review");
	w.db.db.prepare("update ec_evidence set created_at = ? where id = ?").run(new Date(Date.now() - 45 * 86_400_000).toISOString(), old.id);
	assert.equal((await health()).status, "expired");
	await w.attest(EDITOR, "services:SV-0001", "maintenance_review");
	assert.equal((await health()).status, "met");
});

async function activeClient(title = "Acme Lda", domain = "acme.example") {
	const owner = person(w);
	const c = await registeredClient({ title, identifiers: [{ namespace: "domain", value: domain }] }, { owner: [owner.id] });
	const subject = `clients:${String(w.row("clients", c.id)!.code)}`;
	await w.attest(EDITOR, subject, "identity_verified", { identifier: `domain:${domain}` });
	await w.attest(EDITOR, subject, "classification_reviewed");
	await w.editAs(EDITOR, "clients", c.id, { review_cadence_days: 180 });
	await w.attest(EDITOR, subject, "maintenance_plan");
	await w.editAs(EDITOR, "clients", c.id, { lifecycle: "active" });
	const refused = await w.publishAs(EDITOR, "clients", c.id);
	assert.equal(refused, undefined, refused);
	return c;
}

test("an active record keeps its controls: an ordinary edit that would remove one is refused, other edits go through", async () => {
	const c = await activeClient();
	await w.editAs(EDITOR, "clients", c.id, { identifiers: [] });
	const refused = String(await w.publishAs(EDITOR, "clients", c.id));
	assert.match(refused, /would leave an active record without/);
	assert.match(refused, /identifier claimed in the registry/);
	assert.equal(w.row("clients", c.id)!.lifecycle, "active");
	await w.editAs(EDITOR, "clients", c.id, { identifiers: [{ namespace: "domain", value: "acme.example" }], description: "Main account." });
	assert.equal(await w.publishAs(EDITOR, "clients", c.id), undefined);
});

test("registered records leave by retirement: no unpublishing once active, no deleting once ever published", async () => {
	const draft = await w.draftAs(EDITOR, "clients", { title: "Never registered", client_kind: "organization" });
	const intake = await registeredClient();
	assert.equal(await w.trashAs("clients", intake.id), false, "a published record cannot be deleted");
	assert.match(String(await w.unpublishAs(EDITOR, "clients", intake.id)), /Suspend or retire/);
	assert.equal(await w.unpublishAs(ADMIN, "clients", intake.id), undefined, "an administrator may withdraw a mistaken intake registration");
	assert.equal(await w.trashAs("clients", intake.id), false, "it was registered: unpublishing does not make it deletable");
	assert.equal(await w.trashAs("clients", draft.id), true, "a draft that was never published can be deleted");

	const active = await activeClient("Beta Lda", "beta.example");
	assert.match(String(await w.unpublishAs(ADMIN, "clients", active.id)), /retire it/);
});

test("a merge is refused while other records still point at the duplicate; the person relinks them, then merges", async () => {
	const product = await w.draftAs(EDITOR, "products", { title: "Hosting" });
	assert.equal(await w.publishAs(EDITOR, "products", product.id), undefined);
	const dup = await w.draftAs(EDITOR, "clients", { title: "Acme (dup)", client_kind: "organization" }, { products: [product.id] });
	const real = await w.draftAs(EDITOR, "clients", { title: "Acme", client_kind: "organization" });
	assert.equal(await w.publishAs(EDITOR, "clients", dup.id), undefined);
	assert.equal(await w.publishAs(EDITOR, "clients", real.id), undefined);
	await w.editAs(ADMIN, "clients", dup.id, { merged_into: "CL-0002", lifecycle: "retired", merge_rationale: "Same legal entity registered twice; keeping CL-0002." });
	const refused = String(await w.publishAs(ADMIN, "clients", dup.id));
	assert.match(refused, /Before merging, point these at CL-0002/);
	assert.match(refused, /products PR-0001 \(clients_products\)/);

	// The person moves the link in the editor (EmDash replaces the relation), then the merge goes through.
	w.db.db.prepare("delete from _emdash_content_references where parent_group = ?").run(dup.group);
	w.link("clients", real.group, "products", [product.id]);
	assert.equal(await w.publishAs(ADMIN, "clients", dup.id), undefined);
	assert.equal(w.row("clients", dup.id)!.merged_into, "CL-0002");
});
