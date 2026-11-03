# Entities, identity and onboarding (1.2) — operator guide

Clients, products, services, service instances and contracts are EmDash content
with one shared contract (docs/ONTOLOGY-V1.2.md). This guide is how to use them.

## Register something

Everything happens in EmDash's own editor (Content → Clients, Products, Services,
Service instances, Contracts → New).

1. Fill in the record. The **Identifiers** field is a Powerfarm field widget: as
   you type, it shows whether each identifier is free or which record already
   holds it. **Secret references** on service instances is a widget too, and warns
   when a value looks like a secret instead of a location.
2. Save the draft. The **Powerfarm · Identity, controls and onboarding** panel in
   the editor sidebar lists possible duplicates (same identifier, code or name),
   the controls still missing, and — for an unpublished record — what publishing
   will start (a simulation of each active blueprint; nothing is written).
3. **Publish**. That is the registration. Codes are allocated if you left them
   empty (`CL-0001`, `PR-…`, `SV-…`, `SI-…`, `CT-…`). Lists show code, lifecycle and
   classification as ordinary EmDash list columns, plus a Powerfarm *Controls*
   column.

AI clients can only *propose*: `powerfarm__propose_entity` creates an unpublished
intake draft marked “prepared by an AI client”. Owners, relations, lifecycle,
classification, identifiers and credentials are set by people.

## Lifecycle

`intake` → `active` ↔ `suspended` → `retired` (final). You change it by editing
the record and publishing. The publish is refused, with the list of what is
missing, unless the stage's controls are met:

| Type | To activate (publish with lifecycle `active`) |
| --- | --- |
| Client | owner · at least one identifier · identity verified · classification reviewed · access reviewed (confidential and restricted) · review cadence + maintenance plan |
| Product | owner · classification reviewed · security baseline · review cadence + maintenance plan |
| Service | owner · classification reviewed · security baseline · review cadence + maintenance plan |
| Service instance | owner · its catalogue service · credentials only as references · security baseline · access reviewed · review cadence + maintenance plan |
| Contract | owner · client · classification reviewed · effective date and end/renewal date · signed copy attested by an administrator |

Retiring needs an administrator, a `retirement_approved` attestation, and nothing
active depending on it (a service with active instances, products or contracts
cannot be retired; a client with active contracts cannot).

An **active record keeps its controls**: publishing an ordinary edit that would
take one away (dropping the owner, removing the verified identifier, the
service link of an instance) is refused and names what would be lost. Keep it,
or suspend the record first. Controls that were already missing (an attestation
that expired) do not block unrelated edits.

**Records leave by retirement.** A published record cannot be deleted, and a
record that was ever published cannot be deleted after an unpublish either.
Active and suspended records cannot be unpublished; an administrator may
withdraw an *intake* registration made by mistake (the identity task releases its
identifiers at its next run, within 15 minutes), and it stays as history.

While active, the panel shows **operation** health: the last review within the
cadence; for contracts, renewal and end dates not passed. These do not block
anything; they show what is overdue.

Who may publish: EmDash's publish permission, plus — contracts and restricted
records need an administrator to activate; only administrators publish
restricted records or lower a classification; with *Require a second person*
on, the author of a record cannot activate it.

## Meeting controls: attestations

Controls are met by **Evidence** entries (Content → Evidence → New) of type
*attestation* with **Subject** set to the record (`clients:CL-0001`):

| Attests | Meets | Who may record it | Valid for |
| --- | --- | --- | --- |
| `identity_verified` (set **Identifier**, e.g. `vat:PT123456789`) | identity verified; marks that identifier *attested* (*verified* with a file attached) | editor | — |
| `classification_reviewed` | classification reviewed | editor | 365 days |
| `access_reviewed` | access reviewed | administrator | 180 days |
| `security_baseline_reviewed` | security baseline | editor | 365 days |
| `maintenance_plan` | maintenance plan (needs *Review every (days)*) | editor | — |
| `maintenance_review` | review current (operation) | editor | the cadence |
| `contract_signed` (attach the signed copy) | signed copy; the server hashes the file | administrator | — |
| `retirement_approved` | retirement approved | administrator | — |

The person who saves the attestation is recorded as its signer. AI clients cannot
record evidence. Evidence cannot be edited or deleted.

## Security exceptions

When a control cannot be met yet: Content → **Security exceptions** → New:
subject, the control, rationale and compensating measures, expiry (at most a
year). An administrator publishes it (that is the risk acceptance; with *Require
a second person* on, not its author). While unexpired it shows the control as
*waived*. Expired exceptions are listed in red on the record. Owner, service
link, secrets, dates, signed copy, classification review, retirement approval and
active dependants cannot be waived.

## Identifiers

Namespaces: `vat`, `lei`, `duns`, `company_reg` (`PT:123456`), `domain`,
`email_domain`, `github`, or `ext:<issuer>` for anything else. Values are
normalised (`pt 123.456.789` → `PT123456789`, `https://Acme.com/` → `acme.com`).

