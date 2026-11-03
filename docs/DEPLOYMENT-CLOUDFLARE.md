# Deploying Powerfarm 1.4 on Cloudflare, with the lab Macs as workers

This is the primary deployment from 1.2.2. The self-hosted VM variant is still in
[DEPLOYMENT.md](DEPLOYMENT.md) (`pnpm build:node`) for local work and as a fallback.

## 0. What runs where

| Cloudflare (always on) | Lab Macs (when they are up) |
| --- | --- |
| The EmDash Worker: admin, API, MCP, the Powerfarm plugin and its hooks | The bridge: pulls approved jobs, runs `cfgutil`, uploads evidence, reports |
| D1: all content, revisions, users, plugin storage (jobs, journal, leases) | Device backups made by `cfgutil` (large files never go to Cloudflare) |
| R2: media and evidence files (private bucket) | The offsite copy of D1 and R2 (`cf-backup.mjs`, daily) |
| Cron Trigger every minute: EmDash maintenance, Powerfarm reconciliation, onboarding runs, identity task | — |
| Cloudflare Access in front of the whole hostname | — |

Cloudflare holds the **state and the decisions**; the Macs hold the **compute and
the devices**. The Macs are never contacted by Cloudflare: they ask for work and
report back, so nothing in the lab is exposed and the lab may go offline at any
time. Section 8 says what happens when it does.

Why the plugin needs no change for this: EmDash 1.4 ships the Cloudflare adapter
(`@emdash-cms/cloudflare`: D1, R2, Access, scheduled handler). Trusted plugins run
inside the host Worker and plugin cron tasks run from its `scheduled()` handler.
Two things in Powerfarm were Node-only assumptions and are fixed in 1.2.2: the read
port now opens per request (on Workers the database handle is the request's D1
session), and long `IN (…)` lists are split to stay under D1's 100 bound parameters.

## 1. Before you start

- A domain on Cloudflare in the same account (the hostname below is
  `powerfarm.example.com`; replace it everywhere).
- Cloudflare Zero Trust enabled on the account (the free plan covers a small team).
- A Workers paid plan is recommended: longer CPU time for the cron, 30 days of D1
  Time Travel instead of 7. Check current pricing; nothing here needs more.
- On your workstation: Node 22.16+, git, a clone of this repository, and
  `bash scripts/setup.sh` run once. It fetches EmDash at the pin into
  `.upstream/emdash`, applies patches 0001 and 0002, builds, runs the tests and
  builds the Worker. CI runs the same script on every PR.

## 2. Cloudflare Access first (before the first deploy)

Create Access before the Worker exists on the hostname, so it is never reachable
without it. In Zero Trust → Access controls (older dashboards: Access):

1. **Service tokens** (Service credentials → Service tokens → Create):
   - `powerfarm-bridge-lab512` — for the bridge on LAB 512.
   - `powerfarm-smoke` — for `smoke.mjs` and `edge-check.mjs`; revoke it when not testing.
   Copy each Client ID and Client Secret when shown (the secret is shown once).
   Store the secrets in your password manager, never in the repository.
2. **Application "Powerfarm"**, self-hosted, domain `powerfarm.example.com`, no path
   (the whole host). Policies:
   - *People*: action Allow, include the e-mail addresses of the people who use
     Powerfarm (or your IdP group). One-time PIN is enough to start.
   - *Smoke test*: action Service Auth, include service token `powerfarm-smoke`.
3. **Application "Powerfarm bridge"**, self-hosted, domain `powerfarm.example.com`,
   path `_emdash/api/plugins/powerfarm/bridge`. Policy: action Service Auth, include
   service token `powerfarm-bridge-lab512`. If the lab has a fixed public address,
   add a *Require* rule for it as well. People do not need this path.
4. With Powerfarm MDM ([MDM.md](MDM.md) §3): an application on path
   `_emdash/api/plugins/powerfarm/mdm` with a **Bypass** policy (devices sign their
   messages instead), and one on `_emdash/api/plugins/powerfarm/posture` with
   Service Auth for the `powerfarm-posture` token.
5. Optional, later: **MCP** for an AI client. Its own application on path
   `_emdash/api/mcp` with a separate service token; the AI client also needs an
   EmDash API token with only `mcp:tools:powerfarm` (DEPLOYMENT.md, MCP section).

Access is a perimeter, not the identity: people still sign in to EmDash with their
passkey, and EmDash's roles decide what they can do. (EmDash can also use Access as
its identity provider, `access()` in `astro.config.mjs`, which disables passkeys.
That is not used here, so Access and EmDash stay two independent locks.)

`scripts/edge-check.mjs` (section 4) proves all of this from outside.

## 3. Configure and deploy

