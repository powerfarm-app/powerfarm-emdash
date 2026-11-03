# Architecture — Powerfarm on EmDash 1.3

EmDash is the platform. Powerfarm is a configuration of it (a seed), one native
in-process plugin, two small patches to EmDash core, and a bridge process on the
lab Macs. Since 1.2.2 EmDash runs on Cloudflare; the Macs do the device work. There is no s```
                    ┌────────────── Cloudflare (Access in front of the whole hostname) ──────────────┐
  Browser (admin) ─►│ Worker: EmDash 1.4.0 @ 981c78d + patches 0001 (private media), 0002 (refs)   │
  MCP client ──────►│   ├─ seed: 23 collections, 34 relations, fleet, procedures, M001               │
                    │   ├─ @powerfarm/emdash-plugin (native, trusted, in the Worker)                 │
                    │   │    hooks · routes · MCP tools · cron tasks (Cron Trigger) · admin UI       │
                    │   ├─ @emdash-cms/plugin-audit-log                                              │
                    │   ├─ D1 (content, revisions, users, plugin storage)   R2 (media, evidence)     │
                    └───────────────────────────────▲────────────────────────────────────────────────┘
                                                    │ HTTPS, Access service token + HMAC signature;
                                                    │ the Mac pulls, Cloudflare never calls the lab
                    ┌──────────── lab Mac (LAB 512) ─┴──────────┐
                    │ powerfarm-bridge (Node) ── cfgutil ── USB ──► iPhones
                    │   disk outbox: results wait out outages │
                    │ cf-backup: D1 + R2 copied here daily    │
                    │ Finder / Recovery: performed by a person ───► Macs (manual adapter)
                    └─────────────────────────────────────────┘
```

