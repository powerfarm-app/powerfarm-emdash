// Onboarding blueprints executed as EmDash content: triggers, binding to the
// published blueprint revision, work items as the run's state, approvals and
// attention settled in EmDash's editor (save hooks check role and separation),
// idempotency through the unique `origin` field, simulation, and the limits of
// the runner.
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { validateSteps } from "../src/blueprints.ts";
import { ContentReader } from "../src/content.ts";
import { advanceRun, allRuns, previewRun, viewRun } from "../src/onboarding.ts";
import { ADMIN, ADMIN2, AI, EDITOR, makeWorld, person, type World } from "./entity-world.ts";
import { loadSeed } from "./sqlite-port.ts";

const ONBOARDING = (loadSeed().content!.blueprints![0]!.data as { steps: unknown[] }).steps;

let w: World;
let reader: ContentReader;
beforeEach(() => {
	w = makeWorld();
	reader = new ContentReader(w.db.port());
});

async function register(title = "Acme Lda", extra: Record<string, unknown> = {}, refs: Record<string, string[]> = {}, actor = EDITOR) {
	const c = await w.draftAs(actor, "clients", { title, client_kind: "organization", identifiers: [{ namespace: "vat", value: "PT510000001" }], ...extra }, refs);
	assert.equal(await w.publishAs(actor, "clients", c.id), undefined);
	return c;
}

async function onlyRun() {
	const runs = await allRuns(w.ctx as never);
	assert.equal(runs.length, 1, `expected one run, found ${runs.length}`);
	return (await viewRun(w.ctx as never, reader, runs[0]!.key))!;
}

const workItems = () => w.db.db.prepare("select id, code, title, work_kind, work_status, origin, status, step_id from ec_work_items where deleted_at is null order by origin").all() as Array<Record<string, string>>;
const item = (step: string) => workItems().find((i) => i.step_id === step && !String(i.origin).includes("!attention"))!;
const statusOf = (run: { steps: Array<{ id: string; status: string }> }) => Object.fromEntries(run.steps.map((s) => [s.id, s.status]));

test("only the declared trigger starts a run: draft saves do nothing, registration starts one run once, later publishes do not", async () => {
	w.publishedBlueprint(ONBOARDING);
	const draft = await w.draftAs(EDITOR, "clients", { title: "Acme", client_kind: "organization" });
	assert.equal((await allRuns(w.ctx as never)).length, 0, "a draft save starts nothing");
	assert.equal(await w.publishAs(EDITOR, "clients", draft.id), undefined);
	const run = await onlyRun();
	assert.equal(run.initiatedBy, `user:${EDITOR.id}`);
	await w.editAs(EDITOR, "clients", draft.id, { title: "Acme Lda" });
	assert.equal(await w.publishAs(EDITOR, "clients", draft.id), undefined);
	await onlyRun();
});

test("a run reads its steps from the published blueprint revision; editing the blueprint later changes nothing; drafts never run", async () => {
	const bp = w.publishedBlueprint([{ id: "call", action: "create_task", title: "Call {{subject.title}}" }]);
	w.db.insert("blueprints", { title: "d", code: "BP-DRAFT", target_collection: "clients", trigger: "registered", steps: [{ id: "x", action: "record_provenance", title: "draft" }] }, { status: "draft" });
	w.db.db.prepare("update ec_blueprints set steps = ? where id = ?").run(JSON.stringify([{ id: "other", action: "record_provenance", title: "changed" }]), bp.id);
	await register();
	const run = await onlyRun();
	assert.equal(run.templateRevision, bp.liveRevisionId);
	assert.deepEqual(run.definition.map((s) => s.id), ["call"], "the revision's steps, not the edited columns");
	assert.equal(workItems().length, 1);
});

