# v1.2 ontology and migration proposal: entities, identity, security

Scope agreed for 1.2: **instantiation** (register entities through a guided,
approved path that can launch an onboarding blueprint), **identity** (a registry
of identifiers unique across entity types) and **security** (classification and
evidence-backed lifecycle controls). Authority and maintenance are kept minimal.
Mission 001 is untouched.

Everything is EmDash: collections and relations in the seed, publication as
approval, revisions for exact binding, unique fields for identity and
idempotency, work items for execution state, editor saves for decisions, cron for
the worker, field widgets, list columns, panels and widgets for screens. Nothing runs outside EmDash.

## 1. What v1.1 already gives, verified in code

| Need | v1.1 mechanism reused |
| --- | --- |
| Human approval | `content:beforePublish` cancels; AI (`origin.source === "mcp"`) cannot publish `HUMAN_PUBLISHED` collections |
| Exact binding | job id `<entry>:<liveRevisionId>`; same pattern for blueprint runs |
| Durable, idempotent execution | `unique` content fields (`origin`), KV compare-and-set for the run descriptor |
| History | EmDash revisions and the audit log (1.2 entities); hash-chained journal (Mission 001) |
| Evidence | `evidence` collection: append-only, server-hashed files, `signed_by` from the session |
| Derived status | `deriveStatus` + `acceptanceChecklist` for assets; same idea for entity controls |
| Graph | content nodes from any collection in `COLLECTIONS`, native relations, staged references, link fields, storage nodes |

## 2. What I verified in EmDash 981c78d before designing

- `ctx.content.create(collection, data, options)` goes through
  `runtime.handleContentCreate` (hooks, validation), but **cannot set reference
  fields**: references are a separate `references` body field the plugin path
  never forwards (`emdash-runtime.ts` contentCreate callback). Required
  reference fields therefore cannot be created by a plugin at all.
- `ctx.content.update` writes through `ContentRepository.updateDraftAware`
  directly: no save hooks, no references, and on collections with drafts it
  stages a draft revision rather than changing live values.
- `ctx.content.publish(collection, id, { _rev })` exists and runs
  `beforePublish` with `origin.source = "plugin"`.
- MCP plugin tools need only the `mcp:tools:<plugin>` token scope; EmDash's own
  content tools need `content:read`. A token with only `mcp:tools:powerfarm`
  cannot read content except through Powerfarm's filtered routes.
- Seed re-application with `--on-conflict update` adds new collections, fields
  and relations to an existing database; `--on-conflict skip` adds only missing
  content entries.

Consequence: **patch 0002** lets trusted, in-process plugins pass
`references` to `ctx.content.create`, validated by EmDash's own create handler
in the same transaction (sandboxed plugins refused). 18 lines plus a vitest.
This supersedes ADR-0003's rejected alternative *for new entity records only*;
recovery records keep link fields. Linking two **existing** records is left to a
person in the native editor (the runner creates a work item asking for it),
because plugin updates bypass hooks and stage drafts.

## 3. Entities

### Reused, unchanged

`projects`, `people`, `software`, `assets` (keeps its Mission 001 meaning — it is
hardware, never a generic object bucket), `research`, engineering collections.

### New entity collections

All share the **entity contract**:

| Field | Meaning |
| --- | --- |
| `title` | display name; never an identifier |
| `code` | business key, unique, allocated if empty (`CL-0001`…) |
| EmDash id / translation group | stable machine identity (graph id `type:<group>`) |
| `lifecycle` | `intake` → `active` ↔ `suspended` → `retired` (final) |
| `classification` | `public`, `internal`, `confidential`, `restricted` (required) |
| `owner` | native relation to `people` (accountable owner) |
| `identifiers` | `[{namespace, value, issuer?}]` (field widget `powerfarm:identifiers`), claimed in the identity registry |
| `review_cadence_days` | maintenance review interval |
| `merged_into`, `merge_rationale` | set on a duplicate retired into another record (administrator) |
| `origin` | `run#step` when a blueprint created it (unique; makes creation idempotent) |
| `prepared_by_ai` | set by the hook for MCP-origin drafts |

