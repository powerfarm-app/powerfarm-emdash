# Deploying Powerfarm 1.2.2 — self-hosted variant

> Since 1.2.2 the primary deployment is Cloudflare with the lab Macs as workers:
> [DEPLOYMENT-CLOUDFLARE.md](DEPLOYMENT-CLOUDFLARE.md). This page remains the
> reference for LAB 512's own bootstrap (section 0), bridge validation, MCP, and
> the self-hosted variant (`pnpm build:node`, `astro.config.node.mjs`).

One internal EmDash instance in an Ubuntu Server ARM64 VM (UTM) on LAB 512, the
bridge on LAB 512's macOS, SQLite, private network only. The order follows
Mission 001: nothing here runs until LAB 512 has been recovered by hand.

## 0. Bootstrap LAB 512 independently

EmDash cannot vouch for the machine it runs on. Recover LAB 512 first, outside
the platform (procedure `P-HOST-BOOTSTRAP`, [APPLE-OPERATIONS.md](APPLE-OPERATIONS.md)):

1. Try LAB 512's own macOS Recovery: erase, reinstall.
2. If DFU is needed, use a **second trusted Mac on macOS 14 or later** (or
   Apple-authorised service). LAB 001 (Catalina, Intel) cannot be the DFU host.
3. New local admin, FileVault on, latest macOS, no restored data, profiles or apps.
4. Write down what you did and observed (serial number, macOS version, date). It
   is recorded in EmDash in step 5.

## 1. Build the instance (in the VM)

```bash
sudo apt install -y git build-essential
# Node 22.16+ (nodejs.org or nvm), then
corepack enable
unzip powerfarm-emdash-v1.1.zip -d ~/powerfarm-src
~/powerfarm-src/powerfarm/scripts/setup.sh /opt/emdash
```

`setup.sh` clones EmDash at `981c78d` (1.4.0) and stops if it is anything else,
applies `upstream/patches/0001-private-media-files.patch` and
`0002-plugin-create-references.patch`, copies Powerfarm into
`/opt/emdash/powerfarm`, adds it to the pnpm workspace, installs, builds, and runs:
both patches' vitest files, plugin tests, plugin typecheck, bridge tests,
`emdash seed --validate` for the seed and the 1.1→1.2 migration, `astro check`
and the site build. Any failure stops it.

**Upgrading an existing 1.1 installation:** run `setup.sh` into the same
checkout, stop the service, then `scripts/migrate-1.2.sh --backup-dir <off-host
dir>` (backup first, then the additive schema migration, then the draft
onboarding blueprint). See [MIGRATION.md](MIGRATION.md).

## 2. Configure

```bash
cd /opt/emdash/powerfarm/site
cp .env.example .env
openssl rand -base64 32     # → EMDASH_ENCRYPTION_KEY. Store a copy OFF this machine now.
```

| Variable | Value |
| --- | --- |
| `HOST` | VM address on UTM's network reachable from macOS (e.g. 192.168.64.2). Never a public interface. |
| `PORT` | 4321 |
| `EMDASH_SITE_URL` | `http://<HOST>:4321` |
| `POWERFARM_DATA_DIR` | `/var/lib/powerfarm` — database and uploads; backups use the same value. |
| `EMDASH_ENCRYPTION_KEY` | as generated |
| `EMDASH_PRIVATE_MEDIA` | `1` (evidence files require sign-in) |
| `DATABASE_URL` | leave unset (SQLite; ADR-0006) |