The self-hosted variant (`astro.config.node.mjs`) replaces the Cloudflare box with
a Linux VM on LAB 512 running Node with SQLite; everything else is the same.
ADR-0010 records the choice.                    └──────────────────────────────────────────┘
```

## What EmDash provides, and how Powerfarm uses it

| EmDash feature | Powerfarm use |
| --- | --- |
| Seed (`site/seed/seed.json`) | Collections, fields, relations and initial content: exact fleet, 13 procedures, M001, ADRs, requirements, tests, release. |
| Drafts, revisions, publish | **Approval is publication** (ADR-0002). A recovery operation is a draft until a person publishes it; `content:beforePublish` refuses the publish if a rule fails. The approved job is bound to the exact live revision id. |
| Relations (`_emdash_content_references`) | Native graph edges, including staged references in drafts (shown as *proposed*). |
| `content:beforeSave/afterSave/beforeDelete/beforeSchedule/beforeUnpublish/afterPublish/afterUnpublish` | Immutability of events and evidence, link validation, AI restrictions, job creation and revocation, graph cache invalidation. |
| Plugin routes with `permission` | Read API and session-only human actions (manual start/complete, resolve inspection, acknowledge audit). |
| Public plugin routes | Bridge endpoints, authenticated by HMAC (EmDash API tokens for plugin routes need the `admin` scope, which the bridge must never hold). |
| MCP tools (`powerfarm__*`) | 30 tools; read-only except three that create drafts. |
| `ctx.cron` | reconcile, outbox, leases, integrity, housekeeping; 1.2: blueprints (every minute), identity (every 15 minutes). |
| Plugin storage with `updateIf` / `compareAndSet` | Job state machine, asset locks, bridge registry, journal, reconciliations (in D1 on Cloudflare). |
| Encrypted settings (`EMDASH_ENCRYPTION_KEY`) | Bridge secret and rotation secret. |
| Media (`ctx.media.upload/readBytes`) | Evidence files, hashed on the server. Private by patch 0001. |
| `search()` (FTS5) | Graph and knowledge search. |
| Admin plugin API | 7 pages, 8 dashboard widgets, 5 content-editor panels, 17 list columns. |
| Roles (10–50) | Graph visibility, drafts (Editor+), unmasked identifiers and destructive approval (Admin). |

## EmDash internals used, and how

The plugin reads EmDash's own tables only through `plugin/src/emdash-port.ts`:
SELECT statements over `ec_<collection>`, `revisions` and
`_emdash_content_references`, with every identifier validated against the
Powerfarm collection list. It never writes to those tables; all writes go through
`ctx.content` (create/update/publish) so EmDash's revisions, hooks, search index
and audit log stay correct. The port exists because EmDash's plugin content API
does not expose draft revisions, staged references or reference edges, which the
graph needs. It is the single place to re-check on an EmDash upgrade.

## Why link fields remain

Operational records (`recovery_operations`, `events`, `evidence`) carry
`asset_tag`, `procedure_code`, `op_code` etc. as indexed string fields, in
addition to native relations where they exist (ADR-0003):

- hooks and cron must find "all evidence for OP-0007" through `ctx.content.list`
  with `fieldFilters`, which works on indexed fields only;
- approval checks run inside `beforePublish`, where the record's draft references
  are not yet live;
- journal entries and bridge reports refer to records by business key, so the
  chain stays verifiable from a backup without EmDash running.

Links are validated on save (the referenced asset, procedure, mission or backup
operation must exist), so they cannot drift silently.

## The Mission 001 control loop

1. A person, or an AI through `prepare_recovery_operation`, drafts an operation.
2. A person publishes it. `beforePublish` runs `approvalViolations` (see
   `plugin/src/recovery.ts`); any violation cancels the publish with its reason.
3. `afterPublish` creates job `<opId>:<liveRevisionId>` (status `approved`) and
   supersedes older approved jobs for the same operation.
4. Bridge adapter (iPhone): the bridge claims it with a signed request, gets a
   lease and the asset lock; reports `started` → `progress` → evidence uploads →
   `succeeded`/`failed`/`interrupted`. Every report carries the lease id and the
   exact operation revision; a mismatch is refused.
   Manual adapter (Mac): a person starts and completes it in Admin → Recovery,
   attaching evidence (file or signed attestation).
5. Results are journaled (hash chain, per stream), projected into `events`
   content by the outbox task, and the asset's status is **derived** from real
   jobs and evidence — never edited by hand, never by AI.
6. An unknown outcome (lease expiry while running, `interrupted` on a
   non-read-only operation) becomes `needs_inspection`: the asset stays locked
   until an administrator resolves it, then an inventory must run before anything
   else. Nothing is retried automatically.

## Safety properties (each has a test)

- Simulations and dry runs never count toward progress or trust (`countsAsReal`).
- Verification is exact and fail-closed: serial and ECID must match; an empty OS
  policy fails; a verification older than the latest restore is ignored.
- Only operations validated on this host, this macOS major and this cfgutil
  version are ever claimed by a real bridge.
- Mac DFU is never automated (ADR-0005). LAB 001 (Catalina) is never a DFU host.
- Destructive operations need a data decision; `backup_verified` must point to a
  real, successful backup of the same asset made after the last restore.
- One active job per asset (asset lock with compare-and-set).
- The journal is append-only and hash-chained; if appending fails, the platform
  enters *audit degraded* and refuses new approvals until an administrator
  acknowledges it.
- AI cannot publish approval-bearing collections, write evidence or events,
  change asset identity, create assets, sign off trust, or call session-only routes.
- Graph reads default to published content; drafts need Editor; hardware
  identifiers are masked except for Administrators who ask to reveal them.
- Bridge requests: HMAC-SHA256 over version, timestamp (±300 s), nonce
  (single-use), route and body hash; artifact metadata headers are inside the
  signed route string; optional source-address allowlist; kill switch.
- Bridge logs are redacted before upload; payloads are size-bounded (64 KiB JSON,
  8 MiB artifacts).

## Graph

See [ONTOLOGY.md](ONTOLOGY.md). The graph service is computed on request from
EmDash content, relations, revisions and plugin storage, with a per-view cache
invalidated by a `graph:version` counter bumped on every content change. Traversal
is bounded (depth ≤ 4, ≤ 300 nodes) and paged with opaque cursors.

## Engineering workflow

Engineering knowledge lives in EmDash collections (`projects`, `requirements`,
`decisions`, `software`, `tests`, `releases`, `research`) and is linked into the
graph. Changes follow the same draft → review → publish path: AI may propose a
draft with `propose_draft`; a person reviews and publishes. Test records carry
`last_result`; the integration and hardware tests are seeded as `not_run` and
must be updated by a person when actually executed. See
[ENGINEERING.md](ENGINEERING.md).

## 1.2: entities, identity, controls, blueprints

Design and rationale: [ONTOLOGY-V1.2.md](ONTOLOGY-V1.2.md); operator guide:
[ENTITIES.md](ENTITIES.md). In EmDash terms:

| Need | EmDash mechanism |
| --- | --- |
| Clients, products, services, instances, contracts | seed collections with drafts and revisions; 17 native relations; native list columns (`admin.listColumns`) for code, lifecycle, classification |
| Registration | the native editor; **publishing is registration**; the editor panel shows duplicates, missing controls and a preview of what publishing starts |
| Identifiers on a record | a JSON field rendered by the plugin field widget `powerfarm:identifiers` (live availability check) |
| Identity registry | the `identifiers` collection: `namespace:value` is a `unique` field, so the database refuses a second holder (also under concurrency); entries are created in `beforePublish`, released by renaming, transferred by an administrator's edit; history is EmDash revisions |
| Activation, suspension, retirement, merge | publishing a lifecycle change (merge: `merged_into` + `retired`); `beforePublish` evaluates the stage's controls and cancels with what is missing |
| Controls | derived from `evidence` attestations naming the subject, native relations, the registry and published `exceptions` (`controls.ts`) |
| Onboarding templates | `blueprints` content; a run reads its steps from the exact EmDash revision that was live when it started |
| Onboarding state | `work_items` content: one item per step, `origin` = `<run>#<step>` (a `unique` field, so steps are idempotent); run state is derived from them. KV holds only the run descriptor, created with compare-and-set |
| Approvals and attention decisions | editing the work item in the native editor (*Decision*, *Status*, note); `beforeSave` enforces role, separation of duties and closed-stays-closed |
| Linked records from automation | `ctx.content.create(…, { references })` — **patch 0002**; the runner verifies the edges exist after each create |
| History | EmDash revisions on every 1.2 collection, the audit-log plugin, the Powerfarm journal for Mission 001 |
| Visibility | classification on every entity, applied in the graph, search, panels, routes and MCP (`access.ts`); token cap setting |

