# Apple operations: compatibility matrix and physical actions

**Nothing in this table has been run on Powerfarm hardware.** Every bridge
operation starts *not enabled* and is offered to EmDash only after
`powerfarm-bridge validate <op>` has recorded it for this host, this macOS major
version and this exact cfgutil version. Changing either disables it again.

## Matrix

| Operation | Device class | Adapter | Command / method | Destructive | Evidence required | Status in 1.1 |
| --- | --- | --- | --- | --- | --- | --- |
| `inventory` | iPhone, iPad | bridge (cfgutil) | `cfgutil --format JSON --ecid <E> get ECID serialNumber deviceType firmwareVersion buildVersion activationState` | no (read) | inventory_report | not validated |
| `verify` | iPhone, iPad | bridge (cfgutil) | same as inventory, compared exactly against the asset | no (read) | verification_report | not validated |
| `backup` | iPhone, iPad | bridge (cfgutil) | `cfgutil --ecid <E> backup` | no | backup_manifest | not validated |
| `restore` | iPhone, iPad | bridge (cfgutil) | `cfgutil --ecid <E> restore` (erases; requires typed local confirmation) | **yes** | restore_log | not validated |
| `install_profile` | iPhone, iPad | bridge (cfgutil) | `cfgutil --ecid <E> install-profile <profilesDir>/<name>.mobileconfig` | no | install_log | not validated |
| `mac_inventory_manual` | Mac (AS, Intel) | manual | About This Mac / System Information | no (read) | inventory_report or attestation | manual only |
| `mac_recovery_reinstall` | Mac (Apple silicon) | manual | macOS Recovery on the Mac: erase, reinstall | **yes** | attestation | manual only |
| `mac_dfu_revive` | Mac (Apple silicon) | manual | Finder on a second Mac (macOS 14+): Revive Mac | no (firmware) | attestation | manual only |
| `mac_dfu_restore` | Mac (Apple silicon) | manual | Finder on a second Mac (macOS 14+): Restore Mac | **yes** | attestation | manual only |
| `mac_verify_manual` | Mac (AS, Intel) | manual | About This Mac, compared exactly | no (read) | verification_report or attestation | manual only |
| `backup_manual` | any | manual | Time Machine / Finder / copy | no | backup_manifest | manual only |
| `security_baseline` | any | manual | account, Activation Lock, management enrolment | no | attestation | manual only |

Mac DFU is deliberately manual (ADR-0005): no automated Apple-silicon DFU route
was validated, and an unattended firmware restore of the wrong Mac is
unrecoverable.

## Hosts

| Machine | Role | Can it be a DFU host? |
| --- | --- | --- |
| LAB 001 — MacBook Pro 2012, Intel, macOS Catalina 10.15.7 | communications terminal, out of scope | **No.** Revive/Restore Mac in Finder needs macOS 14+; The Apple Configurator releases that handle Apple-silicon Macs do not run on Catalina either. |
| LAB 512 — Mac mini M1 | trusted host (EmDash VM + bridge) | Yes, after its own recovery and once on macOS 14+. It is the DFU host for LAB 8GB and LAB 256. |
| — | DFU host for LAB 512 itself | A **second** trusted Mac on macOS 14+ (borrowed, or Apple-authorised service). LAB 512 cannot DFU-restore itself. Try its own macOS Recovery first. |

## Physical actions a person must perform

The platform never claims these happened; it records what the person attests.

1. **LAB 512 bootstrap** (before EmDash exists): hold power → Options →
   macOS Recovery → erase → reinstall. If Recovery is unavailable, DFU from a
   second Mac on macOS 14+. New local admin, FileVault on, no restored data or
   profiles. Later recorded with a manual operation marked `recordOnly`.
2. **Reading Mac identity**: serial from System Settings → General → About;
   ECID only if DFU is used (from Apple Configurator on the DFU host).
3. **Putting a Mac in DFU mode** (target off, connected to the DFU port with a
   USB-C *data* cable, the model-specific key sequence), then in Finder on the
   host choosing Revive or Restore.
4. **Connecting an iPhone**: USB data cable to LAB 512's macOS, unlock, tap
   *Trust*. For restore, the bridge then asks you to **type the asset tag** in
   its terminal; under launchd (no terminal) destructive jobs fail closed.
5. **Setup Assistant** after any restore: sign in with Powerfarm's Apple Account,
   confirm Activation Lock belongs to it, decline unknown management enrolment.
6. **Attestations**: `account_security`, `activation_lock`,
   `management_enrollment` after the restore; `trust_signoff` by an
   Administrator after verification.
7. **Inspection** after an interrupted operation: look at the device, record what
   you see (Admin → Recovery → job → Resolve inspection). Do not start another
   restore; an inventory is required next.
8. **Validation of bridge operations** on a test device you are prepared to erase
   (`powerfarm-bridge validate <op>`).
9. **Off-site backup copy and restore test** (BACKUP-RESTORE.md).
