# Implementation report — Powerfarm EmDash Platform 1.1

Date: 2 November 2026. Base: EmDash `981c78d` (1.4.0), unchanged except patch 0001.

## Summary

1.1 corrects and extends 1.0 inside EmDash. EmDash's own mechanisms carry the
work: drafts and publish for approval, revisions for exact binding, relations
and staged references for the graph, hooks for policy, plugin storage with
compare-and-set for jobs and locks, encrypted settings for the bridge secret,
media for evidence, `ctx.cron` for coordination, FTS5 for search, and the admin
plugin API for every screen. There is no side application.

**Verified here:** 69 plugin tests and 22 bridge tests pass (including the 7 and
13 baseline tests, ported to 1.1 APIs with the same intent); the private-media
patch applies cleanly to `981c78d` and its logic was exercised; backup →
restore round trip on real SQLite.

**Not verified:** anything that needs the npm registry, a running EmDash or
hardware (see below). This is not a statement that the platform works end to
end. It is a statement that its rules are implemented and unit-tested.

## Architecture changes

- Graph rebuilt on a read port (`emdash-port.ts`, SELECT-only over `ec_*`,
  `revisions`, `_emdash_content_references`) and a content reader with separate
  published/draft views; typed ontology with 7 domains; storage-backed nodes
  (jobs, leases, bridges, journal, reconciliations); states published / draft /
  proposed / historical; role-based visibility and identifier masking; paging,
  bounded trace, per-view cache invalidated by `graph:version`; history,
  provenance and GraphRAG context.
- Recovery rebuilt around a pure rules module (`recovery.ts`): operations
  registry split by adapter and device class; `approvalViolations` evaluated in
  `content:beforePublish`; derived asset status; acceptance checklist; next
  physical action.
- Durable journal (`journal.ts`): per-stream hash chain with CAS on the head,
  idempotency keys, outbox projection into `events`, chain verification,
  audit-degraded state that blocks approvals.
- Jobs: id bound to the live revision, explicit transition table,
  `needs_inspection`, asset locks, leases, execution mode, evidence list,
  audit-gap flag; manual adapter for Mac work in the admin.
- Bridge protocol: lease and revision on every report; report dedupe; artifact
  upload with server hashing; signed artifact metadata; secret rotation; kill
  switch; optional source-address allowlist; health with per-operation
  validation report.
- Bridge: adapters by device class; host validation file; in-flight state for
  crash recovery; log redaction; never kills a destructive command on stop.
- Deployment: one internal instance, `site-public` removed; single data-path
  module; SQLite; private media patch; systemd unit; backup/restore/smoke scripts.
- Admin: Recovery, Graph, Engineering, Audit pages; 7 widgets; 4 editor panels;
  14 list columns. The 1.0 Mission page and plugin `store.ts` were replaced.

## Defects in 1.0 corrected

| # | Defect | Correction | Test |
| --- | --- | --- | --- |
| 1 | Asset trust/recovery state was an editable field (AI with content:write could mark a device trusted). | Removed; status derived; trust needs an Admin attestation after verification. | recovery, workflow |
| 2 | Simulated or dry-run results could advance an asset. | `countsAsReal` everywhere progress is computed. | recovery |
| 3 | Verification passed with an empty OS policy / missing fields. | Fail-closed exact checks; empty policy fails. | recovery |
| 4 | A stale verification (before the latest restore) counted. | Only verifications after the last restore count. | recovery |
| 5 | Job not bound to the approved revision; edits after publish changed what ran. | Job id `<op>:<revision>`; reports must carry it; unpublish revokes. | workflow, journal-jobs |
| 6 | Interrupted destructive operations could be retried. | `needs_inspection`, lock kept, inventory required next; no retries. | journal-jobs, workflow |
| 7 | Two jobs could run on one device. | Asset lock with compare-and-set. | journal-jobs |
| 8 | Events were mutable and written directly; no audit integrity. | Hash-chained journal; events immutable projections; degraded state. | journal-jobs, backup |
| 9 | Evidence hash taken from the bridge's word. | Server computes SHA-256 from stored media; mismatch rejected. | workflow |
| 10 | Media (evidence) publicly downloadable. | Patch 0001 + `EMDASH_PRIVATE_MEDIA=1`. | patch vitest (logic run), smoke |
| 11 | Artifact metadata headers not covered by the signature. | Bound into the signed route string. | bridge-v11, wire |
| 12 | AI could publish draft procedures/operations through EmDash's core MCP tools. | `HUMAN_PUBLISHED` collections: MCP publish/unpublish cancelled. | workflow |
| 13 | Graph neighbour cache keyed without role leaked filtered views across roles. | Cache per view, filter per request. | graph |
| 14 | Inventory identity check failed on OS policy. | Inventory excludes the OS check. | recovery |
| 15 | Bridge offered every cfgutil operation once cfgutil existed. | Only operations validated for this host, macOS major and cfgutil version. | bridge-v11 |
| 16 | Mac DFU modelled as a bridge operation. | Manual adapter; LAB 001 excluded as DFU host. | recovery, bridge-v11 |
| 17 | Seed carried example identifiers. | No serials/ECIDs/OS policies seeded; exact fleet only. | seed |
| 18 | Destructive operation could proceed with an unrelated or older backup. | `data_decision`; `backup_verified` needs a real backup of the same asset after the last restore. | recovery |
| 19 | Bridge logs could carry personal data. | Redaction of emails, phone numbers, credentials, bearer tokens, EmDash PATs. | bridge-v11 |
| 20 | Two instances, two data paths. | One instance, one paths module used by config, backup and restore. | backup |

