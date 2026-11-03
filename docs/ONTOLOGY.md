# Powerfarm Graph ontology

> 1.2 added real sources for `service` and new types for entities and automation.
> The design and rationale are in [ONTOLOGY-V1.2.md](ONTOLOGY-V1.2.md); this page
> is the reference.

Source of truth: `plugin/src/ontology.ts`. The graph is not stored separately; it
is computed from EmDash content, native relations, draft revisions and the
1.1 plugin storage (jobs, bridges, journal) on each request (with a cache invalidated on every content change).

## Node identity

`<collection>:<translation_group>` for EmDash content (stable across locales and
revisions), `job:<opId>:<revisionId>`, `lease:<jobId>`, `bridge:<bridgeId>`,
`journal:<eventId>` and `reconciliation:<id>`. 1.2 adds no storage nodes:
identifiers, work items and blueprints are content like everything else. Business keys (`LAB-8GB`, `OP-0007`,
`P-VERIFY`, `ADR-0003`, `M001`) resolve to node ids.

## Node types

| Domain | Type | Source | Visible to |
| --- | --- | --- | --- |
| institution | person, project, mission | collections `people`, `projects`, `missions` | Subscriber+ |
| institution | organization, team | planned | — |
| infrastructure | asset | `assets` (serial_number, ecid masked) | Subscriber+ |
| infrastructure | service | `services` (the canonical catalogue) | Subscriber+ and classification |
| infrastructure | service_instance | `service_instances` (endpoint masked; secret references for administrators only) | Subscriber+ and classification |
| infrastructure | vm, network, storage | planned | — |
| enterprise | client, product | `clients`, `products` | Subscriber+ and classification |
| enterprise | contract | `contracts` (document never returned) | Editor+ and classification |
| enterprise | identifier | `identifiers` (one entry per `namespace:value`, a unique field; value masked) | Editor+, and only if its subject is visible |
| automation | blueprint, exception | `blueprints`, `exceptions` | Editor+ |
| automation | work_item | `work_items` | Editor+ (titles name their subject) |
| engineering | software, requirement, decision, test, release | collections | Subscriber+ |
| engineering | repository, deployment | planned | — |
| operations | procedure | `procedures` | Subscriber+ |
| operations | operation, event, evidence | `recovery_operations`, `events`, `evidence` | Editor+ |
| operations | job, lease | plugin storage `jobs` | Editor+ |
| operations | bridge | plugin storage `bridges` | Editor+ |
| operations | journal_event | plugin storage `journal` | Editor+ |
| operations | reconciliation | plugin storage `reconciliations` | Editor+ |
| ai | model, agent, tool, mcp_capability, skill, evaluation | planned | — |
| research | research | `research` | Subscriber+ |
| research | hypothesis, experiment, dataset, source_doc, publication, concept | planned | — |

*Planned* types are declared so queries and UIs are stable, but have no records
until a collection or storage source is added (see FUTURE-DOMAINS in
[PUBLICATION.md](PUBLICATION.md)).

## Edges

**Native relations** (EmDash `_emdash_content_references`, parent → child):
`scopes` (mission→asset), `uses_procedure`, `part_of_programme`, `runs`
(asset→software), `requires_tool`, `studies`, `informs`, `custodian_of`,
`has_requirement`, `decided_by`, `governs`, `verifies`, `tests`, `releases`,
`passed`, `builds`, `responsible_for`.

**1.2 native relations**: `owns` (person→entity), `assigned` (person→work item),
`subscribes_to` (client→product), `sponsors` (client→project), `party_to`
(client→contract), `uses_service` (product or project→service),
`implemented_by` (service→software), `has_instance` (service→instance),
`runs_on` (instance→asset), `uses_instance` (project→instance), `covers`
(contract→product/service).

**1.2 subject links** (`<collection>:<KEY>` fields): `concerns` (work item→entity),
`waives` (exception→entity), `evidence_for` (evidence→entity), `identifies`
(identifier→entity). **1.2 link fields**: `uses_template` (work item→blueprint,
from `blueprint_code`), `merged_into` (entity→surviving entity). An onboarding
run is not a node: it is the set of work items sharing a `run_id`.

**Derived from link fields**: `targets` (operation→asset), `follows`
(operation→procedure), `part_of` (operation→mission), `relies_on_backup`
(operation→backup operation), `about` (event→asset/operation), `evidence_for`
(evidence→asset/operation).

**Derived from plugin storage**: `executes` (job→operation), `acts_on`
(job→asset), `claimed_by` (job→bridge), `holds_lease` (job→lease), `recorded`
(journal event→asset/operation/job), `reconciles`, `produced` (job→evidence).

## Edge and node states

- `published` — live content and live relations.
- `draft` — the node has unpublished changes (Editor+ with `includeDrafts`).
- `proposed` — a relation staged in a draft revision's `_references`, not yet live.
- `historical` — finished jobs, superseded jobs, old journal entries.

## Access rules

- 1.2 entities carry a classification: public/internal → Contributor+,
  confidential → Editor+, restricted → Administrator. Bearer-token callers
  (API tokens, MCP) are capped at the *tokenMaxClassification* setting
  (default internal) and never get unmasked identifiers or secret locations.
  Hidden nodes are not found at all, not merely left out of lists. Records
  without a classification (all 1.1 collections) follow the rules below.

- Default view is published only. `includeDrafts` requires Editor (40).
- Types below the caller's role are dropped from results and from neighbour lists
  (cache is per view, filtering is per request — there is a regression test).
- `serial_number`, `ecid`, `media_id`, `leaseId` are masked (`••••1234`) unless
  an Administrator passes `revealIdentifiers`. Fields named like secret/token are
  always removed.
- Evidence file contents are never returned by the graph; only metadata and digests.

## Bounds

Neighbours: ≤ 200 per page, opaque cursor. Trace: depth ≤ 4, ≤ 300 nodes,
`truncated` flag. Search: ≤ 50 results, exact keys first, then FTS5.

## GraphRAG

`search_knowledge` returns a context package: matched entities (exact keys, then
FTS5 snippets), each with its permitted fields, a bounded one-hop neighbourhood
with edge labels and states, and the EmDash admin URL of the source record, so
any statement can be traced back. `graph_get_provenance` adds the revision list,
author, live revision, evidence and journal for one entity. It never includes drafts unless
an Editor asks, and never includes evidence bytes.
