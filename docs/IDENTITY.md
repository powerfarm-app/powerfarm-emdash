# Powerfarm Identity

Identity covers six concerns. All of them are built on EmDash:
- content and relations record what people decide;
- plugin storage holds operational state;
- hooks enforce the rules;
- cron does the watching;
- the journal keeps the history.

Cloudflare Access is the front door, Powerfarm is the identity provider that Access trusts, and the lab Macs hold the keys and do the device work.

| Pillar | Question it answers | In Powerfarm 1.4 |
| --- | --- | --- |
| **Identity** | Who or what is this, and which record is it? | People, organisations and agents are entities with a permanent `principal_id`. The identifier registry links EmDash users, OIDC subjects, Apple managed accounts, UDIDs, git identities and credentials to exactly one principal. Assets have serial and ECID; MDM devices are identified by their Powerfarm CA identity. |
| **Access** | Who and which device may get in? | Cloudflare Access sits in front of everything. Powerfarm is Access's OIDC identity provider: only active people get in, and `sub` is their permanent id. Bridge and posture use service tokens, and an MDM posture score feeds Access policies. EmDash passkeys and roles work behind all of this. Free Zone services learn who their caller is through `identity/whoami-access`. |
| **Authority** | Who may decide what? | Explicit, published, expiring **grants** of nine capabilities. `authorize()` checks them on every governed path: advisory first, then default-deny per capability. A two-person rule and no self-grants apply after a recorded bootstrap. Agents act only under a delegating person. The release gate is enforced from CI, through approval, to deploy. |
| **Security** | What state must each thing be in? | Evidence-backed lifecycle controls. MDM profiles are required by publication. Device baseline checks. **Policies** are documented or enforced, with an owner, a review date and what enforces them. |
| **Vigilance** | Is anything wrong right now? | Incidents from devices, from refused messages and from Cloudflare Access logs (refused sign-ins, first sign-in from a new country). Suspension is an incident too. **Record seals** detect a published record that changed outside its approval. |
| **Maintenance** | What must be done regularly? | Review cadences, scheduled device reports, required profiles kept installed, certificate expiry, grant expiry, key rotation, and a `seals` task that finishes any seal a publish left pending. |

## What it is made of (all EmDash)

| Thing | EmDash mechanism |
| --- | --- |
| People, organisations, agents | Entity collections (drafts, revisions, relations). Registering is a publish, and so is activating. |
| Grants, policies, releases | Content with drafts. **Publishing is approval.** Withdrawing a grant means unpublishing it. |
| Principal ids, identifiers | `beforeSave` assigns the id, and the registry is plugin storage with unique keys. |
| `authorize()` | Called inside Powerfarm's publish hooks and routes. It reads published grants and writes the journal. |
| OIDC provider | Plugin routes (`oidc/*`) plus one static site page (`/oidc/continue`). Signing keys are encrypted secret settings, and clients are kept in plugin KV. |
| Access logs, seals | Plugin cron tasks (`access-logs` hourly, `seals` every 5 minutes). |
| Suspension | `afterPublish` of a person or agent whose lifecycle is now suspended or retired. |

Some things are **not** hookable in EmDash 1.4:
- EmDash's own users, roles, API tokens, schema and settings screens.
- Classification on EmDash's native content screens.

Suspension therefore opens work items ("disable the EmDash user", "revoke Access sessions and tokens") instead of pretending to do them.

## 1. Principals

- Every person, organisation and agent gets a `principal_id` (a UUID) the first time it is saved. It never changes: no edit, rename, new e-mail or merge changes it, and nobody can set it.
- An EmDash user is linked to a person by an identifier `emdash_user:<user id>` on that person. Publishing the person claims the identifier in the registry, so one user maps to one principal.
- Only active principals count. An intake, suspended or retired principal holds no authority, and a person in that state cannot sign in through Access.

## 2. Bootstrap authority (once)

With no grants yet, the first `authority.grant` is the bootstrap:

1. Register yourself as a person:
   - owner: the Powerfarm organisation;
   - identifier `emdash_user:<your EmDash user id>`;
   - `contact_email`;
   - `access_groups: ["administrators"]`.

   Publish it, then activate it once its controls are met.
2. Draft a grant:
   - principal: `people:PE-…` (you);
   - capability: `authority.grant`;
   - scope: `*`;
   - a task;
   - `valid_until` at most 366 days ahead.

   Publish it as an Administrator.

The journal records `authority.bootstrap`:
- `selfGrant: true` if you granted yourself;
- `twoPersonRuleSatisfied: false` while you are the only administrator.

From then on:
- only a holder of `authority.grant` can publish grants;
- nobody can publish a grant to themselves;
- with `requireSecondPerson` on, the author of a grant cannot publish it.

Recommended next step: register a second administrator, give them `authority.grant`, and let them grant you the rest.

## 3. Capabilities, and turning enforcement on