## Files

**New:** plugin `access.ts`, `content.ts`, `emdash-port.ts`, `ontology.ts`,
`journal.ts`, `recovery.ts`, `facts.ts`, `runtime.ts`, `services.ts`,
`manual.ts`, `schemas.ts`, `evidence.ts`, `bridge-service.ts`, `reconcile.ts`;
admin `RecoveryPage.tsx`, `OtherPages.tsx`, `panels.tsx`, `columns.tsx`,
`widgets.tsx`, `ui.tsx`; tests `recovery`, `journal-jobs`, `seed`, `graph`,
`workflow`, `wire`, `backup` and helpers (`fake-ctx`, `sqlite-port`, `stubs/emdash`);
bridge `adapters.mjs`, `validation.mjs`, `redact.mjs`, `test/bridge-v11.test.mjs`,
`fixtures/cfgutil-full.mjs`; `site/seed/build_seed.py`, `site/powerfarm.paths.mjs`,
`site/.env.example`; `patches/emdash/0001-private-media-files.patch`;
`scripts/backup.mjs`, `restore.mjs`, `smoke.mjs`; `deploy/powerfarm.service`;
docs `ONTOLOGY`, `PUBLICATION`, `ENGINEERING`, `APPLE-OPERATIONS`, `ACCEPTANCE`,
`BACKUP-RESTORE`, `MIGRATION`, this report.

**Modified:** plugin `model.ts`, `policy.ts`, `jobs.ts`, `graph.ts`, `routes.ts`,
`bridge.ts`, `bridge-auth.ts`, `index.ts`, admin `GraphPage.tsx`, `api.ts`,
`index.tsx`, `package.json`, `test/logic.test.ts` (ported), `test/ts-hooks.mjs`;
bridge `bin/powerfarm-bridge.mjs`, `src/runner.mjs`, `client.mjs`,
`operations.mjs`, `config.example.json`, `package.json`, `test/bridge.test.mjs`
(fixtures given a validated list); `site/astro.config.mjs`, `package.json`,
`seed/seed.json`, `src/pages/index.astro`; `scripts/setup.sh`; `README.md`,
`docs/ARCHITECTURE.md`, `docs/DEPLOYMENT.md`.

**Removed:** `site-public/` (whole instance), `plugin/src/store.ts`,
`plugin/src/admin/MissionPage.tsx`.

## Tests

| Suite | Result | How |
| --- | --- | --- |
| Plugin (69: recovery 17, workflow 13, journal-jobs 10, graph 9, logic 7 baseline, seed 6, backup 5, wire 2) | **pass** | Node 22.23 `--experimental-strip-types`, `node:sqlite` with the real seed schema and FTS5, a fake plugin context, a stub for `emdash` |
| Bridge (22: 13 baseline + 9) | **pass** | `node --test`, cfgutil stubs |
| Patch 0001 | applies to `981c78d` (`git apply --check`); decision logic run directly | its vitest file was **not** run (no vitest) |
| TypeScript | all remaining errors trace to missing `zod`, `react` and `@cloudflare/kumo` type packages | `tsc` with path mapping to EmDash source |

