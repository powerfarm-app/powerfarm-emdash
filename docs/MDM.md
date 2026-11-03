# Powerfarm MDM — set-up and daily use

A thin MDM inside the Powerfarm plugin, on EmDash (ADR-0011). It speaks Apple's
MDM protocol from two plugin routes, keeps device state and commands in plugin
storage, takes decisions as EmDash content (profiles an administrator publishes,
incidents people close) and records what it sees in the Powerfarm journal.

What it does: inventory and security state of every enrolled iPhone and Mac,
installation of approved configuration profiles, detection of profiles nobody
approved, devices that stop reporting, downgrades and weakened security, a
0–100 health score that Cloudflare Access can require.

What it cannot do, by design: erase, lock, clear a passcode, or manage apps.
The enrolment profile does not grant those rights (`AccessRights` 1843), so a
compromised Powerfarm cannot be used against the fleet. Erasing stays a
physical, bridge-run, approved operation (Mission 001 procedures).

## Where the keys live

| Key | Where | Why |
| --- | --- | --- |
| Device CA private key | the lab Mac only (`~/.powerfarm/mdm-ca/ca.key`, mode 600), plus an offline backup | whoever holds it can mint device identities |
| Device CA certificate (public) | EmDash setting *MDM: device CA certificate* | the Worker checks every device message against it |
| Each device's identity | the device's keychain (installed by the enrolment profile) | the device signs every message with it |
| MDM push certificate | the lab Mac only (`~/.powerfarm/mdm-push.p12`) | whoever holds it can wake the devices |
| Push token per device | Powerfarm storage | only useful together with the push certificate |
| Unlock token | **nowhere** (discarded) | Powerfarm has no right to clear passcodes |

## 1. Once: the push certificate

Apple issues MDM push certificates through the Apple Push Certificates Portal
(`identity.apple.com`), signed in with the Apple Account that will own it. The
request (CSR) must be signed by an "MDM vendor" certificate: either an Apple
Developer Enterprise Program membership, or a vendor-signing service of the kind
open-source MDMs use (for example mdmcert.download). Use an Apple Account that
is secured with hardware keys and used for nothing else. The certificate expires
yearly; **renew it from the same Apple Account**, or every device must re-enrol.

On the Mac: save it as `~/.powerfarm/mdm-push.p12` with its password in
`~/.powerfarm/mdm-push.password` (both mode 600). Its topic is the certificate's
UID: `com.apple.mgmt.External.<uuid>` (`openssl pkcs12 -in mdm-push.p12 -nokeys | openssl x509 -noout -subject`).

## 2. Once: the device CA

```bash
node ~/powerfarm/mac/bridge/bin/powerfarm-bridge.mjs mdm-ca init
```

Copy the printed certificate into EmDash → Plugins → Powerfarm → *MDM: device CA
certificate*. Back up `~/.powerfarm/mdm-ca/` offline (an encrypted USB drive in
a safe place). Losing it means re-enrolling every device; leaking it means an
attacker can pretend to be a device (they still could not command one).

## 3. Once: Cloudflare and EmDash

1. Content model: fresh deployments have it. An existing 1.2 site needs the two
   collections of `site/seed/migrations/1.3.0.json` (*Incidents*, *Device
   profiles*), created in the admin (Content types) or with `emdash schema`.
2. Cloudflare Access, two more applications on the same hostname:
   - path `_emdash/api/plugins/powerfarm/mdm` → policy action **Bypass**
     (devices cannot sign in to Access; their signature is the lock). Only this
     path.
   - path `_emdash/api/plugins/powerfarm/posture` → **Service Auth** with a new
     service token `powerfarm-posture`.
3. Plugin settings: *MDM: push topic*, *MDM: alert e-mail* (an address on an
   account and device you trust), then turn on *MDM: accept device check-ins*.
4. Bridge config (`~/.powerfarm/bridge.json`): the `mdm` block (topic, CA folder,
   push certificate files). Restart the bridge: it now relays pushes every poll.
5. `node scripts/edge-check.mjs --url https://<host> --mdm` — the device path must
   be answered by EmDash (unsigned → refused), the posture path stopped by Access.

## 4. Each device: enrol

