#!/usr/bin/env bash
# Migrate a Powerfarm 1.1 installation to the 1.2 content model (additive).
#
#   scripts/migrate-1.2.sh --backup-dir /mnt/offsite/powerfarm [--env site/.env]
#
# Run from TARGET/powerfarm after scripts/setup.sh has built 1.2.1 (with
# upstream/patches/0002 applied). Stop the EmDash service first.
#
# 1. Takes a backup (scripts/backup.mjs). Refuses to continue without one.
# 2. Applies site/seed/migrations/1.2.0.json schema-only with --on-conflict update:
#    adds clients, products, services, service_instances, contracts, blueprints,
#    work_items, exceptions, identifiers (the identity registry), 17 relations, and evidence.subject / evidence.identifier
#    with the new attestation options. No 1.1 record, key, relation or id changes.
# 3. Applies the same file with --on-conflict skip: adds the client-onboarding
#    blueprint as a DRAFT only if it is missing. Nothing is activated.
# Afterwards start EmDash and check Audit and health / the dashboard widget:
# the plugin reports "schema ok" or lists what is missing.
# Rollback: stop EmDash, restore the backup into an empty directory (scripts/restore.mjs).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR=""
ENV_FILE="$HERE/site/.env"
while [[ $# -gt 0 ]]; do
	case "$1" in
		--backup-dir) BACKUP_DIR="$2"; shift 2 ;;
		--env) ENV_FILE="$2"; shift 2 ;;
		*) echo "Unknown argument $1" >&2; exit 2 ;;
	esac
done
[[ -n "$BACKUP_DIR" ]] || { echo "Give --backup-dir (outside LAB 512). A migration without a backup is refused." >&2; exit 2; }
[[ -f "$ENV_FILE" ]] && { set -a; . "$ENV_FILE"; set +a; }
DATA_DIR="$(cd "$HERE/site" && node -e 'import("./powerfarm.paths.mjs").then(m=>console.log(m.powerfarmPaths().dataDir))')"
DB="$DATA_DIR/emdash.db"
[[ -f "$DB" ]] || { echo "No database at $DB" >&2; exit 1; }
if [[ -n "${DATABASE_URL:-}" ]]; then echo "PostgreSQL installations: back up with pg_dump and apply the seed with --database pointing at it yourself." >&2; exit 1; fi

echo "1/3 Backup"
node "$HERE/scripts/backup.mjs" --out "$BACKUP_DIR" --env "$ENV_FILE"

cd "$HERE/site"
echo "2/3 Schema (collections, fields, relations)"
pnpm exec emdash seed seed/migrations/1.2.0.json --database "$DB" --uploads-dir "$DATA_DIR/uploads" --no-content --on-conflict update
echo "3/3 Draft onboarding blueprint (only if missing)"
pnpm exec emdash seed seed/migrations/1.2.0.json --database "$DB" --uploads-dir "$DATA_DIR/uploads" --on-conflict skip

cat <<MSG

Migrated. Start EmDash, then:
  - Dashboard → "Entities and onboarding" must not report a missing content model.
  - Content → Blueprints → BP-CLIENT-ONBOARDING is a draft: review it, and publish it
    (administrator) only if you want client registrations to start onboarding.
  - Prove the restore of the backup just taken (scripts/restore.mjs) on another machine.
MSG
