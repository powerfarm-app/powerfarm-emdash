# Powerfarm on EmDash

Powerfarm is a family business's institutional platform, built **on**
[EmDash](https://github.com/emdash-cms/emdash). EmDash is the platform, and this
repository holds only Powerfarm's own code: the plugin, the site that runs it on
Cloudflare, and the code for the lab Mac minis (later, the iPhone Identity App).

| Part | What it is |
| --- | --- |
| `plugin/` | `@powerfarm/emdash-plugin`, a native EmDash plugin: Powerfarm Identity (principals, grants and `authorize()`, suspension, record seals, the OIDC provider for Cloudflare Access, Access logs, the release gate), the thin MDM, Powerfarm Graph, entities and the identity registry, onboarding blueprints, the Mission 001 recovery workflow, the journal, bridge endpoints, MCP tools, admin pages, scheduled tasks. |
| `site/` | The EmDash site that loads the plugin on Cloudflare (Workers, D1, R2): Astro config, `wrangler.jsonc`, the Worker entry, the `/oidc/continue` page, and the seed and migrations of the content model. `astro.config.node.mjs` is the self-hosted Node/SQLite variant. |
| `mac/bridge/` | The Apple Hardware Bridge on the lab Mac minis. It pulls approved jobs from Powerfarm through Cloudflare Access, runs a fixed `cfgutil` command table, holds the MDM device CA, and relays MDM pushes. |
| `ios/` | *Later:* the iPhone Identity App (see the Identity App spec). |
| `upstream/` | The EmDash pin (`emdash.json`) and Powerfarm's two patches to EmDash. EmDash itself is never copied here ([docs/UPSTREAM.md](docs/UPSTREAM.md)). |
| `scripts/` | `setup.sh` (EmDash at the pin, patches, build, every check: used by people and CI), `check-lockfile.mjs`, `edge-check.mjs`, `smoke.mjs`, `cf-backup.mjs`, `backup.mjs`, `restore.mjs`, `release.mjs`. |
| `docs/` | Runbooks, architecture, the implementation reports. |
| `.github/` | CI, the weekly EmDash upstream check, Dependabot for Actions ([docs/CICD.md](docs/CICD.md)). |

```bash
git clone https://github.com/powerfarm-app/powerfarm-emdash && cd powerfarm-emdash
bash scripts/test.sh         # every check CI runs, with a PASS/FAIL summary (--quick: seconds)
```

Requires Node.js 22.16+ and git; pnpm comes through corepack at the version EmDash pins.

## Start here

1. [DEPLOYMENT-CLOUDFLARE.md](docs/DEPLOYMENT-CLOUDFLARE.md) — Cloudflare (Access, Worker, D1, R2), the lab Macs as workers, backups to the Mac, what happens when the lab is down, the first live test.
   [DEPLOYMENT.md](docs/DEPLOYMENT.md) — bootstrap LAB 512, the self-hosted variant, bridge validation, MCP.
2. [APPLE-OPERATIONS.md](docs/APPLE-OPERATIONS.md) — compatibility matrix, DFU host rules, physical actions.
3. [ACCEPTANCE.md](docs/ACCEPTANCE.md) — what "trusted" means, per asset and for the mission.
4. [BACKUP-RESTORE.md](docs/BACKUP-RESTORE.md) — before any destructive operation.
5. [IDENTITY.md](docs/IDENTITY.md) and [MDM.md](docs/MDM.md) — Powerfarm Identity: bootstrap, grants and enforcement, Powerfarm as Cloudflare Access's identity provider, suspension, the release gate, seals; the thin MDM and device posture.
6. [ENTITIES.md](docs/ENTITIES.md) — registering clients, products, services, instances and contracts; identifiers; controls; blueprints.

Reference: [ARCHITECTURE.md](docs/ARCHITECTURE.md),
[ONTOLOGY.md](docs/ONTOLOGY.md), [ONTOLOGY-V1.2.md](docs/ONTOLOGY-V1.2.md), [ENGINEERING.md](docs/ENGINEERING.md),
[PUBLICATION.md](docs/PUBLICATION.md) (public site and future domains),
[MIGRATION.md](docs/MIGRATION.md) (1.1 → 1.2, 1.0 → 1.1), [UPSTREAM.md](docs/UPSTREAM.md), [CICD.md](docs/CICD.md),
[IMPLEMENTATION-REPORT-1.4.md](docs/IMPLEMENTATION-REPORT-1.4.md), [IMPLEMENTATION-REPORT-1.3.md](docs/IMPLEMENTATION-REPORT-1.3.md), [IMPLEMENTATION-REPORT-1.2.md](docs/IMPLEMENTATION-REPORT-1.2.md),
[IMPLEMENTATION-REPORT.md](docs/IMPLEMENTATION-REPORT.md) (1.1).

## Rules the code enforces

- Approval is publication by a person. AI drafts; it cannot approve, publish
  approval-bearing content, write evidence, sign off trust or change settings.
- Asset status is derived from real jobs and server-verified evidence.
  Simulations and dry runs never count.
- Verification is exact and fail-closed. Unknown outcomes become
  `needs_inspection`. Operations never retry automatically; only the delivery of
  a result already obtained does (the bridge's outbox).
- One active job per device; jobs bind the exact approved revision; bridge
  reports carry lease and revision.
- Hash-chained journal; on failure the platform is *audit degraded* and stops
  approving.
- Bridge operations run only after validation on this host and tool version.
  Mac DFU is manual. LAB 001 is never a DFU host.
- Registering an entity is a person's publish; activating, suspending and
  retiring are publishes checked against evidence-backed controls. Nothing
  activates, grants authority, signs or provisions automatically.
- An identifier identifies one record across all types, also under concurrent
  publishes. Transfers and merges are administrator actions with a rationale; a
  merge waits until nothing else links to the duplicate.
- An active record cannot lose a control through an ordinary edit; registered
  records leave by retirement, never by unpublishing and deleting.
- Blueprints are data in a closed action catalogue, bound to the published
  revision, idempotent on resume, and visible when they fail.
- Classification limits what each role, API token and AI client sees on
  Powerfarm surfaces (graph, search, panels, routes, MCP tools).
- Authority is explicit: published, expiring grants checked by one `authorize()`
  on every governed path (advisory until a capability is enforced, then
  default-deny). No self-grants after the recorded bootstrap; agents act only
  under a delegating person; suspension revokes at once.
- Only an active person gets an OIDC token; its subject is a permanent id, never
  an e-mail. Only the approved artifact is deployed, once.

## Status

1.4.0. In this workspace the tests pass (plugin 156, Mac bridge 33), and the seed and all three migrations pass EmDash's own seed validator.
- **Real cryptography in the tests:** the OIDC provider, the Access assertion check, the Access logs task and the release routes are tested through their route handlers, with real RS256 and HMAC.
- **Not run anywhere yet:** EmDash's dispatcher and build, Cloudflare, Access, a browser, a real Apple device and Apple's push service.
- **`setup.sh` checked up to the install:** it fetched the pin and both patches applied cleanly. The install, build and checks run first on GitHub's CI, because this workspace cannot reach the npm registry.

First live checks:
- [DEPLOYMENT-CLOUDFLARE.md](docs/DEPLOYMENT-CLOUDFLARE.md) §9;
- [IDENTITY.md](docs/IDENTITY.md), last section;
- [MDM.md](docs/MDM.md) §9.

Outside the EmDash workspace, the route tests need zod 4: set `POWERFARM_ZOD` to a zod 4 entry file, as CI does.