Enrolment is physical and goes through the bridge, so nobody can enrol a device
from afar. The device should be clean first (Mission 001: erased and restored,
or at least inspected), and supervised if it is an iPhone (Apple Configurator).

1. The device is a published asset with its serial number filled in.
2. Its UDID: `powerfarm-bridge devices` (or Apple Configurator).
3. `powerfarm-bridge mdm-profile <UDID>` writes `enrol-<UDID>.mobileconfig` into
   the bridge's profiles folder. It contains the device's private key: it is
   mode 600 and must be deleted after use.
4. In EmDash, a recovery operation `install_profile` for that asset with that
   profile file; a person approves it by publishing, as for every operation.
5. The bridge installs it; on an unsupervised device, confirm on the screen.
6. Within a minute: the dashboard's *Managed devices* lists it, enrolled, with a
   first inventory. Delete the profile file.

The server accepts an enrolment only if the message is signed by an identity
from the Powerfarm CA whose name is that device's UDID, and the serial number is
a published asset. Anything else is refused and opens an incident.

## 5. Daily: profiles

*Content → Device profiles*. Paste a `.mobileconfig` (unsigned XML), give its
PayloadIdentifier, choose *required* (installed on every matching device),
*available*, or *known external* (a profile Powerfarm did not make but you
accept on devices, by identifier only). Editors draft; an administrator
publishes — a second administrator when *Require a second person* is on.
Powerfarm refuses profiles that carry another MDM enrolment, a root certificate
or an identity, and anything that looks like a credential. Unpublishing a
profile removes it from the devices.

Start with: a passcode policy; restrictions you want (AirDrop, pairing with
untrusted hosts, USB accessories while locked); later, the Wi-Fi and VPN you
rely on, without passwords in them. Turn Lockdown Mode on by hand on each device
(it is not something an MDM profile switches on). FileVault: switch it on by hand
and keep the recovery key offline; Powerfarm does not escrow keys.

## 6. Daily: incidents

*Content → Incidents* (and the dashboard). Powerfarm opens them; repeats raise
the count instead of creating new ones. Severity:

| Rule | Severity |
| --- | --- |
| a profile nobody approved; device left management; message signed by a different device identity; System Integrity Protection off; OS went backwards | critical |
| not seen for 24 h; no passcode; FileVault off; enrolment refused | high |
| not supervised; OS outside the asset's policy; identity expiring; required profile failed; re-enrolled with a new identity | medium |

Critical and high incidents are e-mailed to the alert address if EmDash has an
e-mail provider; the mail has no links on purpose. To close one, set *Status* to
resolved or false positive and write what was done. Closed stays closed; if it
happens again, Powerfarm opens a new one. AI clients can read incidents through
Powerfarm's tools but cannot change them.

## 7. Cloudflare Access posture

In Zero Trust: add a **custom device posture integration** pointing at
`https://<host>/_emdash/api/plugins/powerfarm/posture/score`, authenticated with
the `powerfarm-posture` service token; then a posture check on its score, and in
the policies that matter, require *score ≥ 70*. Devices need the Cloudflare One
(WARP) client so Cloudflare can identify them by serial number. Score: 100
healthy; 90 with a low, 70 with a medium, 40 with a high open incident or not
seen for 24 h; 0 with a critical one, or not enrolled.

## 8. When the lab is down

Devices keep checking in with Cloudflare; findings and incidents keep working.
Commands queue until the Mac relays a push; devices also check in on their own
from time to time, so commands do not wait forever. Nothing is lost.

## 9. Not verified yet (first live checks)

- A real iPhone and Mac enrolling from the bridge-built profile: the profile
  installs, the identity imports, check-in succeeds.
- Apple's MDM client accepting command plists served as `application/x-plist`
  (EmDash's raw routes refuse `application/xml`). If it insists on
  `application/xml`, that needs a small EmDash patch.
- Mdm-Signature verification with the device's real signatures (tested here
  with OpenSSL-made CMS signatures, P-256 and RSA).
- Pushes to Apple's service with a real MDM push certificate (tested here
  against a local HTTP/2 server presenting a client certificate).
- On the Mac, `openssl` being LibreSSL: `-addext` needs LibreSSL 3.1+; otherwise
  set `POWERFARM_OPENSSL` to Homebrew's OpenSSL.
- The Cloudflare custom posture integration calling the route.
