# Implementation report — Powerfarm EmDash Platform 1.2.1

Date: 2 November 2026. Base: EmDash `981c78d` (1.4.0) with patches 0001 and 0002.
Scope agreed before coding: instantiation, identity and security; authority and
maintenance minimal; everything else deferred (docs/ONTOLOGY-V1.2.md §8).

## 1.2.2 — ready for a live test on Cloudflare, with the lab Macs as workers

Deployment decision (ADR-0010): EmDash on Cloudflare (Workers, D1, R2, Cron
Trigger) behind Cloudflare Access; device work and large files stay on the lab
Macs, which pull jobs. Runbook: [DEPLOYMENT-CLOUDFLARE.md](DEPLOYMENT-CLOUDFLARE.md).

Read again in EmDash `981c78d` before changing anything:

| Fact in EmDash | Where | Consequence |
| --- | --- | --- |
| `@emdash-cms/cloudflare` provides `d1()`, `r2()`, `access()` and the Worker's `scheduled()` handler, which runs plugin cron through `runtime.runScheduledTasks` | `packages/cloudflare/src`, `core/src/astro/middleware.ts` | The plugin runs unchanged in the Worker; its tasks run on the Cron Trigger |
| Trusted plugins run in the host Worker; only `sandboxed` ones need the Worker Loader | `demos/cloudflare/astro.config.mjs` | Patch 0002 (trusted only) still applies; no Loader binding, nothing installable at runtime |
| `getDb()` returns the request's database (on D1, the request's session) from AsyncLocalStorage | `core/src/loader.ts` | **Fixed**: our read port cached the first handle for the life of the isolate; it now opens per use |
| D1 allows 100 bound parameters per statement (EmDash chunks its own queries) | `core/src/database/repositories/relation.ts` and others | **Fixed**: our `IN` lists went up to 500 and were silently truncated beyond that; now chunks of 45, merged in id order |
| EmDash reads the client address from `CF-Connecting-IP` on Cloudflare | `core/src/plugins/request-meta.ts` | The bridge address allowlist works on Workers |
| `r2()` without `publicUrl` serves files through `/_emdash/api/media/file/` | `packages/cloudflare/src/storage/r2.ts` | Patch 0001 keeps evidence private on R2 too |
| `unpublish` keeps `published_at` | `core/src/database/repositories/content.ts` | "Was ever registered" survives an unpublish (used by the delete rule) |
| D1 dumps must leave out FTS5 tables and come in four files | `docs/guides/backups.mdx` | `cf-backup.mjs` follows that procedure |

Fixed in Powerfarm:

- **Lifecycle integrity.** Publishing an edit of an active record is refused if it
  would lose a control the record has now. Active and suspended records cannot be
  unpublished (retire them); anything ever published cannot be deleted.
- **Merge honesty.** A merge is refused while other records link to the duplicate
  (relations other than its owner, open work about it); the message lists them
  for a person to re-point. Closed work and evidence keep naming the duplicate.
- **Bridge under lab outages.** Evidence and final reports go to a disk outbox
  first and are delivered in order, with a report id fixed when queued; no new job
  is claimed while results wait; a restart after the result was queued no longer
  reports a finished job as interrupted; refusals from EmDash are set aside in
  `outbox/rejected/` (shown by `doctor`), credential problems keep waiting.
- **Bridge through Access.** Service-token headers, no following of Access's login
  redirect, clear error when Access refuses, https required except for private
  addresses.

Added: `site/astro.config.mjs` (Cloudflare), `site/astro.config.node.mjs` (the
previous Node config), `site/wrangler.jsonc`, `site/src/worker.ts`,
`scripts/edge-check.mjs`, `scripts/cf-backup.mjs`, `bridge/src/outbox.mjs`,
`bridge/launchd/org.powerfarm.cf-backup.plist`, ADR-0010, release 1.2.2, tests
`d1-port`, `cloudflare`, bridge `outbox` and `client-access`.

Tests: plugin **118** pass (1.1's 69 unchanged; 1.2's 39; 1.2.2 adds 3 lifecycle
and merge tests, 2 D1 read-port tests, 5 deployment-pack tests), bridge **28**
pass (22 + 6). Seeds valid under EmDash's validator.