Firewall the VM: allow 4321 only from the macOS host's address on the UTM
network (and the admin's workstation if needed). **Do not port-forward or tunnel
the instance, and never expose `/_emdash/api/plugins/powerfarm/mac/bridge/*`.**

## 3. Run it

First run, interactively:

```bash
set -a; . ./.env; set +a
pnpm start
```

Open `http://<HOST>:4321/_emdash/admin`, create the administrator (a passkey is
strongest), apply the Powerfarm seed. Later, review the draft blueprint
`BP-CLIENT-ONBOARDING` (Content → Blueprints) and publish it if you want client
registrations to start onboarding ([ENTITIES.md](ENTITIES.md)). Then install the service:

```bash
sudo useradd --system --home /var/lib/powerfarm --shell /usr/sbin/nologin powerfarm
sudo install -d -o powerfarm -g powerfarm -m 0700 /var/lib/powerfarm
sudo install -m 0600 .env /etc/powerfarm.env
sudo cp ../deploy/powerfarm.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now powerfarm
```

(If the first run used a different data directory, move its contents to
`/var/lib/powerfarm` before enabling the service.)

## 4. Plugin settings (Admin → Plugins → Powerfarm)

| Setting | Value |
| --- | --- |
| Accept bridge requests | on (turn off to revoke the bridge instantly) |
| Bridge ID | `lab-512-bridge` |
| Bridge signing secret | `openssl rand -hex 32`; same value in the bridge's secret file |
| Next bridge secret | empty except during rotation |
| Bridge source addresses | the macOS host's UTM address (e.g. 192.168.64.1) |
| Trusted host asset tag | `LAB-512` (the bridge never operates on it) |
| Require a second person | off while there is one operator; on when there are two |
| Who can approve destructive operations | Administrators |
| Bridge lease | 20 minutes |
| Largest evidence upload | 8 MiB |
| Highest classification API tokens and AI clients may read | Internal |

Settings marked secret are encrypted with `EMDASH_ENCRYPTION_KEY`. No AI tool can
change settings.

## 5. Record the bootstrap

In the admin, on asset LAB-512: enter serial number and `os_policy`. Create a
recovery operation with `P-HOST-BOOTSTRAP`, parameters `{"recordOnly": true}`, data decision
`no_user_data` (or what was true), rationale; publish; then Admin → Recovery →
complete it with your attestation. Continue LAB 512 through verification,
security attestations and trust sign-off like any other asset.

## 6. The bridge (macOS on LAB 512)

```bash
# Apple Configurator from the App Store (installs cfgutil via its menu), Node 22
mkdir -p ~/.powerfarm/logs ~/.powerfarm/profiles && chmod 700 ~/.powerfarm
cp -R /path/to/powerfarm/bridge ~/powerfarm-bridge
cp ~/powerfarm-bridge/config.example.json ~/.powerfarm/bridge.json   # set emdashUrl
printf '%s' '<the bridge signing secret>' > ~/.powerfarm/bridge.secret && chmod 600 ~/.powerfarm/bridge.secret
node ~/powerfarm-bridge/bin/powerfarm-bridge.mjs doctor
```

`doctor` checks macOS, Node, cfgutil and its help for each subcommand used, the
secret, a signed health call to EmDash, and connected devices, then lists every operation as **VALIDATED** or **not enabled**
with the reason. Initially all are *not enabled*.

Validate each operation on a test device you are prepared to erase:

```bash
node ~/powerfarm-bridge/bin/powerfarm-bridge.mjs validate inventory   # runs the real read-only command, checks parsing
node ~/powerfarm-bridge/bin/powerfarm-bridge.mjs validate verify
node ~/powerfarm-bridge/bin/powerfarm-bridge.mjs validate backup      # prints the exact command; you run it and attest
node ~/powerfarm-bridge/bin/powerfarm-bridge.mjs validate restore     # ERASES the test device
```

A macOS major upgrade or a new cfgutil version disables everything again until
re-validated.

Run:

```bash
node ~/powerfarm-bridge/bin/powerfarm-bridge.mjs once     # one job, in a terminal (required for restores)
node ~/powerfarm-bridge/bin/powerfarm-bridge.mjs run      # polling loop
```

`mac/bridge/launchd/org.powerfarm.bridge.plist` runs it unattended for read-only and
backup work; restores fail closed there because they need the typed confirmation.

### Rotating the bridge secret

1. Put a new secret in **Next bridge secret**. Both are now accepted.
2. Replace `~/.powerfarm/bridge.secret` on the Mac; restart the bridge; run `doctor`.
3. Move the new value into **Bridge signing secret**; clear **Next**.

If the secret may have leaked: turn **Accept bridge requests** off first.

## 7. MCP (AI access)

The MCP endpoint is `/_emdash/api/mcp` on the same private instance. During
Mission 001, only connect clients that can reach the private network (for
example a local MCP client on the admin workstation). Do not expose the instance
to reach a cloud AI service; if you decide to later, expose only the MCP and
OAuth paths through a TLS proxy and block everything else — a decision for a
person, recorded as an ADR.

1. Admin → Plugins → Powerfarm → enable MCP tools (needs `plugins:manage`).
2. Create a dedicated EmDash user for the AI with the **Editor** role.
3. Issue a token with the scope **`mcp:tools:powerfarm` only**. Powerfarm's tools
   need nothing else (EmDash checks the user's role for them). Without
   `content:read`, EmDash's own MCP content tools are unavailable to the AI, so
   it cannot read around Powerfarm's classification rules; without
   `content:write` it cannot write through them. Publishing approval-bearing
   collections over MCP is refused in any case.
4. Plugins → Powerfarm → *Highest classification API tokens and AI clients may
   read* stays **internal** unless you decide otherwise.

| Tool (`powerfarm__…`) | Effect |
| --- | --- |
| get_status, graph_search, graph_get_entity, graph_get_neighbours, graph_trace_dependencies, graph_get_history, graph_get_provenance, search_knowledge, get_fleet, get_asset, get_open_recovery_jobs, get_next_physical_action, get_recovery_procedure, get_verification_status, get_evidence, get_projects, get_requirements, get_architecture_decisions, get_software_components, get_tests_and_releases | read-only |
| get_entity, check_registration, get_service_catalogue, get_open_work_items, get_blueprint_runs, preview_blueprint, get_control_catalogue | read-only (1.2); `preview_blueprint` simulates and writes nothing |
| prepare_recovery_operation | creates an **unpublished** operation draft |
| propose_draft | creates an unpublished research / requirement / decision / procedure / test draft |
| propose_entity | creates an unpublished **intake** client / product / service / instance / contract draft, marked prepared by AI; cannot set lifecycle, classification, identifiers, owner or relations |

There are no MCP tools to approve, publish, register, activate, execute, resolve
inspections or work items, attest, sign, transfer or merge identities, sign off
trust, change settings or permissions.

## 8. Smoke test

```bash
cd /opt/emdash/powerfarm/site
POWERFARM_URL=http://<HOST>:4321 POWERFARM_TOKEN=<separate test token: content:read, schema:read, content:write, mcp:tools:powerfarm> pnpm smoke
```

Checks health, private media (401 without a session), unsigned bridge refused,
30 tools registered, 25 collections, the exact fleet with nothing trusted, the
mission's six scoped assets, that AI drafts (an operation and a client) cannot be
published over MCP, that an AI proposal cannot set a lifecycle, the control
catalogue and registration check, and that the scheduled tasks have run. Delete
the drafts it names afterwards, and revoke the test token: it has more scopes
than an AI client should.

## 9. Backups

Before the first destructive operation: [BACKUP-RESTORE.md](BACKUP-RESTORE.md).