The registry is the **Identifiers** collection (Content → Identifiers): one entry
per identifier, whose `namespace:value` is a unique field, so EmDash's database
guarantees an identifier belongs to one record across all types, also when two
people publish at the same moment. Entries are created when a person publishes a
record that lists them, and released when a published record drops them (the
entry is renamed `released/…` and keeps its revision history; the value is free
again).

- **Transfer** (administrators): open the identifier's entry, change *Identifies*
  to the other record and give a *Rationale* (20+ characters). EmDash keeps the
  revision; the audit log records who. The old record can no longer publish it
  until it is removed from that record; the receiving record keeps it.
- **Merge** (administrators): on the duplicate, set *Merged into* to the
  surviving record's code, *Why it was merged*, and *Lifecycle* `retired`, then
  publish. The publish is refused while other records still link to the
  duplicate (a contract it is party to, a product using it, open work about it):
  the message lists them; re-point each at the survivor in the editor, then
  publish again. Closed work and evidence keep naming the duplicate — that is what
  happened. Its identifiers move to the survivor with the rationale. The merge
  stands in for the retirement approval; other retirement controls still apply.

People cannot create or delete registry entries; AI clients cannot change them.
Mission 001 serials and ECIDs are mirrored as read-only entries (`assets:<TAG>`).

## Credentials

Never in a record. Saves are refused if any field looks like a key, token,
password or URL with an embedded password. Service instances list **Secret
references**: `{"name": "db", "store": "vault", "reference": "kv/powerfarm/db"}`
— where it is, not what it is. Stores: `emdash_setting`, `password_manager`,
`vault`, `host_file`. Only administrators in a browser session see the
references; everyone else sees how many there are.

## Classification

| Classification | Who sees it on Powerfarm surfaces |
| --- | --- |
| public, internal | contributors and above |
| confidential | editors and above |
| restricted | administrators |

API tokens and AI clients (MCP) see at most `internal` unless an administrator
changes *Highest classification API tokens and AI clients may read*. Contract
documents are never returned by the graph, search or MCP.

**Limitation:** this is enforced by Powerfarm (graph, search, panels, routes,
MCP tools). EmDash's own content list and REST API do not know about
classification: an editor can open a restricted record in Content. Give AI
tokens only the `mcp:tools:powerfarm` scope so EmDash's own MCP content tools are
not available to them.

## Blueprints (onboarding)

Content → **Blueprints**. A blueprint applies to one type and runs when a record
of that type is **registered** (first publish) or **activated**. An
administrator publishes it to activate that exact revision. A run keeps the
revision and steps it started with. The seeded *Client onboarding* blueprint is a
draft until you publish it.

Steps (JSON) use a fixed catalogue. A run reads them from the blueprint revision
EmDash stored when it was published:

| Action | Does | Options |
| --- | --- | --- |
| `create_task` | a work item | `title`, `description`, `pillar`, `assignee: "$subject.owner"`, `dueInDays`, `wait` |
| `request_link` | a work item asking a person to link records in the editor | same as create_task |
| `request_approval` | an approval work item; the run waits | `title`, `description`, `requiredRole` 40/50, `separateFromInitiator` |
| `create_record` | a **draft** contract or service instance, linked by native relations | `collection`, `fields` (allowlisted), `references` with `$subject` / `$subject.<field>` |
| `wait_for_control` | a control-check work item that closes when the control is met | `control`, `timeoutDays` |
| `record_provenance` | a note work item | `title`, `description` |

Every step may have `id`, `dependsOn` (earlier steps), `when` (`{"field":
"classification", "in": [...]}` or `{"reference": "owner", "empty": true}`) and
`retries` (0–3). Text may use `{{subject.title}}`, `{{subject.key}}`,
`{{subject.ref}}`, `{{subject.classification}}`, `{{subject.collection}}` and
nothing else. There is no way to run code, call URLs, send e-mail or provision
anything; a blueprint that tries does not save.

Created records are never more permissive than the subject (classification),
always `intake`, and always drafts; the runner cannot publish a client, product,
service, instance or contract.

## Onboarding work, in the editor

A run's state is its work items (Content → **Work items**, filtered by subject or
blueprint): there is no separate run database. The record's panel shows each run
with every step; the dashboard has *Open work and approvals*.

- **Tasks and link requests**: set *Status* to done (or cancelled).
- **Approvals**: set *Decision* to `approve` and *Status* to done, or `reject` and
  rejected, with a *Resolution note*. The save is refused unless you have the role
  shown, and — if the item says *Initiator may not resolve*, or *Require a second
  person* is on — unless you are not the person who registered the record.
- **Control checks** close by themselves when the control is met (record the
  attestation); they cannot be closed by hand.
- **Needs attention** (a step that could not be completed): an administrator sets
  *Decision* to `retry` (after fixing the cause), `done_by_hand`, or `give_up`, with
  a note, and *Status* done. Giving up fails the step and blocks the steps that
  depend on it; the run shows *partially failed*.
- **Notes** record skipped steps and provenance; they cannot be changed.

The `blueprints` scheduled task re-checks open runs every minute; saving a work
item, evidence or the record re-checks that record's runs at once.
