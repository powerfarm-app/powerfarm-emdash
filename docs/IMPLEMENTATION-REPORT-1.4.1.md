# Implementation report — Powerfarm 1.4.1

Date: 3 November 2026. Base: EmDash `981c78d` (1.4.0) with patches 0001–0003.

1.4.1 acts on an outside review of 1.4.0 that compared Powerfarm with EmDash's own identity layer. Each finding was checked against the pinned source before anything changed. The aim was to integrate what EmDash already has, not to rebuild it.

## Changes

| # | Finding (checked) | Change |
| --- | --- | --- |
| P1 | PKCE was optional in Powerfarm's OIDC provider: checked only when a challenge was sent | S256 PKCE is mandatory, and challenge and verifier formats are validated. The verifier is checked *before* the code is consumed, so a wrong verifier cannot burn the legitimate client's code. The code stays single-use under concurrent exchanges. |
| P2 | `email_verified: true` was hard-coded. EmDash stores `User.emailVerified`, but the user shape plugins receive drops it | **Patch 0003** (34 lines, generic, with an EmDash test) passes `emailVerified` to plugins. The claim is `true` only when EmDash verified the account's address *and* it is the Powerfarm person's address. If the address changes between sign-in and token, the verification lapses. |
| P3 | `whoami-access` found people by an e-mail mapping (`oidc:issued:<email>`) | ID tokens carry `pf_principal_id`. Cloudflare copies it into its assertion (`oidc_fields`), and Powerfarm resolves the principal by that permanent id (`principalById`). The e-mail mapping is removed. |
| P4 | `whoami-access` answered for suspended principals | It now refuses them with 403 `principal_inactive`, even while a Cloudflare session issued earlier is still valid. |
| P5 | `authorize()` swallowed journal failures (`.catch(() => undefined)`) | Fails closed. If a decision cannot be journalled, it is not given, the platform is marked audit-degraded, and the protected publish is aborted. |
| P6 | Route tests do not prove the real Cloudflare flow | The identity-continuity scenario was added to the live checks (IDENTITY.md, last section). |
| P7 | The issuer was derived from the request's hostname | The issuer comes from EmDash's canonical site URL (`ctx.site.url`, set by `EMDASH_SITE_URL`). Powerfarm refuses to act as a provider without it, or if it is not `https://`. |

## Not changed, deliberately

- **EmDash user disablement:** EmDash disables users itself and rejects disabled users even behind Access. The user shape plugins receive does not include `disabled`, and EmDash's user repository does not map it either. So Powerfarm still opens the "disable the EmDash user" work item on suspension rather than touching EmDash's tables. A narrowly scoped upstream API would be the clean way to automate it.
- **EmDash's OAuth 2.1 server** stays as it is, serving MCP and API clients. Powerfarm's OIDC provider exists only because Cloudflare Access needs ID tokens.

## Tests

- **Plugin:** 161 tests pass (156 → 161). The new or rewritten ones are:
  - mandatory PKCE, with each malformed or missing case;
  - a wrong verifier that does not burn the code;
  - three concurrent exchanges yielding exactly one token;
  - `email_verified` across passkey-only, verified, mismatched and changed addresses;
  - `pf_principal_id` resolution and e-mail reassignment;
  - inactive principals refused;
  - the canonical issuer from an alias hostname, and refused without one;
  - fail-closed journal with an aborted publish.
- **Patch 0003** brings its own EmDash unit test, which CI runs with the other patch tests.

Not run anywhere yet: a real Cloudflare Access sign-in, including whether Cloudflare accepts `email_verified: false` and how `pf_principal_id` appears in its assertion.
