# Engineering workflow

Engineering knowledge is EmDash content, so it is versioned, reviewed and in the
graph like everything else.

| Collection | Key | Seeded |
| --- | --- | --- |
| projects | code | PF-PLATFORM (Powerfarm EmDash Platform) |
| requirements | code | REQ-001 … REQ-009 (approval boundary, simulations never count, fail-closed verification, durable journal, media-backed evidence, graph access control, one job per device, identifiers unique across types, no automatic activation) |
| decisions | code | ADR-0001 … ADR-0009 |
| software | (none) | EmDash CMS, Powerfarm EmDash plugin, Apple Hardware Bridge, Apple Configurator (cfgutil) |
| tests | code | TEST-PLUGIN, TEST-BRIDGE, TEST-INTEGRATION, TEST-HW-IOS, TEST-HW-MAC — all seeded **not_run**. Set them from your own runs; a result in the build workspace is not a result on your installation. |
| releases | code | 1.1.0, 1.2.0 |

## Change flow

1. Propose: a person drafts in the admin, or an AI calls `propose_draft`
   (research, requirement, decision, procedure, test). AI drafts are marked
   `prepared_by_ai` and are never published by the AI.
2. Review in the admin (Engineering page shows open drafts and their links).
3. Publish. Relations become live edges in the graph.
4. Code changes: edit in this repository, run `pnpm test` in `plugin/` and
   `mac/bridge/`, run `scripts/setup.sh` on a clean checkout, run `scripts/smoke.mjs`
   against the running instance, then update the `tests` records' `last_result`
   and `result_summary` by hand and publish a `releases` record linking them.

## Upgrading EmDash

EmDash is pinned to `981c78d` (1.4.0). Do not upgrade during Mission 001. When
upgrading later:

1. Check `upstream/patches/0001` and `0002` still apply (or are no longer
   needed: 0002 if EmDash's plugin `content.create` accepts references itself).
2. Re-read the tables used by `plugin/src/emdash-port.ts` (`ec_*`, `revisions`,
   `_emdash_content_references`) and the plugin API surface used by the hooks.
3. Take and restore-test a backup first.
4. Update `EMDASH_REVISION` in `plugin/src/services.ts`, `EMDASH_COMMIT` in
   `scripts/setup.sh`, `expectedEmdashRevision` in `scripts/backup.mjs`.
