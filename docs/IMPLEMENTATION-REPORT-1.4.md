# Implementation report — Powerfarm EmDash Platform 1.4.0

Date: 3 November 2026.

Base: EmDash `981c78d` (1.4.0), with patches 0001 and 0002. 1.4.0 adds no new patch.

Scope: the rest of **Powerfarm Identity** ([IDENTITY.md](IDENTITY.md), ADR-0012):
- principals and permanent ids;
- grants and the `authorize()` boundary;
- policies, suspension and record seals;
- Powerfarm as the OIDC identity provider for Cloudflare Access;
- Access assertions for Free Zone services, and Access logs as incidents;
- the release gate.

All of it is wiring EmDash's own mechanisms. There is no second user store, no directory and no side service.

## EmDash mechanisms used (read in the pinned source first)

| Need | EmDash 981c78d | Where |
| --- | --- | --- |
| Principals, grants, policies, releases | Content with drafts and revisions. Publish is approval; unpublish is withdrawal. | seed, `content:beforePublish` / `beforeUnpublish` |
| Permanent ids | `content:beforeSave` (assign, refuse changes) | `entity-policy.ts` |
| Signing keys | Secret plugin settings: `settings.set` on a `type: "secret"` field encrypts with `EMDASH_ENCRYPTION_KEY`, and the value is redacted from logs | `core/src/plugins/settings.ts` |
| Outbound calls | `network:request` with `allowedHosts` (`api.cloudflare.com`, `*.cloudflareaccess.com`) | `core/src/plugins/context.ts` |
| OIDC endpoints | Raw public routes (`body: "none"` gives the query as input; `form-data` gives entries), `pluginResponse()` | `core/src/plugins/route-wire.ts` |
| Watching | Plugin cron: `access-logs` hourly, `seals` every 5 minutes | `reconcile.ts` |

**Constraints found, and how they shaped the design:**
- **Public plugin routes get no user.** `dispatchPluginApiRequest` passes `caller = undefined` for public routes, even when a session cookie is present.
- **Private routes accept a session only with `X-EmDash-Request: 1`, also on GET.** A top-level browser redirect cannot carry that header.

So the step that turns an EmDash session into a code cannot be a redirect target. It is now:
- a private JSON route `oidc/continue`;
- a static site page `/oidc/continue` that calls it with the header and follows the answer.

The page holds no logic. This keeps EmDash's CSRF protection in force for the one step that uses a session.

**Other findings:**
- Raw public routes allow only same-origin `Location`. `oidc/authorize` therefore redirects only to `/oidc/continue`; the external redirect to Cloudflare is done by the page.
- EmDash's admin login sanitises `?redirect=` to same-origin paths. `/oidc/continue?rid=…` qualifies.
- A repeated query parameter arrives as an array. `oidc/authorize` treats it as missing and refuses it, rather than using the first value.
- EmDash in `access()` auth mode would make Access and Powerfarm wait on each other. EmDash must stay in passkey mode; this is documented.

## What was built

**Seed:**
- new collections: `organizations`, `agents`, `grants`, `policies`;
- `people` is now an entity;
- `releases` now supports drafts and carries the CI and deploy fields;
- `principal_id` on every entity;
- four identity relations;
- ADR-0012, release 1.4.0 and migration `1.4.0.json`.

Totals: 29 collections, 38 relations.

**Plugin:**
- `authority.ts`:
  - nine capabilities;
  - `GOVERNED_PATHS`;
  - `principalOf` and `principalBySubject`;
  - `authorize()`: two layers (EmDash role and grant), advisory or enforced, agents under a delegator, everything journalled;
  - grant rules (≤30 days for agents, ≤366 for people; no self-grants; a recorded bootstrap).
- `suspension.ts`: revoke grants, open work items, raise an incident.
- `seals.ts`: seal-pending marker, seal, reconciliation, status.
- `release.ts`: draft, approval check, one-time deploy authorisation, deployment record.
- `jwt.ts`: RS256 with WebCrypto.
- `oidc.ts`: authorize, continue, token, JWKS, discovery, key rotation, clients.
  - Clients are kept in KV, so the settings screen cannot add one.
  - Client secrets are kept only as hashes.
  - Codes are single use (compare-and-delete) and PKCE uses S256.
  - Active status is re-checked when the token is issued.