1. In this repository, edit `site/wrangler.jsonc`: set your hostname in `routes`
   and in `vars.EMDASH_SITE_URL`. Keep `workers_dev: false` and
   `preview_urls: false`: both addresses would reach the Worker without Access.
   Keep the D1 and R2 names unless they clash. Commit it. Hostnames are not
   secrets. Then run `bash scripts/setup.sh --skip-checks` again, and run the next
   steps in `.upstream/emdash/powerfarm/site/`.
2. `pnpm wrangler login`
3. The encryption key for EmDash's secret settings, which include the bridge
   secret:
   - `pnpm emdash secrets generate` (EmDash's own key format);
   - store it in your password manager;
   - `pnpm wrangler secret put EMDASH_ENCRYPTION_KEY`.

   Losing the key makes encrypted settings unreadable. It is deliberately not in
   any backup, and never in GitHub.
4. `pnpm cf:deploy` builds and deploys. The first deploy creates the D1 database
   and the R2 bucket. In the R2 dashboard, check the bucket has **no public
   access** (no r2.dev URL, no custom domain).
5. **Migrate the database before first use.** The Worker never migrates itself
   (`migrations.runtime: "check"`), so until this step it answers 503. Use an API
   token with D1 Edit for this account:
   ```bash
   export CLOUDFLARE_API_TOKEN=...   # D1 Edit only
   pnpm emdash migrate --status --account-id <account id> --d1 powerfarm
   pnpm emdash migrate --account-id <account id> --d1 powerfarm   # check the target, then confirm
   pnpm emdash migrate --check --account-id <account id> --d1 powerfarm
   ```
   Record the target fingerprint `--status` prints. The deploy pipeline (phase 2)
   uses it to refuse migrating any other database.
6. Do **not** enable D1 read replication: Powerfarm's registry and onboarding read
   what they have just written.

## 4. Prove the perimeter

```bash
node scripts/edge-check.mjs --url https://powerfarm.example.com \
  --workers-dev https://powerfarm.<your-account>.workers.dev \
  --access-id <powerfarm-bridge-lab512 client id> --access-secret-file ~/.powerfarm/access.secret
```

Every request without credentials must be *stopped by Access*; a forged Access
header must not help; with the bridge token, `mac/bridge/claim` must reach EmDash and be
refused there for its missing signature. Any FAIL means stop and fix Access before
going on. Run it again after every Access change.

## 5. First sign-in and setup

1. Open `https://powerfarm.example.com/_emdash/admin`, pass Access, and run EmDash's
   setup. **Choose to include the seed's content**: that loads the Mission 001 fleet
   (nothing trusted), procedures, decisions, requirements and the draft onboarding
   blueprint. Register the administrator's passkey on this hostname (passkeys are
   bound to `EMDASH_SITE_URL`).
2. Plugins → Powerfarm → settings:
   - *Bridge ID*: `lab-512-bridge`.
   - *Bridge signing secret*: `openssl rand -hex 32` (store a copy for the Mac).
   - *Bridge lease (minutes)*: 30 (section 8 explains the choice).
   - *Bridge source addresses*: the lab's public address if it is fixed; otherwise empty.
   - *Require a second person to approve*: on, if two people are available.
3. Settings → API tokens: for the smoke test, an Editor's token with `content:read`,
   `schema:read`, `content:write`, `mcp:tools:powerfarm`.
4. Smoke test:
   ```bash
   POWERFARM_URL=https://powerfarm.example.com POWERFARM_TOKEN=ec_pat_... \
   POWERFARM_ACCESS_CLIENT_ID=<powerfarm-smoke id> POWERFARM_ACCESS_CLIENT_SECRET=<secret> \
   pnpm --dir powerfarm/site smoke
   ```
5. `pnpm wrangler tail` for a few minutes: the cron line appears every minute, and
   Powerfarm's tasks log no errors.
6. Powerfarm Identity (1.4), in this order — [IDENTITY.md](IDENTITY.md):
   - bootstrap your person and the first `authority.grant` (§2);
   - only then, if you want Access to sign people in through Powerfarm: rotate in
     the OIDC key, register the Access client, add the Bypass application for the
     exact paths in §5.3, keep a break-glass login on Access, and run
     `node scripts/edge-check.mjs --url https://powerfarm.example.com --oidc`.
   Until then Access keeps using the login method you set up in section 2.

## 6. The bridge on a lab Mac

On LAB 512 (macOS, Apple Configurator installed, Node 22+):

1. Copy `powerfarm/mac/bridge/` to `~/powerfarm/bridge`.
2. `~/.powerfarm/bridge.json` from `config.example.json`: `emdashUrl` is
   `https://powerfarm.example.com`, `accessClientId` the bridge token's Client ID.