| Collection | Type | Notes |
| --- | --- | --- |
| `clients` | client | organisation or individual; `legal_name`, `country`, `website` |
| `products` | product | what Powerfarm offers or runs |
| `services` | service | **canonical catalogue**: registered once, referenced by projects, products, contracts |
| `service_instances` | service_instance | one concrete deployment: `environment`, `region`, `endpoint`, `secret_refs`; must reference its service |
| `contracts` | contract | metadata, dates and the signed document (file); default `confidential` |

Kept distinct on purpose: **service** (what is offered) ≠ **service instance**
(where it runs) ≠ **software** (what implements it) ≠ **asset** (hardware it
runs on). `organization` stays a planned type; a client carries `client_kind`.

### New supporting collections

| Collection | Purpose |
| --- | --- |
| `blueprints` | onboarding templates: target collection, trigger, typed steps (JSON validated by the plugin). Drafts + revisions; publishing by an administrator activates that revision |
| `work_items` | human tasks, approvals, link requests, control checks, attention items and notes; created by blueprints (one per step) or people; `subject` = `<collection>:<KEY>`; they *are* the run state |
| `identifiers` | the identity registry: one entry per identifier |
| `exceptions` | security exceptions: subject, control, rationale, expiry; publishing by an administrator is the risk acceptance |

### Relations (native) — 17 new

`people_clients`, `people_products`, `people_services`,
`people_service_instances`, `people_contracts` (owner); `clients_products`
(subscribes to), `clients_projects` (sponsors), `products_services` (uses),
`services_software` (implemented by), `services_instances` (has instance),
`service_instances_assets` (runs on), `projects_services` (uses shared service),
`projects_service_instances` (uses instance), `clients_contracts` (party to),
`contracts_products` (covers), `contracts_services` (covers),
`people_work_items` (assignee).

Allocation records with attributes (quota, cost centre, SLA per project) are
**not** added in 1.2: no requirement has needed attributes on the edge yet. When
one does, it becomes its own collection, not an edge property.

### Polymorphic subject links

`work_items.subject`, `exceptions.subject` and the new `evidence.subject` hold
`<collection>:<KEY>` (e.g. `clients:CL-0001`), validated on save. The graph
shows them as `concerns`, `waives` and `evidence_for` edges.

## 4. Identity

The `identifiers` collection, one entry per identifier: `identifier`
(`<namespace>:<normalised value>`, a **unique** field), `namespace`, `value`,
`subject` (`<collection>:<KEY>`), `source` (`record`, `asset_mirror`,
`transfer`) and `rationale`. Uniqueness across all entity types is EmDash's own
unique index: during `beforePublish` the plugin creates the entries a record
lists; of two concurrent publishes, the second create fails on the index and that
publish is cancelled naming the holder. Entries this publish created are
released if it is refused for another identifier.

- **Release**: a published record that drops an identifier renames its entry to
  `released/<entry id>/<identifier>`. Trashing would not free the value (the
  index covers trashed rows); renaming does, and the entry keeps its revisions.
- **Transfer**: an administrator edits the entry's `subject` with a rationale;
  the source becomes `transfer`.
- **Merge**: publishing a duplicate with `merged_into` and `retired` moves all of
  its entries to the survivor.
- People cannot create or delete entries; AI clients cannot edit them; Mission
  001 entries cannot move.

| Namespace | Normalisation | Example |
| --- | --- | --- |
| `vat` | upper, no spaces/dots | `PT123456789` |
| `lei` | upper, 20 alnum | |
| `duns` | 9 digits | |
| `domain` | lower, no trailing dot, IDN-safe chars | `powerfarm.example` |
| `email_domain` | as domain | |
| `github` | lower | `powerfarm-org` |
| `ext:<issuer>` | trimmed, case kept | `ext:hmrc` |
| `apple_serial`, `apple_ecid` | as Mission 001 | mirrored from assets, read-only |