- `cloudflare.ts`: Access assertion verification (team keys cached for 1 hour) and the `access-logs` task.
- `identity-routes.ts`: all routes, including the signed release routes, which use the bridge's HMAC scheme with their own ids and secrets.
- Settings: authority, OIDC keys, Cloudflare and release.

**Site:**
- `src/pages/oidc/continue.astro`, a static page.

**Scripts:**
- `release.mjs`:
  - `draft` for CI;
  - `deploy` for the release service, which hashes the artifact, authorises, re-hashes, runs the command without a shell and reports.
- `edge-check.mjs --oidc` checks:
  - the Bypass is exact;
  - no private key component is published;
  - the rest of Identity is still behind Access.
- `backup.mjs` and `restore.mjs`: journal heads per stream.

## Tests

| Suite | 1.3.0 | 1.4.0 |
| --- | --- | --- |
| Plugin | 133 | 153 |
| Bridge | 33 | 33 |

**New tests:**
- `authority.test.ts` (8): principals, advisory and enforced modes, bootstrap, every governed path wired, agents, suspension, release gate.
- `seals.test.ts` (4).
- `oidc.test.ts` (6), which calls the route handlers:
  - the full sign-in with PKCE, verified against the published keys;
  - refusals: redirect, duplicate parameter, secret, verifier, no session, API token, no person, suspended mid-flow;
  - governance of key rotation and client registration;
  - `whoami-access` with real RS256 assertions (wrong audience, service token, expired, forged);
  - the Access logs task;
  - the signed release routes, including replay.
- `release-script.test.ts` (2):
  - `scripts/release.mjs` against the plugin's routes. Node's HMAC is checked against the Worker's WebCrypto, and a different artifact and an unapproved version are both refused before anything runs.
  - the `--oidc` edge check.

**Validation and type checks:**
- The seed and the 1.2, 1.3 and 1.4 migrations pass EmDash's own `validateSeed`. Its `SchemaError` import was stubbed so that it loads without database dependencies.
- The type check of the plugin's server code against the pinned EmDash sources shows no Powerfarm errors except implicit-`any` on `definePluginRoute` handler parameters. Those come from EmDash's route types not resolving without installed dependencies, and the 1.3 routes show the same.

**Bug found by the tests:** the Access logs cursor compared timestamps as strings, which fails when one has milliseconds and the other does not. It now compares times and starts 1 ms after the last row, so rows are not counted twice.

## Security notes

- The OIDC token carries no authority. `sub` is the opaque permanent id. Authority is decided by Powerfarm on every action, from published grants.
- Suspension wins at every Powerfarm gate at once. It cannot reach into EmDash's own user and token tables or Cloudflare's sessions, so it opens work items for those.
- The bypassed sign-in paths are internet-reachable by design. EmDash's passkey sign-in guards them. Self sign-up must stay off.
- A break-glass Access login is required, so that a Powerfarm outage does not lock administrators out.
- `whoami-access` trusts only identities Powerfarm itself issued. Applications that rely on it should allow only the Powerfarm IdP.
- The OIDC signing key lives in the Worker as an encrypted secret. Anyone with EmDash admin and the encryption key could sign tokens. Moving it to a separate signing Worker is the next hardening step.
- CI can only draft. The release service can only deploy what a person approved, once, within 15 minutes, for the exact digest.

## Not run (nothing below has happened)

- No Cloudflare deployment of 1.4; no `astro build` or EmDash dispatcher; no browser.
- No real Cloudflare Access sign-in through Powerfarm. Not confirmed: that Access accepts the token response (no userinfo endpoint), how `groups` behave in policies, and the break-glass login.
- No real Access audit-log API call. The field names follow Cloudflare's documentation and are unconfirmed.
- No real Free Zone service, CI pipeline or release service.
- Nothing new on Apple devices or hardware.