| Capability | Governs |
| --- | --- |
| `authority.grant` | publishing and withdrawing grants |
| `identity.admin` | publishing people, organisations and agents; identifier transfers |
| `idp.keys` | `identity/oidc/rotate-key` |
| `idp.config` | `identity/oidc/client` |
| `policy.publish` | publishing and withdrawing policies |
| `approve.destructive` | approving destructive recovery operations (scope `assets:<TAG>`) |
| `approve.profile` | publishing and withdrawing MDM profiles |
| `mdm.command` | `mdm/query` (agents may hold it, under a person) |
| `release.production` | approving a release (scope `releases:<environment>`) |

The authoritative list of paths is `GOVERNED_PATHS` in `plugin/src/authority.ts`, and a test fails if one of them is not wired.

**Advisory mode (default).** Each check runs and is journalled:
- `authority.allowed` when a grant covers it;
- `authority.would_deny` when none does.

EmDash roles still decide.

**Enforced mode.** Under Plugins → Powerfarm → Settings → *Authority: enforced capabilities*, list the capabilities to enforce, separated by commas, for example `idp.keys,idp.config,approve.profile`.

Listed capabilities are default-deny: the action needs the EmDash role **and** a published, current grant whose scope covers it. Before enforcing one, read the journal's `would_deny` entries for it.

Unknown capabilities are always refused.

## 4. Agents

An agent (CI, the release service, an AI client acting for someone) is an `agents` entity with:
- its own principal id;
- an owner, which is the responsible person.

An agent's grant:
- needs `delegated_by`, an active person who holds the same capability;
- is limited to 30 days;
- names its task.

An agent can hold only `mdm.command` today. AI clients still cannot publish, approve, attest or change settings, whatever they hold.

## 5. Powerfarm as Cloudflare Access's identity provider

### 5.1 In Powerfarm

1. As an Administrator in the EmDash admin, call `identity/oidc/rotate-key`. This needs `idp.keys` once that capability is enforced. It creates the RS256 signing key. Rotating again keeps the old key published until the next rotation.
2. Call `identity/oidc/client`:

   ```json
   { "client_id": "cloudflare-access",
     "redirect_uris": ["https://<team>.cloudflareaccess.com/cdn-cgi/access/callback"] }
   ```

   The client secret is shown **once**; Powerfarm keeps only its hash. Put the secret into Cloudflare and nowhere else.
3. Every person who should sign in through Access needs to be:
   - active;
   - linked to their EmDash user;
   - given a `contact_email`. Cloudflare requires an e-mail. Powerfarm never uses it as identity.

### 5.2 In Cloudflare Zero Trust → Settings → Authentication → Add new → OpenID Connect

| Field | Value |
| --- | --- |
| App ID | `cloudflare-access` |
| Client secret | from step 2 |
| Auth URL | `https://<host>/_emdash/api/plugins/powerfarm/oidc/authorize` |
| Token URL | `https://<host>/_emdash/api/plugins/powerfarm/oidc/token` |
| Certificate URL | `https://<host>/_emdash/api/plugins/powerfarm/oidc/jwks` |
| PKCE | on |
| OIDC claims | `email`, `groups` (and `name` if you like) |

The ID token contains:
- `sub`: the person's permanent `principal_id`;
- `email`;
- `name`;
- `groups`: only staff, engineering, operations, administrators and contractors, taken from the person record.

Grants are never put in tokens. Powerfarm decides authority itself, on every action.

### 5.3 Bypass, and nothing more, to avoid a sign-in loop

Powerfarm's host is behind Access, and Access now asks Powerfarm who you are. Add one Access application with a **Bypass** policy (Everyone) for exactly these paths on the Powerfarm host:

- `/_emdash/api/plugins/powerfarm/oidc/`: the provider's endpoints.
- `/oidc/continue`: the static page that finishes sign-in. It holds no logic. It posts to the private `oidc/continue` route with EmDash's CSRF header, and EmDash requires a session for that route.
- `/_emdash/admin/login`: EmDash's own sign-in page, with your passkey.
- `/_astro/`: the page's scripts and styles (static, public code).
- `/_emdash/api/auth/`: EmDash's sign-in endpoints (passkey options and verify, auth mode).

Everything else stays behind Access, including the rest of the admin, the API, MCP and `identity/whoami`.

What this means:
- The bypassed paths are reachable from the internet.
- EmDash's own sign-in protections are what guard them: passkeys, and its handling of invites and sign-up. Keep self sign-up off.

Prove the setup from outside after every change:

```sh
node scripts/edge-check.mjs --url https://<host> --oidc
```

**Keep a break-glass way in.** Leave a second login method on the Access application for administrators: a hardware-key-protected account with another IdP, or One-time PIN restricted to one address. If Powerfarm is down, Access cannot ask Powerfarm, so without one you are locked out.

EmDash itself must stay in **passkey** auth mode. If EmDash were configured to trust Access (`access()` auth), the two would each wait for the other.

### 5.4 Free Zone services: `identity/whoami-access`

