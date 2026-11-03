# Backup and restore

> On Cloudflare, `scripts/cf-backup.mjs` writes the same backup format from a D1
> dump and a copy of the R2 bucket, to a Mac outside Cloudflare, and `restore.mjs`
> checks it the same way. See DEPLOYMENT-CLOUDFLARE.md, section 7.

A backup is not good until it has been restored somewhere else and checked.

## What a backup contains

`scripts/backup.mjs` writes one directory:

| Path | Content |
| --- | --- |
| `database/emdash.db` | Consistent SQLite snapshot (`VACUUM INTO`, safe while running): content, revisions, relations, plugin storage (jobs, journal, bridges, reconciliations), encrypted settings. |
| `uploads/` | Media, including evidence files. |
| `source/` | site, plugin, bridge, docs, patches, scripts, README (no node_modules, no data, no .env). |
| `config/env.redacted` | The `.env` with every KEY/SECRET/TOKEN/PASSWORD/DATABASE_URL value replaced by `<redacted>`. |
| `manifest.json` | SHA-256 of every file, row counts, plugin version, EmDash revision. |

**Not included, on purpose:** `EMDASH_ENCRYPTION_KEY`. Keep it in a password
manager or offline. Without it a restored database cannot decrypt the bridge
secret (you would set a new one, which is also fine).

Also back up, separately: `~/.powerfarm/` on the Mac (bridge config, secret,
validated-operations.json, logs).

## Take a backup

On the VM, to storage that is **not** LAB 512:

```bash
cd ~/powerfarm-emdash/powerfarm
node scripts/backup.mjs --out /mnt/offsite/powerfarm --emdash ~/powerfarm-emdash --env site/.env
```

Requires Node 22.16+ (`node:sqlite`). PostgreSQL is refused (use `pg_dump`);
Mission 001 uses SQLite.

When: before the first destructive operation, after each asset becomes trusted,
and before any upgrade.

## Prove it: restore elsewhere

```bash
node scripts/restore.mjs --from /mnt/offsite/powerfarm/powerfarm-backup-<stamp> --to /tmp/pf-restore-test/data
```

It refuses (and changes nothing in the source) unless, in order:

1. every file's SHA-256 matches the manifest,
2. SQLite `integrity_check` is `ok`,
3. row counts match the manifest,
4. every journal stream's hash chain verifies (a rewritten journal entry is
   detected even if someone recomputed the manifest digests).

It only restores into an empty directory. Then start EmDash against it:

```bash
POWERFARM_DATA_DIR=/tmp/pf-restore-test/data EMDASH_ENCRYPTION_KEY=<original> HOST=127.0.0.1 pnpm --dir site start
```

Sign in, open Audit and health (journal intact), open Plugins → Powerfarm
settings (bridge secret readable), open an evidence item (file downloads while
signed in). Record the test as evidence on the mission.

## Restoring for real

Restoring the live instance is a destructive, human-only decision; no AI tool can
trigger it. Stop the service, move the current data directory aside (never
delete it), restore into an empty directory at `POWERFARM_DATA_DIR`, start,
check as above. Jobs that were running at backup time come back as running with
expired leases; the leases task turns them into `needs_inspection`, so the
devices are inspected rather than retried.

## Tested

`plugin/test/backup.test.ts` (5 tests) runs backup → restore against a real
SQLite file with journal entries produced by the plugin's own code, a tampered
upload, and a rewritten journal entry. It has not been run against a database
created by a running EmDash instance.