Hooks decide; the `blueprints` cron task (and a save of a related work item,
evidence or record) advances runs. The runner can create drafts, work items and
registry entries and nothing else: it cannot publish an entity, change a
lifecycle, owner, classification, sign, or call anything outside EmDash. There is
no Powerfarm page for 1.2: everything is in Content, the editor panel and the
dashboard widgets.

Known limit: classification is enforced on Powerfarm's surfaces. EmDash's own
content list and REST API show every record to anyone with `content:read`, so AI
tokens get only `mcp:tools:powerfarm`.

## 1.3: Powerfarm Identity and the thin MDM

Overview: [IDENTITY.md](IDENTITY.md); operations: [MDM.md](MDM.md); ADR-0011.

| Need | EmDash mechanism |
| --- | --- |
| Apple's MDM protocol | two public raw plugin routes (`PUT`, raw bytes, declared `Mdm-Signature` header, raw plist responses) |
| Device authentication | detached CMS signature verified with WebCrypto against the Powerfarm device CA certificate (a setting); CA key on the lab Mac |
| Device state, command queue, pushes | plugin storage `mdm_devices`, `mdm_commands`, `mdm_pushes` |
| Approved profiles | `mdm_profiles` content; publishing by an administrator is the approval; unpublishing removes them |
| Findings | `incidents` content (opened by Powerfarm, closed by people with a resolution); journal entries; e-mail via EmDash's email capability |
| Watching | the `vigilance` cron task (every 15 minutes) |
| Device posture for Cloudflare Access | a public route behind an Access Service Auth application (custom posture integration) |
| Push to devices | the bridge on the lab Mac claims pushes and sends them to Apple over HTTP/2 with the MDM push certificate |

## What is deliberately not here

- No shell execution from EmDash, its plugin or an LLM. The only process that
  runs device commands is the bridge on macOS, and it runs a fixed command table.
- No public site during Mission 001 (see [PUBLICATION.md](PUBLICATION.md)).
- No PostgreSQL. On Cloudflare, D1 is the database (SQLite, so FTS5 search works); self-hosted, SQLite with one process (ADR-0006, ADR-0010).
- No compute in the cloud beyond EmDash itself: device work runs on the lab Macs, which pull it.
- No workflow engine, rules language or scripting: blueprints are data in a
  closed action catalogue (ADR-0009 and docs/ENTITIES.md).