A service behind its own Access application forwards the `Cf-Access-Jwt-Assertion` it received to `GET /_emdash/api/plugins/powerfarm/identity/whoami-access`. Its call passes Powerfarm's Access with a service token allowed on that path only. Powerfarm then:
- verifies the assertion against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, checking the issuer, one of the configured audiences, expiry and signature;
- maps it to the principal Powerfarm itself issued a token for (`oidc:issued:<email>`);
- answers with the principal id, groups and current grants.

An assertion from a break-glass login or another IdP is not a principal (404). Allow only the Powerfarm IdP on applications that rely on this.

Settings:
- *Cloudflare Access: team domain*;
- *application audiences* (AUD tags).

### 5.5 Access logs

Set the following:
- *Cloudflare: account ID*;
- an API token that can only read Access audit logs.

The hourly `access-logs` task turns each of these into an incident:
- a refused sign-in (`access_refused`);
- a person's first sign-in from a country not seen before for them (`access_new_country`).

Confirm new countries with the person through another channel.

## 6. Suspension

Set a person or agent's lifecycle to `suspended` (or `retired`) and publish. Powerfarm then, at once:
- unpublishes every grant they hold or delegated;
- makes `authorize()` deny them;
- refuses new OIDC sign-ins and token exchanges for them;
- raises a `principal_suspended` incident (high);
- opens published work items for what only a person can do in EmDash and Cloudflare:
  - disable the EmDash user and revoke its API tokens;
  - revoke Access sessions and service tokens;
  - review the devices they had.

An Access session that already exists lasts until its own expiry. Revoking it in Cloudflare is one of the work items.

## 7. Release gate

1. **CI** (CI client id and secret) runs `scripts/release.mjs draft`. That drafts a release with:
   - the repository, the commit and the artifact's SHA-256;
   - the test results (failing tests are refused);
   - `author_principal` (the CI agent).
2. **A person** who is not the author and holds `release.production` (scope `releases:production`) publishes the draft. That publish is the approval, and the record is sealed.
3. **The release service** (its own id and secret) runs `scripts/release.mjs deploy … -- <deploy command>`, which:
   - hashes the artifact;
   - gets a 15-minute, single-use authorisation for exactly that commit and digest;
   - runs the command without a shell;
   - reports the outcome.

   A different artifact, an unapproved version or a reused authorisation is refused.

Settings:
- *Release: CI client ID / signing secret / agent*;
- *Release service client ID / signing secret / agent*.

Use two different secrets. Give each machine a Cloudflare Access service token allowed only on `/_emdash/api/plugins/powerfarm/release/`.

## 8. Record seals

These collections are sealed when published:
- policies, grants, decisions, procedures, releases, MDM profiles and requirements.

A seal is a SHA-256 over the record's fields, relations and revision, written to the journal. `beforePublish` leaves a seal-pending marker, `afterPublish` seals, and the `seals` task finishes anything a publish left pending. `records/seal` (`{collection, ref}`) answers one of:
- `intact`;
- `changed`: the current published form differs from what was sealed;
- `unsealed`;
- `not_published`.

Backups record the head of every journal stream. `restore.mjs` refuses a backup whose journal does not reach those heads.

## Rules that matter most against an attacker who keeps coming back

- Use phishing-resistant sign-in (hardware keys or passkeys) everywhere a person signs in: Apple Account, e-mail, Cloudflare, the domain registrar, EmDash.
- The keys that would let someone impersonate or command the fleet stay on a Mac a person controls, never in the cloud: the device CA and the MDM push certificate. The exception today is the OIDC signing key, an encrypted EmDash secret setting in the Worker. Moving it to a separate signing Worker is a later step.
- Powerfarm cannot erase or lock devices; a person does that physically.
- Nothing is trusted because it says so. A device must sign with the certificate it enrolled with. A person signs in with their passkey. A release is deployed only with its approved digest.
- AI clients can read and draft. They cannot approve, publish, attest, grant, close incidents or change settings.

Guides: [MDM.md](MDM.md), [ENTITIES.md](ENTITIES.md), [DEPLOYMENT-CLOUDFLARE.md](DEPLOYMENT-CLOUDFLARE.md).

## Live checks still to do (none of this has run outside tests)

1. Run `edge-check --oidc` against the deployed host: the bypass is exact.
2. Do a real Cloudflare Access sign-in through Powerfarm:
   - confirm that Cloudflare accepts the token response. Powerfarm returns an opaque `access_token` and has no userinfo endpoint; Cloudflare's generic OIDC is expected to read the ID token claims, and this must be confirmed;
   - confirm that `groups` arrive in Access policies;
   - confirm that a suspended person is refused.
3. Run the break-glass login while Powerfarm is unreachable.
4. Call `identity/whoami-access` from a real Free Zone service.
5. Run the `access-logs` task against the real Access audit log API: check the field names and that the `since` paging matches.
6. Do one release through CI → approval → release service.
7. Run the EmDash build (`astro build`) with the new site page and routes.
