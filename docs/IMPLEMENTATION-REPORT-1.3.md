# Implementation report — Powerfarm EmDash Platform 1.3.0

Date: 3 November 2026. Base: EmDash `981c78d` (1.4.0), patches 0001 and 0002
(no new patch). Context: six Apple devices compromised, attacks continuing.
Scope: the first part of **Powerfarm Identity** ([IDENTITY.md](IDENTITY.md)) —
a thin MDM inside the Powerfarm plugin ([MDM.md](MDM.md), ADR-0011).

## EmDash mechanisms used (read in the pinned source first)

| Need | EmDash 981c78d | Where |
| --- | --- | --- |
| Device endpoints | plugin routes with `methods: ["PUT"]`, `request: { body: "bytes", headers: [...] }`, `response: "raw"` + `pluginResponse()` | `plugin-types/src/routes.ts`, `core/src/plugins/route-wire.ts` |
| No CSRF block for devices | public routes accept non-browser requests without `Origin` | `core/src/api/csrf.ts` |
| Alerts | `email:send` capability → `ctx.email` when a provider is configured | `core/src/plugins/types.ts` |
| Watching | plugin cron through the Worker's `scheduled()` | as in 1.2.2 |
| Constraint found | raw routes refuse `application/xml` responses | `ALLOWED_RESPONSE_HEADERS` / `ACTIVE_RESPONSE_TYPES`: plists go out as `application/x-plist` (to confirm on a device) |

Cloudflare: the custom device posture integration calls an external API with
device serial numbers and expects a 0–100 score per device (Cloudflare One
docs); MDM partners listed by Cloudflare do not include a self-built MDM, so the
custom integration is the way in.

## What was built

Plugin (`src/mdm/`): `plist.ts` (strict XML plist codec, no entities, depth and
size limits), `cms.ts` (DER/BER reader, detached CMS verification, certificate
chain to the device CA, RSA and ECDSA, WebCrypto only), `protocol.ts`
(Authenticate, TokenUpdate, CheckOut; command delivery and results; identity
binding), `commands.ts` (closed command set, result → facts), `vigilance.ts`
(rules, incidents, alerts, score, cron task), `posture.ts` (Cloudflare posture,
push queue), `policy.ts` (incidents and profiles in EmDash's hooks), `routes.ts`,
`model.ts`. A dashboard widget *Managed devices and incidents*. Seed:
`incidents`, `mdm_profiles`, ADR-0011, release 1.3.0, migration `1.3.0.json`.

Bridge (`src/mdm.mjs`): device CA (P-256, key mode 600, never overwritten),
per-device identities (CN = UDID, key deleted after packing), enrolment profile
(AccessRights 1843: no erase, no lock), APNs push sender (HTTP/2 with the push
certificate) and relay; CLI `mdm-ca init`, `mdm-profile <UDID>`; pushes relayed
in the run loop.

## Tests

Plugin **133** pass (1.2.2's 118, plus 4 plist/CMS, 10 MDM end to end, 1 edge
check). Bridge **33** pass (28 + 5). Seed and migrations valid under EmDash's
validator. Type-check clean apart from absent type packages.

What the tests prove with real cryptography: OpenSSL-made device signatures
(P-256 and RSA, detached CMS with signed attributes) verify; changed messages,
look-alike CAs, expired and attached signatures are refused; an identity and
enrolment profile built by the bridge are accepted by the plugin as they are;
the push sender presents the push certificate over HTTP/2.

**Not run**: a real Apple device enrolling or checking in; Apple's push service;
the content type Apple's MDM client accepts; Cloudflare (Access bypass path,
posture integration); EmDash's build; LibreSSL on macOS for the CA commands.

## Security notes

- The enrolment grants no erase/lock/passcode rights; unlock tokens are
  discarded.
- Only devices with a CA-issued identity named after their UDID, and a serial
  that is a published asset, can enrol. A second identity for an enrolled UDID
  is refused and is a critical incident.
- Profiles with MDM, root-certificate or identity payloads, or credentials, are
  refused before they can be approved.
- The MDM path must bypass Access (devices cannot sign in to it); the signature
  is the lock there. The posture path stays behind Access.
- Refused messages without a valid CA signature do not create incidents, so
  random internet traffic cannot flood the incident list.