**Not run** (npm registry unreachable from the build workspace): `pnpm install`,
EmDash build, `astro check`, `emdash seed --validate`, the patch's vitest, the
admin UI in a browser, MCP over HTTP (`scripts/smoke.mjs`), the EmDash
scheduler driving `ctx.cron`, media upload through EmDash's storage, real
`beforePublish` cancellation messages in the admin. `scripts/setup.sh` runs all
of these and stops on the first failure.

## Hardware not verified

None of the following has been executed on any device: every cfgutil command
(inventory, verify, backup, restore, install-profile), JSON parsing of real
cfgutil output, the typed confirmation path, DFU revive/restore, macOS Recovery
reinstall, any Mac manual procedure. All bridge operations ship *not enabled*
until `powerfarm-bridge validate` records them on LAB 512. The seed's hardware
test records are `not_run`.

## Risks and open items

1. **Integration with EmDash at runtime is unproven.** The plugin was written
   against EmDash's source and tested against fakes. Most likely failure points:
   hook ordering/return semantics for cancellation, `ctx.content.list`
   `fieldFilters` on the seeded indexed fields, plugin storage index
   declarations, MCP tool result shape, admin component imports from Kumo.
2. **The read port depends on EmDash internals** (`ec_*`, `revisions`,
   `_emdash_content_references`). It is read-only and isolated in one file, but
   an EmDash upgrade can break it.
3. **cfgutil behaviour** (exit codes, JSON shape, where `backup` writes, whether
   `restore` prompts) must be confirmed by validation. The parser drops absent
   fields rather than guessing.
4. **Single operator.** "Second person" approval is off by default; one person
   can approve and execute. Turn it on when a second operator exists.
5. **Journal append is not in the same transaction as the job update.** A crash
   between them sets `auditGap` on the job and the integrity task reports it;
   it cannot silently lose the job state, but the history can have a gap.
6. **Bridge authentication is a shared secret.** Protected by encryption at
   rest, rotation, a kill switch, nonce/timestamp checks and an optional address
   allowlist; still, the VM must stay on a private network.
7. **AI over MCP sees operational data** an Editor can see (identifiers masked).
   Connecting a cloud AI client means that data leaves the network.
8. Planned ontology types have no records yet.

## Mapping to the mandate

| Area | Where |
| --- | --- |
| Native admin (panels, columns, widgets, cron, media, revisions, staged refs, encrypted settings) | `plugin/src/index.ts`, `admin/*`, `reconcile.ts`, `evidence.ts`, `content.ts` |
| Graph sources, ontology, states, access, paging, views, search, GraphRAG | `graph.ts`, `ontology.ts`, `access.ts`, `admin/GraphPage.tsx`, ONTOLOGY.md |
| Exact inventory, independent LAB 512 bootstrap, DFU host rule | `site/seed/build_seed.py`, `recovery.ts`, APPLE-OPERATIONS.md, DEPLOYMENT.md §0 |
| Adapters by device class, validated operations only, diagnostics | `bridge/src/adapters.mjs`, `validation.mjs`, `bin doctor/validate` |
| Secret rotation, bounded payloads, redaction, leases, revision binding | `bridge-auth.ts`, `bridge.ts`, `bridge-service.ts`, `redact.mjs` |
| Reconciliation, needs_inspection, no retries, simulation never counts | `reconcile.ts`, `jobs.ts`, `recovery.ts` |
| Fail-closed verification, stale attestations rejected, derived status | `recovery.ts` |
| Per-operation backup decisions | `recovery.ts` (`data_decision`, `backup_op_code`) |
| Journal, outbox, hash chain, audit-degraded | `journal.ts` |
| Explicit physical actions | `nextAction`, APPLE-OPERATIONS.md |
| Single instance, data paths, SQLite, backup with tested restore | `powerfarm.paths.mjs`, `astro.config.mjs`, `scripts/backup.mjs`, `restore.mjs`, BACKUP-RESTORE.md |
| MCP tools | `routes.ts` `mcpTools()`, DEPLOYMENT.md §7 |
| Engineering workflow, future domains | ENGINEERING.md, PUBLICATION.md |
| Tests for every correction | table above |