test("client onboarding end to end, entirely as content: tasks, a draft contract, an approval given in the editor, a control that closes itself", async () => {
	w.publishedBlueprint(ONBOARDING);
	const owner = person(w);
	const client = await register("Acme Lda", {}, { owner: [owner.id] });
	let run = await onlyRun();
	assert.deepEqual(statusOf(run), {
		owner: "skipped",
		identity: "succeeded",
		classification: "succeeded",
		access: "skipped",
		links: "succeeded",
		contract: "succeeded",
		contract_review: "waiting",
		maintenance: "succeeded",
		identity_check: "waiting",
		done: "pending",
	});
	assert.equal(run.status, "waiting_approval");
	assert.ok(workItems().every((i) => i.status === "published"), "work items are live EmDash entries");
	const skipped = item("owner");
	assert.equal(skipped.work_status, "skipped", "a skipped step is recorded, so it is visible and stable");

	const contract = w.db.db.prepare("select id, status, lifecycle, classification, translation_group, origin from ec_contracts").get() as Record<string, string>;
	assert.equal(contract.status, "draft");
	assert.equal(contract.lifecycle, "intake");
	assert.equal(contract.classification, "confidential");
	const edges = w.db.db.prepare("select r.slug, c.parent_group from _emdash_content_references c join _emdash_relations r on r.id = c.relation_id where c.child_group = ?").all(contract.translation_group!) as Array<Record<string, string>>;
	assert.deepEqual(edges.map((e) => e.slug).sort(), ["clients_contracts", "people_contracts"]);
	assert.equal(edges.find((e) => e.slug === "clients_contracts")!.parent_group, client.group);

	// The approval is given in EmDash's editor: the save hook checks role, decision and reason.
	const approval = item("contract_review");
	await assert.rejects(w.editAs(EDITOR, "work_items", approval.id, { work_status: "done", decision: "approve", resolution: "Looks fine to me." }), /administrator/);
	await assert.rejects(w.editAs(ADMIN, "work_items", approval.id, { work_status: "done", resolution: "Looks fine." }), /Decision to approve/);
	await assert.rejects(w.editAs(ADMIN, "work_items", approval.id, { work_status: "done", decision: "approve", resolution: "ok" }), /reason/);
	await assert.rejects(w.editAs(AI, "work_items", approval.id, { work_status: "done", decision: "approve", resolution: "Approved by AI." }, "mcp"), /AI clients/);
	await w.editAs(ADMIN, "work_items", approval.id, { work_status: "done", decision: "approve", resolution: "Terms ready to negotiate." });
	assert.equal(w.row("work_items", approval.id)!.resolved_by, `user:${ADMIN.id}`, "the hook records who resolved it");
	run = (await viewRun(w.ctx as never, reader, run.key))!;
	assert.equal(statusOf(run).contract_review, "succeeded");

	// The control item cannot be closed by hand; recording the attestation closes it.
	const control = item("identity_check");
	await assert.rejects(w.editAs(ADMIN, "work_items", control.id, { work_status: "done" }), /closes by itself/);
	await w.attest(EDITOR, "clients:CL-0001", "identity_verified", { identifier: "vat:PT510000001" });
	run = (await viewRun(w.ctx as never, reader, run.key))!;
	assert.equal(run.status, "succeeded", JSON.stringify(statusOf(run)));
	assert.equal(w.row("work_items", control.id)!.work_status, "done");
	assert.equal(item("done").work_kind, "note");
	assert.equal(w.row("clients", client.id)!.lifecycle, "intake", "the runner never changes the record's lifecycle");

	const before = { ...w.creates };
	await advanceRun(w.ctx as never, reader, run.key);
	assert.deepEqual(w.creates, before, "another pass creates nothing");
});

test("concurrent passes create each item once: EmDash's unique origin decides", async () => {
	w.publishedBlueprint(ONBOARDING);
	await register();
	const { key } = await onlyRun();
	await Promise.all([advanceRun(w.ctx as never, reader, key), advanceRun(w.ctx as never, reader, key), advanceRun(w.ctx as never, reader, key)]);
	const items = workItems();
	assert.equal(new Set(items.map((i) => i.origin)).size, items.length);
	assert.equal((w.db.db.prepare("select count(*) as n from ec_contracts").get() as { n: number }).n, 1);
});

