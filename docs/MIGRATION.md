# Migrations

## 1.2.1 → 1.2.2

No content model change: same collections, fields and relations. The seed gains
ADR-0010 and the 1.2.2 release entry (fresh installs; add them by hand elsewhere
if you want them in Engineering). Plugin and bridge code only. Update the bridge
on the Mac together with the plugin; its outbox folder is created on first start.

Moving to Cloudflare is a new installation, not a migration: deploy fresh
(DEPLOYMENT-CLOUDFLARE.md), run setup with the seed's content. Moving existing
VM data into D1 is not scripted yet: if there is data worth keeping, export it
from SQLite, import it into a new D1 database with `wrangler d1 execute --file`,
and rehearse that on a copy first.

## 1.1 → 1.2 (additive)

```bash
# on the VM, after scripts/setup.sh has built 1.2 into the same checkout
sudo systemctl stop powerfarm
cd /opt/emdash/powerfarm
scripts/migrate-1.2.sh --backup-dir /mnt/offsite/powerfarm
sudo systemctl start powerfarm
```

What it does, in order, stopping at the first failure:

1. `scripts/backup.mjs` — a full backup to the directory you give. No backup, no migration.
2. `emdash seed site/seed/migrations/1.2.0.json --no-content --on-conflict update`
   adds 8 collections (clients, products, services, service_instances, contracts,
   blueprints, work_items, exceptions), 17 relations, and to `evidence` the fields
   `subject` and `identifier` and the control attestation options. `evidence` is
   listed with its complete field list, so nothing is removed. No other 1.1
   collection is touched; no 1.1 record, key, relation or graph id changes; no
   unique index is added to an existing field.
3. `emdash seed … --on-conflict skip` adds the *Client onboarding* blueprint as a
   **draft**, only if it is missing. Nothing is activated.

After starting: the dashboard widget *Entities and onboarding* (and
`entities/summary`) report `schema ok` or the exact missing pieces; entity
proposals, registration checks, the blueprint runner and the identity task
refuse to act until it is ok. No plugin
storage is added: the identity registry is the `identifiers` collection, and
onboarding state is work items (plugin version 1.2.1). The `identity` task then
mirrors Mission 001 serials and ECIDs as read-only registry entries.

ADR-0008/0009 and REQ-008/009 are in the 1.2 seed for fresh installs; on a
migrated installation, add them by hand if you want them in Engineering.

**Rollback:** stop EmDash, restore the backup into an empty directory
(`scripts/restore.mjs`), point `POWERFARM_DATA_DIR` at it, start 1.1 code. The
1.2 collections are additive; nothing in 1.1 depends on them.

**Patch 0002** must be applied (setup.sh does it). Without it EmDash silently
drops the references a blueprint asks for; the runner checks the relation table
after every create, so such a step stops at *needs attention* naming the patch
instead of reporting success. Nothing else depends on it.

## 1.0 → 1.1

1.0 was delivered but never deployed, so the recommended path is a **fresh
install** of 1.1 (`scripts/setup.sh`, new data directory, apply the seed).

If a 1.0 database does exist, do not reuse it for Mission 001: the content model
changed in ways that affect approval and trust.

| 1.0 | 1.1 | Why |
| --- | --- | --- |
| `assets.trust_state`, `assets.recovery_state` (editable) | removed; status is **derived** from real jobs and evidence | A hand-editable trust field let anyone, including AI with content:write, declare a device trusted. |
| `recovery_operations.bridge_operation` | `operation` (bridge and manual operations) | Mac work is manual; one registry for both. |
| `backup_waived` (boolean) | `data_decision`: backup_verified / backup_waived / no_user_data / blocked, plus `backup_op_code` | A destructive operation must say what happens to data, and a verified backup must be real, same asset, after the last restore. |
| Job id = operation id | `<opId>:<liveRevisionId>` | Approval binds the exact revision; editing after publish never changes what runs. |
| Job states without `needs_inspection` | `needs_inspection` added; no automatic retries | Unknown outcomes on devices must be looked at by a person. |
| Events written directly | Journal (hash-chained, plugin storage) → `events` projection | Durable, verifiable history; events are immutable. |
| Evidence hash from the bridge | SHA-256 computed by the server from the stored media | The bridge's claim is not proof. |
| `site-public` second instance | removed | One internal instance during Mission 001. |
| Seed with example serials | no identifiers seeded | Invented identifiers would make exact verification meaningless. |
| MCP tool names `recovery_*` | `powerfarm__*` (22 tools) | Aligned with the mandate's tool list. |

Manual carry-over, if wanted: re-enter procedures' local notes and any research
content by hand in the 1.1 admin. Do not carry over job or event data.
