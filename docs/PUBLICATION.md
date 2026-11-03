# Publication and future domains

## During Mission 001: one internal instance

There is exactly one EmDash instance, on the private network, with one SQLite
database in `POWERFARM_DATA_DIR`. The v1 `site-public` instance was removed: two
instances meant two databases, two admin surfaces and two backups for no
Mission 001 benefit.

The root page (`site/src/pages/index.astro`) is `noindex` and only links into the
admin. Media files require authentication (patch 0001 with
`EMDASH_PRIVATE_MEDIA=1`).

## Later: a public site through an explicit allowlist

When Powerfarm wants to publish research, do it as a separate, deliberate step:

1. A separate EmDash instance (own database, no Powerfarm plugin, no bridge
   routes, no MCP write scopes) on a different host.
2. Content reaches it only by export of **published** items from an allowlist
   of collections — `research`, `releases`, selected `projects`, and 1.2
   entities classified `public` — never `assets`, `recovery_operations`,
   `events`, `evidence`, `people`, `contracts`, `work_items`, `exceptions`.
3. The export strips link fields that point into operational collections and
   any field marked sensitive in the ontology.
4. A person reviews each export batch; nothing syncs automatically.

This is design only; nothing in 1.2 implements the export.

## Future domains

The ontology already declares the types, so the graph API and admin views will
not change shape when they gain records.

| Domain | Types | How to add |
| --- | --- | --- |
| Institution | organization, team | New collections `organizations`, `teams`; relations to `people` and `projects`. A client is a role; when organisations exist, a client references one. |
| Infrastructure | vm, network, storage | Collections related to `assets` (host) and `service_instances` (`runs_on` today points at assets). The EmDash VM itself becomes the first `vm` record. *Service* and *service instance* became real in 1.2. |
| Engineering | repository, deployment | Collections; `deployment` links release → vm/service. |
| AI | model, agent, tool, mcp_capability, skill, evaluation | Collections. `mcp_capability` records describe what each MCP token may do, for review (never used to grant permissions). |
| Research | hypothesis, experiment, dataset, source_doc, publication, concept | Collections linked to `research`; datasets reference media. |

For each: add the collection and relations to `site/seed/build_seed.py`, set the
type's `source` in `plugin/src/ontology.ts`, add `RELATION_EDGES` entries, add
tests in `plugin/test/graph.test.ts`. Operational domains must set `minRole` to
Editor and list sensitive fields.