test("a step that cannot work raises an attention item; an administrator settles it in the editor (give up blocks dependants)", async () => {
	w.publishedBlueprint([
		{ id: "note", action: "record_provenance", title: "Started for {{subject.title}}" },
		{ id: "contract", action: "create_record", collection: "contracts", fields: { title: "x" }, references: { client: ["$subject.products"] } },
		{ id: "review", action: "request_approval", title: "Review", dependsOn: ["contract"] },
	]);
	await register();
	let run = await onlyRun();
	assert.equal(statusOf(run).contract, "needs_attention");
	assert.match(run.steps.find((s) => s.id === "contract")!.message!, /points at clients/);
	assert.equal(statusOf(run).review, "pending", "dependants wait while a person decides");
	assert.equal(run.status, "needs_attention");
	const attention = workItems().find((i) => i.work_kind === "attention")!;
	await assert.rejects(w.editAs(EDITOR, "work_items", attention.id, { work_status: "done", decision: "give_up", resolution: "Blueprint references the wrong field." }), /administrator/);
	await w.editAs(ADMIN, "work_items", attention.id, { work_status: "done", decision: "give_up", resolution: "Blueprint references the wrong field." });
	run = (await viewRun(w.ctx as never, reader, run.key))!;
	assert.equal(statusOf(run).contract, "failed");
	assert.equal(statusOf(run).review, "blocked");
	assert.equal(run.status, "partially_failed");
});

test("transient errors are retried within the step's limit; then a person decides: retry runs it again, done_by_hand completes it", async () => {
	w.publishedBlueprint([{ id: "task", action: "create_task", title: "Call {{subject.title}}", retries: 1 }]);
	w.failCreates.work_items = 2;
	await register();
	let run = await onlyRun();
	assert.equal(statusOf(run).task, "needs_attention");
	assert.match(run.steps[0]!.message!, /database is locked/);
	const attention = workItems().find((i) => i.work_kind === "attention")!;
	await w.editAs(ADMIN, "work_items", attention.id, { work_status: "done", decision: "retry", resolution: "The database was locked; retry now." });
	run = (await viewRun(w.ctx as never, reader, run.key))!;
	assert.equal(run.status, "succeeded", "the save hook re-ran the step");
	assert.ok(item("task"));
});

test("approvals can require separation: the person who registered the record cannot approve; a rejection fails the step", async () => {
	w.publishedBlueprint([{ id: "ok", action: "request_approval", title: "Second look", requiredRole: 50, separateFromInitiator: true }]);
	await register("Acme", {}, {}, ADMIN);
	const wi = item("ok");
	await assert.rejects(w.editAs(ADMIN, "work_items", wi.id, { work_status: "done", decision: "approve", resolution: "Approving my own registration." }), /cannot also give this approval/);
	await w.editAs(ADMIN2, "work_items", wi.id, { work_status: "rejected", decision: "reject", resolution: "Not this client." });
	assert.equal((await onlyRun()).status, "failed");
	await assert.rejects(w.editAs(ADMIN2, "work_items", wi.id, { work_status: "done" }), /closed/);
});

test("people create only plain tasks; Powerfarm's fields on blueprint work items are protected", async () => {
	w.publishedBlueprint([{ id: "call", action: "create_task", title: "Call" }]);
	await register();
	await assert.rejects(w.draftAs(EDITOR, "work_items", { title: "x", work_kind: "approval", work_status: "open" }), /created by blueprint runs/);
	await assert.rejects(w.draftAs(EDITOR, "work_items", { title: "x", work_kind: "task", work_status: "open", run_id: "fake" }), /maintained by Powerfarm/);
	const call = item("call");
	await assert.rejects(w.editAs(EDITOR, "work_items", call.id, { run_id: "other" }), /maintained by Powerfarm/);
	await w.editAs(EDITOR, "work_items", call.id, { work_status: "done", resolution: "Called." });
	assert.equal(w.row("work_items", call.id)!.work_status, "done");
});

test("on an EmDash without patch 0002 the dropped references are detected: the step needs attention instead of succeeding", async () => {
	w.publishedBlueprint([{ id: "contract", action: "create_record", collection: "contracts", fields: { title: "Agreement" }, references: { client: ["$subject"] } }]);
	const patched = w.content.create;
	w.content.create = (collection: string, data: Record<string, unknown>) => patched(collection, data);
	await register();
	const run = await onlyRun();
	assert.equal(statusOf(run).contract, "needs_attention");
	assert.match(run.steps[0]!.message!, /upstream\/patches\/0002/);
});

test("simulation writes nothing and counts for nothing", async () => {
	const bp = w.publishedBlueprint(ONBOARDING);
	const client = await w.draftAs(EDITOR, "clients", { title: "Preview Co", client_kind: "organization", classification: "confidential" });
	const before = { creates: { ...w.creates }, runs: (await allRuns(w.ctx as never)).length };
	const [entity] = await reader.byGroups("blueprints", [w.groupOf("blueprints", bp.id)!], "published");
	const preview = await previewRun(reader, entity!, "clients", String(client.data.code));
	assert.equal(preview.simulated, true);
	assert.deepEqual(preview.errors, []);
	assert.equal(preview.steps.find((s) => s.id === "access")!.outcome, "would_run", "confidential clients get the access review");
	assert.equal(preview.steps.find((s) => s.id === "contract_review")!.outcome, "would_wait");
	assert.deepEqual({ creates: w.creates, runs: (await allRuns(w.ctx as never)).length }, before);
});

