# Mission 001 acceptance

Mission 001 is complete when all six targets — LAB 512, LAB 8GB, LAB 256,
iPhone 13 RED, iPhone 14 PURPLE, iPhone 15 BLACK — are **trusted**. LAB 001 is the
communications terminal and is out of scope.

The checklist below is computed by the platform (`acceptanceChecklist` in
`plugin/src/recovery.ts`; Admin → Recovery, the asset panel, MCP
`get_verification_status`). It is not editable. An asset's status is derived from
real jobs and evidence; simulations and dry runs never count.

## Per asset

| # | Check | Passes when |
| --- | --- | --- |
| 1 | Identity recorded | Serial number recorded; ECID too for iPhones (Macs without DFU are identified by serial). |
| 2 | Real inventory confirmed the identity | A real (not dry-run, not simulated) inventory succeeded and its observed identity matches. |
| 3 | Real erase and restore completed | A real `restore`, `mac_recovery_reinstall` or `mac_dfu_restore` succeeded. |
| 4 | Real verification after the latest restore | A real verify after the last restore; earlier ones are ignored. |
| 5 | ECID matches exactly | Where required. |
| 6 | Serial number matches exactly | Always. |
| 7 | OS meets the acceptance policy | The asset's `os_policy` is set (an empty policy fails) and the observed OS meets it. |
| 8–10 | Attestations after restore | `account_security`, `activation_lock`, `management_enrollment`, each signed by a person. |
| 11 | Evidence digests verified by the server | The verification has evidence whose SHA-256 the server computed from the stored file. |
| 12 | No active, failed or unresolved jobs | Including no `needs_inspection`. |
| 13 | Audit journal intact | Not in audit-degraded state. |
| 14 | Trust signed off by a person | An Administrator's `trust_signoff` attestation after verification. |

## Mission

- [ ] Fleet shows 6 targets, 6 trusted (`get_fleet` → `complete: true`).
- [ ] Journal verifies for every stream (Admin → Audit and health).
- [ ] A backup taken **after** the last asset became trusted has been restored
      on another machine and passed `restore.mjs` (BACKUP-RESTORE.md).
- [ ] `tests` records updated by hand with what was actually run
      (TEST-INTEGRATION, TEST-HW-IOS, TEST-HW-MAC).
- [ ] Mission M001 record set to complete by a person.

## Values a person must enter before acceptance is possible

The seed deliberately records **no** serial numbers, ECIDs or OS policies (none
were known; inventing them would make verification meaningless). For each asset:

- `serial_number`, `ecid` — from a real inventory (iPhones) or About This Mac.
- `os_policy` — either a minimum version (`>=18.0`) or an exact version (`18.1`).
  Decide it before restoring.