3. Secrets, each in its own file with mode 600:
   `~/.powerfarm/bridge.secret` (the signing secret from 5.2) and
   `~/.powerfarm/access.secret` (the bridge token's Client Secret).
4. `node ~/powerfarm/mac/bridge/bin/powerfarm-bridge.mjs doctor`: every line ok, including
   "EmDash reachable, signature accepted" and "results waiting for EmDash: none".
5. Start in simulation: `powerfarm-bridge run --simulate`, approve an inventory in
   EmDash, watch it complete without touching a device.
6. Validate operations on this host (`powerfarm-bridge validate inventory`, …) as in
   [DEPLOYMENT.md](DEPLOYMENT.md), then install `mac/bridge/launchd/org.powerfarm.bridge.plist`.
   Restores still run with `powerfarm-bridge once` in a terminal (local confirmation).

A second Mac is a second bridge with its own ID, secret and Access token: today
Powerfarm accepts one bridge ID at a time, so add the second Mac only after the
first one is proven.

## 7. Backups, to the Mac

Cloudflare keeps D1 Time Travel (7 or 30 days, by plan). Powerfarm also keeps a
copy **outside Cloudflare**, on a Mac, in the same format as the VM backups, so
`restore.mjs` checks it:

```bash
# once: npx wrangler login (as the Mac user); an R2 API token with READ-ONLY access to the bucket
R2_ACCOUNT_ID=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
node powerfarm/scripts/cf-backup.mjs --out /Volumes/Offsite/powerfarm
node powerfarm/scripts/restore.mjs --from /Volumes/Offsite/powerfarm/powerfarm-backup-<stamp> --to /tmp/pf-restore-check
```

The backup contains EmDash's documented D1 dump (search tables excluded, rebuilt
on first search), the Time Travel bookmark taken first, a local SQLite rebuilt
from the dump (integrity, row counts and the Powerfarm journal chains are verified
on it), and the R2 bucket. `mac/bridge/launchd/org.powerfarm.cf-backup.plist` runs it
daily. Prove a restore monthly.

To recover Cloudflare itself: within the Time Travel window, `wrangler d1
time-travel restore powerfarm --bookmark <bookmark>`; beyond it, import the dump
into a **new** D1 database (EmDash's backup guide, "Create an offsite D1 dump") and
point the Worker's binding at it. If the backup reports statements too long for
D1, Time Travel is the D1 route and the dump restores into SQLite (the VM variant).
R2 is restored with `aws s3 sync` into a new bucket. The encryption key comes from
your password manager.

## 8. When the lab is down

| What happens | Effect |
| --- | --- |
| The lab loses its connection while idle | Nothing. People keep using Powerfarm; approved jobs wait. |
| It drops while a job runs | The command keeps running. Heartbeats fail; the bridge keeps the evidence and the result on disk (`~/.powerfarm/logs/outbox/`) and delivers them, in order, when the line is back. It takes no new job until they are delivered. |
| The outage outlasts the lease (30 min) | Powerfarm's reconciliation marks the job *stalled* (not started), *failed* (read-only) or *needs inspection* (destructive). A person looks at the device. Late results that EmDash then refuses are kept in `outbox/rejected/`, and `doctor` reports them. |
| It drops just before a destructive step | The bridge re-checks the approval immediately before erasing; without an answer it does not start. |
| The Mac restarts mid-job | If the result was queued, it is delivered; otherwise the job is reported *interrupted*. |
| Cloudflare is unreachable from the lab, the lab is fine | Same as a lab outage, from the bridge's side. |

So the Mac's availability limits how fast jobs finish, never what the system
records: Cloudflare stays the single place where the state lives.

## 9. Not verified yet (do these in the first live test)

None of this has run on Cloudflare yet. In order:

1. `setup.sh` on a workstation with npm access (install, build, both patches'
   vitests, `astro check`, the Worker build, `emdash doctor`'s scheduler check).
2. Deploy; `edge-check.mjs` all PASS.
3. Setup with the seed's content; the smoke test all PASS.
4. `wrangler tail`: cron every minute; the Powerfarm tasks run without errors.
5. Register one client end to end (publish, onboarding work items, an approval in
   the editor, activation).
6. Bridge `doctor`, a simulated inventory, then a real inventory of one iPhone.
7. Unplug the Mac's network during a simulated job, plug it back: the result
   arrives, no duplicate, no false "interrupted".
8. `cf-backup.mjs` then `restore.mjs` on another folder: all checks pass.
9. Powerfarm Identity's live checks: [IDENTITY.md](IDENTITY.md), last section.

## 10. Limits to know

- D1: 10 GB per database and 100 bound parameters per statement (handled). Evidence
  uploads are capped at 8 MiB by Powerfarm; device backups stay on the Mac.
- Workers CPU time per cron run: the Powerfarm tasks are bounded per run; on the
  free plan a large backlog may need several runs.
- EmDash's own Content screens and REST API do not apply Powerfarm's
  classification (see IMPLEMENTATION-REPORT-1.2.md). Access keeps everyone outside
  the team out; inside the team, treat *restricted* as not yet enforced.