test("the action catalogue is closed: no code, no unknown actions, fields or placeholders, no forward dependencies", () => {
	const bad = (steps: unknown[]) => validateSteps(steps, "clients").errors.join(" | ");
	assert.deepEqual(validateSteps(ONBOARDING, "clients").errors, [], "the seeded blueprint validates");
	assert.match(bad([{ id: "x", action: "http_request", url: "https://example.com" }]), /unknown action/);
	assert.match(bad([{ id: "x", action: "create_task", title: "${process.env.SECRET}" }]), /looks like code/);
	assert.match(bad([{ id: "x", action: "create_task", title: "Hi {{subject.data.password}}" }]), /unknown placeholder/);
	assert.match(bad([{ id: "x", action: "create_task", title: "t", dependsOn: ["y"] }, { id: "y", action: "create_task", title: "t" }]), /earlier step/);
	assert.match(bad([{ id: "x", action: "create_record", collection: "clients", fields: { title: "t" } }]), /collection must be one of/);
	assert.match(bad([{ id: "x", action: "create_record", collection: "contracts", fields: { title: "t", lifecycle: "active" } }]), /cannot be set by a blueprint/);
	assert.match(bad([{ id: "x", action: "create_record", collection: "contracts", fields: { title: "t" }, references: { client: ["CL-0001"] } }]), /\$subject/);
	assert.match(bad([{ id: "x", action: "create_task", title: "t", assignee: "user:admin-1" }]), /\$subject.owner/);
	assert.match(bad([{ id: "x", action: "request_approval", title: "t", requiredRole: 10 }]), /requiredRole/);
	assert.match(bad([{ id: "x", action: "wait_for_control", control: "be_nice" }]), /control must be one of/);
});

test("blueprints are activated only by administrators, only when valid; the runner cannot publish records", async () => {
	await assert.rejects(w.draftAs(EDITOR, "blueprints", { title: "x", code: "BP-X", target_collection: "clients", trigger: "registered", steps: [{ id: "x", action: "shell", cmd: "rm -rf /" }] }), /not valid/);
	const ok = await w.draftAs(EDITOR, "blueprints", { title: "x", code: "BP-X", target_collection: "clients", trigger: "registered", steps: [{ id: "x", action: "record_provenance", title: "t" }] });
	assert.match(String(await w.publishAs(EDITOR, "blueprints", ok.id)), /administrator/);
	assert.equal(await w.publishAs(ADMIN, "blueprints", ok.id), undefined);
	const client = await w.draftAs(EDITOR, "clients", { title: "Plugin cannot publish", client_kind: "organization" });
	await assert.rejects(w.content.publish("clients", client.id), /signed-in person/);
});

test("a draft created without its links needs attention until a person links it by hand and chooses retry", async () => {
	w.publishedBlueprint([{ id: "contract", action: "create_record", collection: "contracts", fields: { title: "Agreement" }, references: { client: ["$subject"] } }]);
	const patched = w.content.create;
	w.content.create = (collection: string, data: Record<string, unknown>) => patched(collection, data);
	const client = await register();
	w.content.create = patched;
	const attention = () => workItems().filter((i) => i.work_kind === "attention");
	await w.editAs(ADMIN, "work_items", attention()[0]!.id, { work_status: "done", decision: "retry", resolution: "Retrying before linking, to see it refused." });
	let run = await onlyRun();
	assert.equal(run.status, "needs_attention", "still unlinked: a new attention item");
	assert.equal(attention().length, 2);
	const contract = w.db.db.prepare("select translation_group from ec_contracts").get() as { translation_group: string };
	w.db.link("clients_contracts", client.group, contract.translation_group);
	await w.editAs(ADMIN, "work_items", attention()[1]!.id, { work_status: "done", decision: "retry", resolution: "Linked the client by hand in the editor." });
	run = await onlyRun();
	assert.equal(run.status, "succeeded");
});