Status is **derived**, never stored as editable:
`reported` (on the record) → `imported` (created by a blueprint from a declared
source) → `attested` (a person's `identity_verified` attestation naming it) →
`verified` (attestation with a server-verified file). Transfers and merges are
administrator actions with a rationale, journaled on both subjects; AI clients
cannot attest, transfer or merge. Transfer and merge history is the entry's
EmDash revisions and the audit log.

## 5. Security and lifecycle controls

Classification governs visibility everywhere the plugin answers (graph, search,
panels, MCP): `public`/`internal` → Contributor+, `confidential` → Editor+,
`restricted` → Administrator. Bearer-token callers (API tokens, MCP) are capped
at `internal` unless an administrator raises the setting. v1.1 collections have
no classification and keep their v1.1 rules.

Controls are evaluated from evidence, relations, the registry and exceptions —
never from an editable "secure" field. Each is `met`, `waived` (unexpired
published exception), `expired` or `missing`.

| Stage | Enforced at | Controls (per type, see `entities.ts`) |
| --- | --- | --- |
| intake | first publish | classification set; identifiers valid and unclaimed; no inline secrets |
| activation | publish with `lifecycle: active` | owner assigned; identity recorded/verified (clients); classification reviewed; access reviewed (confidential+, instances); security baseline (products, services, instances); maintenance plan; service linked + secret references only (instances); counterparty, dates and signed copy (contracts) |
| operation | shown continuously | review within cadence; contract not past renewal/end; no expired exception |
| retirement | publish with `lifecycle: retired` | retirement approved by an administrator; no active dependants |

A missing control cancels the publish with the list of what is missing. An
entity may sit in `intake` indefinitely with its gaps visible.

Secrets: only `secret_refs` (`{name, store, reference}` where store is
`emdash_setting`, `password_manager`, `vault` or `host_file`). Saves are
rejected if any field looks like a credential (PEM blocks, known token
prefixes, `password=`).

## 6. Blueprints (instantiation workflows) on EmDash content

- Trigger: `registered` (first publish of an entity) or `activated`, decided in
  `beforePublish`/`afterPublish`; a draft save triggers nothing.
- `afterPublish` writes a small run descriptor to KV with compare-and-set (key
  `onboarding:<trigger>:<blueprint>:<subject>[:<rev>]`), so duplicate events
  create nothing. It binds the blueprint's live **revision id**; the steps are
  always read from that EmDash revision, never copied.
- Every step's effect is a work item whose `origin` is `<run>#<step>` — a unique
  field — so a repeated or concurrent attempt finds the existing item instead of
  creating another. Records created by `create_record` carry the same origin.
- Run and step states are **derived** from those work items: `running`,
  `waiting_approval`, `waiting_input`, `succeeded`, `partially_failed`, `failed`,
  `needs_attention`; steps behind a failed dependency stay `blocked`.
- Actions (allowlist): `create_record` (contracts, service instances; with
  references), `create_task`, `request_approval`, `request_link`,
  `wait_for_control` (a control-check item that closes itself), and
  `record_provenance` (a note). No HTTP, code, shell, SQL or email.
- Approvals and attention decisions are edits in the native editor: *Decision*
  and *Status* on the work item. `beforeSave` refuses AI, insufficient roles, the
  initiator when separation is required, missing notes, and reopening.
- A step that cannot complete raises an administrator-only *attention* item
  (`retry`, `done_by_hand`, `give_up`).
- Preview evaluates a blueprint against a subject with no writes at all; the
  editor panel shows it before the first publish.
- The `blueprints` cron task advances open runs; a save of a related work item,
  evidence or the record advances that record's runs at once.

## 7. Migration

Fresh installs: apply `site/seed/seed.json` (now 1.2).

Existing 1.1 installations (`scripts/migrate-1.2.sh`):

1. Backup with `scripts/backup.mjs` (refuses to continue without it).
2. `emdash seed site/seed/migrations/1.2.0.json --no-content --on-conflict update`
   — adds the 9 collections (including `identifiers`), 17 relations and the `evidence.subject` /
   `evidence.identifier` fields and new attestation options. Existing collections
   in that file are only `evidence` (complete field list, so nothing is lost).
3. `emdash seed site/seed/migrations/1.2.0.json --on-conflict skip` — adds the
   example client-onboarding blueprint *as a draft* if absent.
4. Start EmDash; the plugin's status reports `schema: ok` or lists what is missing.
   Entity routes and the runner refuse to work until it is `ok`.

No existing record, key, relation or graph id changes. No unique index is added
to an existing field. Rollback: restore the backup (the new collections are
additive; 1.1 code ignores them).

## 8. Deferred (not in 1.2)

Resource-scoped authority grants and delegation; incidents; subflows and
compensation; email notifications; external service adapters; experiments,
hypotheses, datasets; edge-attribute allocation records; a visual blueprint
editor.