**Not run**: anything on Cloudflare (deploy, Access, D1, R2, the cron), `wrangler`
and `aws` commands in `cf-backup.mjs` (its dump-to-backup path is tested with a
dump shaped like wrangler's), EmDash's build and vitests, the admin UI, MCP over
HTTP, hardware. The first live test is section 9 of the runbook.

One rule changed: bridge routes used to be "never internet-exposed" (private LAN).
On Cloudflare they are on the internet but unreachable without the bridge's Access
service token; the HMAC signature, nonce and optional address allowlist remain
behind it. `edge-check.mjs` proves the perimeter from outside.

---

1.2.1 keeps every 1.2 capability and re-implements it with EmDash's own
constructs. 1.2.0 had grown a small platform beside EmDash (its own identity
store, run store, approval routes and three admin pages); 1.2.1 removes all of
that.

## What moved from custom to native

| Capability | 1.2.0 (custom) | 1.2.1 (EmDash) |
| --- | --- | --- |
| Identity registry | plugin storage `identifiers`, compare-and-set ids | `identifiers` **collection**; `namespace:value` is a `unique` field; history = revisions |
| Release of an identifier | delete from storage | rename the entry to `released/<id>/…` (keeps revisions; frees the unique value) |
| Transfer | session route `identity/transfer` | an administrator edits the entry's *Identifies* with a rationale; `beforeSave` checks |
| Merge | session route `identity/merge` + work item | `merged_into` + `retired` on the duplicate, then publish |
| Onboarding run state | plugin storage `runs`, leases, step snapshots | `work_items`, one per step, unique `origin`; state derived; KV holds only the run descriptor |
| Steps bound to a template | copied into the run | read from the EmDash **revision** live when the run started |
| Approvals | route `automation/resolve-work` | editing the work item (*Decision*, *Status*, note); `beforeSave` enforces role and separation |
| Needs-attention resolution | route `automation/resolve-step` | admin-only *attention* work item with `retry` / `done_by_hand` / `give_up` |
| Run history | journal streams per subject | revisions of the work items and the audit log |
| Register page | custom admin page, REST create | native editor + field widget `powerfarm:identifiers` + editor panel (duplicates, controls, what publishing starts) |
| Services page | custom admin page | native list of `services`/`service_instances` with list columns; `secret_refs` field widget |
| Automation page | custom admin page | Content → Work items (list columns, due date), editor panel, *Open work* dashboard widget |
| Lifecycle / classification columns | plugin columns | native `admin.listColumns` |

What remains plugin code: the hooks (policy and gates), control evaluation, the
blueprint validator and runner (a cron task), the graph, the read routes behind
the panel and widgets, two field widgets, and the MCP tools.

## What was verified against the pinned EmDash source before building

| Fact | Where | Consequence |
| --- | --- | --- |
| Plugin `content.create` runs the runtime create pipeline (hooks, validation) but never forwards `references` | `emdash-runtime.ts` contentCreate callback | Patch 0002; runner verifies edges after each create |
| Plugin `content.update` bypasses hooks and stages drafts on draft-enabled collections | `plugins/context.ts` | The runner never edits entities; linking existing records is a person's work item |
| `content.publish` runs `beforePublish` with origin `plugin` | runtime | Entity publishes from a plugin are refused (no actor) |
| MCP plugin tools need only `mcp:tools:<plugin>`; core content tools need `content:read` | `mcp/server.ts` | AI tokens get only `mcp:tools:powerfarm`, so classification cannot be bypassed through core tools |
| `unique: true` seed fields become a database unique index that also covers trashed rows | `schema/registry.ts` | Identifier and origin uniqueness are the database's; release renames rather than trashes |
| Field `widget: "<plugin>:<name>"` and collection `admin.listColumns` | seed schema, admin field renderer | Identifiers and secret references get widgets; native list columns replace plugin columns |
| `ctx.content.getRevision` / `listRevisions` | plugin content access | Runs read steps from the bound revision; the panel shows revisions |
| Seed `--on-conflict update` upserts fields of listed collections; relation endpoints may be existing collections | `seed/apply.ts` | Additive migration seed with `evidence` in full |
| Reference field binding derives `targetCollection` from the relation | `seed/apply.ts` | Seed reference fields declare relation and side only |

## EmDash changes

**patches/emdash/0002-plugin-create-references.patch** (+33 lines, +35 lines of
vitest): `ContentCreateOptions.references`; shape-checked in plugin content
access; forwarded to `handleContentCreate`, which validates relation, target and
required fields in the same transaction; refused for sandboxed plugins and on
the direct path that has no handler. Recorded as ADR-0008. Applies cleanly
together with 0001 to `981c78d` (`git apply --check`); the changed lines
type-check against the EmDash source; the vitest file was **not** run.

## Files

**New in 1.2:** plugin `entities.ts`, `identity.ts`, `controls.ts`,
`blueprints.ts`, `onboarding.ts`, `entity-policy.ts`, `entity-services.ts`,
`entity-tasks.ts`, `admin/fields.tsx`; tests `entities.test.ts`,
`identity.test.ts`, `runs.test.ts`, `entity-world.ts`;
`site/seed/migrations/1.2.0.json`; `scripts/migrate-1.2.sh`;
`patches/emdash/0002-…`; docs `ONTOLOGY-V1.2.md`, `ENTITIES.md`, this report.

**Removed in 1.2.1:** `runs.ts`, `admin/EntityPages.tsx`, plugin storage
`identifiers` and `runs`, routes `automation/resolve-work`,
`automation/resolve-step`, `automation/process`, `identity/transfer`,
`identity/merge`, and the `workflow_run` graph type.

**Modified:** plugin `model.ts` (9 collections, subject links, settings,
version 1.2.1), `ontology.ts`, `access.ts`, `graph.ts`, `policy.ts`,
`reconcile.ts`, `routes.ts`, `schemas.ts`, `index.ts`, admin `api.ts`,
`panels.tsx`, `columns.tsx`, `widgets.tsx`, `index.tsx`;
`site/seed/build_seed.py` and `seed.json`; `site/package.json`,
`plugin/package.json`; `scripts/setup.sh`, `scripts/smoke.mjs`; docs README,
ARCHITECTURE, DEPLOYMENT, ONTOLOGY, ENGINEERING, MIGRATION, PUBLICATION.

## Model and relation changes

9 collections (`clients`, `products`, `services`, `service_instances`,
`contracts`, `blueprints`, `work_items`, `exceptions`, `identifiers`), 17
relations, `evidence.subject`, `evidence.identifier`, eight attestation kinds.
No new plugin storage. Cron: `blueprints` (every minute), `identity` (every 15
minutes). Setting: `tokenMaxClassification`.

## Implemented, partial, planned

| Area | State |
| --- | --- |
| Entity contract, codes, lifecycle, classification | implemented |
| Registration with duplicate detection; AI proposals | implemented |
| Lifecycle gates with derived controls; exceptions | implemented |
| Identity registry (unique field), concurrency-safe claims, release, transfer, merge, derived status, asset mirror | implemented |
| Secret hygiene and secret references | implemented (pattern-based detection: it catches common credential shapes, not every possible secret) |
| Service catalogue and instances, shared across projects/products | implemented (no per-edge attributes such as quota or SLA) |
| Blueprints: templates, revision binding, six actions, conditions, dependencies, retries, approvals, waits, preview, needs-attention resolution | implemented |
| Authority | minimal: EmDash roles + per-stage role rules + second-person setting; no grants or delegation |
| Maintenance | minimal: review cadence, maintenance plan/review attestations, renewal dates; no scheduled maintenance work |
| Subflows, compensation, notifications, external adapters, incidents, experiments | not implemented (deferred) |
| Classification in EmDash's own admin and REST | **not enforced** (EmDash core has no such concept) |

## Tests

| Suite | Result |
| --- | --- |
| Plugin: 108 tests (1.1's 69 unchanged; entities 16, identity 10, runs 13) | **pass** — Node 22, real hooks over a SQLite database built from the seed, with a content API that enforces unique fields (including trashed rows), required references and relation targets, stages drafts like EmDash, writes real relation edges and stores revisions |
| Bridge: 22 | **pass** (unchanged) |
| `seed.json` and `migrations/1.2.0.json` | **valid** under EmDash's own `validateSeed`, run from the pinned source |
| TypeScript, plugin sources | no errors except those caused by the absent `zod`, `react` and Kumo type packages |
| Patch 0002 | applies with 0001; changed lines type-check; vitest **not run** |

Every correction or rule in scope has a test:

- stable identity under rename, and codes that cannot change once published;
- duplicate identifiers refused, including concurrent claims;
- identity transfer and merge are administrators only, with a rationale, and keep revisions;
- a released identifier can be claimed again, and its entry keeps its history;
- Mission 001 ids and journals untouched;
- a second project or product links to the catalogue service instead of copying it, and credentials are never copied;
- missing controls block activation;
- AI cannot publish, activate, lower a classification, create work items, approve or attest;
- classification is enforced across roles and tokens;
- the maintenance review must be recorded;
- only declared triggers start a run, and draft saves start nothing;
- repeated events and resumed runs do not duplicate effects, and concurrent workers are safe;
- each run reads its steps from its template revision, even after the blueprint changes;
- a draft created without its links (unpatched EmDash) raises attention until a person links it and retries;
- failed and ambiguous steps stay visible;
- approvals block the steps that depend on them, and separation is enforced;
- simulation writes nothing;
- the action catalogue cannot express code.

**Not run** (npm unreachable from the build workspace):

- install and build against EmDash;
- both patches' vitest files and `astro check`;
- the field widgets, editor panel, list columns and widgets in a browser;
- MCP over HTTP, including the eight new tools;
- the EmDash scheduler driving the two new tasks;
- `emdash seed` applying the migration to a real 1.1 database;
- a backup/restore rehearsal of a 1.2 database created by EmDash.

`scripts/setup.sh`, `scripts/migrate-1.2.sh` and `scripts/smoke.mjs` run these on
your machine.

## Security and authority implications

- New write paths:
  - `propose_entity` creates intake drafts with a field denylist;
  - the runner creates drafts, work items and registry entries;
  - people resolve work items and edit registry entries in the native editor, gated by `beforeSave`.
  
  None of them publishes an entity, changes a lifecycle, or grants anything.
- Approvals check the role, refuse AI and token callers, and can require a different person.
- The token cap and the `mcp:tools:powerfarm`-only token scope are what keep confidential records away from AI clients. If a token is given `content:read`, EmDash's own tools can read every record.
- Secret detection is heuristic. It is a guard against mistakes, not a scanner to rely on.

## Known limitations and risks

1. **Runtime integration is unproven**:
   - the publish event's `content.data` shape for draft collections;
   - plugin `content.update` on `work_items` and `identifiers` (staged drafts, then publish);
   - the props EmDash passes to plugin field widgets;
   - admin component APIs.
   
   These are the most likely first fixes.
2. **EmDash's admin ignores classification.** Editors can open restricted records in Content. A patch 0003 or a role change would be needed to enforce it there.
3. **Patch 0002 is one more patch to carry on EmDash upgrades.** Without it, runs stop at *needs attention* rather than misbehave.
4. **Identifier claims and record publish are not one transaction.** A registry entry can outlive a publish that another hook cancels; the identity task releases it after five minutes, and until then the identifier appears taken.
7. **The admin edit path for work items and registry entries relies on `beforeSave` seeing the acting user.** If EmDash passes no user for a save, the save is refused (safe, but it would block decisions).
5. **Merges are a person's publish of the duplicate** (`merged_into` + `retired`); the plugin moves the identifiers afterwards. If that step fails, the `identity` task finishes it from the publish marker.
6. **Work items assigned via `$subject.owner` need a `people` record.** EmDash users and people are not linked yet.

## Next smallest step

Run `setup.sh` on LAB 512's VM (after Mission 001 has recovered it), then
`migrate-1.2.sh` or a fresh seed, then the smoke test. Register one real client
end to end with the onboarding blueprint published, and record what broke.
