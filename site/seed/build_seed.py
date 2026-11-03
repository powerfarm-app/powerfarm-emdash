#!/usr/bin/env python3
"""Generate site/seed/seed.json (Powerfarm content model v1.2) and the 1.1 -> 1.2
migration seed site/seed/migrations/1.2.0.json.

The JSON file is what EmDash reads; this script is how it is written, so the
model can be reviewed as code. Run: python3 site/seed/build_seed.py

Rules followed here:
- Fleet names are exactly as given. No serial numbers, ECIDs, model identifiers
  or OS versions are invented; only facts supplied by Powerfarm are recorded.
- Asset trust and recovery state are not fields: they are derived by the plugin.
- Reference fields are set from the parent side only, and referenced entries
  come first in `content` (EmDash's seed applier resolves $ref in order).
- 1.2 entities (clients, products, services, service instances, contracts) share
  one entity contract. No clients, products or contracts are seeded: none were
  supplied, and invented ones would be misleading. The onboarding blueprint is
  seeded as a draft for an administrator to review and publish.
"""
import json
import pathlib

OUT = pathlib.Path(__file__).with_name("seed.json")

DEVICE_CLASSES = ["mac_apple_silicon", "mac_intel", "iphone", "ipad"]
OPERATIONS = [
    "none",
    "inventory", "verify", "backup", "restore", "install_profile",
    "mac_inventory_manual", "mac_recovery_reinstall", "mac_dfu_revive", "mac_dfu_restore", "mac_verify_manual",
    "backup_manual", "security_baseline",
]
EVIDENCE_KINDS = ["inventory_report", "verification_report", "backup_manifest", "restore_log", "install_log", "log", "attestation"]
ATTESTS = ["account_security", "activation_lock", "management_enrollment", "setup_review", "host_bootstrap", "trust_signoff"]
# 1.2: attestations that satisfy entity controls (plugin/src/entities.ts CONTROL_ATTESTATIONS).
CONTROL_ATTESTS = ["identity_verified", "classification_reviewed", "access_reviewed", "security_baseline_reviewed", "maintenance_plan",
                   "maintenance_review", "contract_signed", "retirement_approved"]
LIFECYCLE = ["intake", "active", "suspended", "retired"]
CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"]
CONTROLS = ["owner_assigned", "identity_recorded", "identity_verified", "classification_reviewed", "access_reviewed",
            "security_baseline", "maintenance_plan", "service_linked", "secrets_referenced", "counterparty_linked",
            "dates_recorded", "contract_signed", "review_current", "renewal_not_due", "retirement_approved", "no_active_dependants"]
ENTITY_COLLECTIONS = ["clients", "products", "services", "service_instances", "contracts"]


def f(slug, label, type_, **kw):
    d = {"slug": slug, "label": label, "type": type_}
    d.update(kw)
    return d


def sel(slug, label, options, **kw):
    return f(slug, label, "select", validation={"options": options}, **kw)


def msel(slug, label, options, **kw):
    return f(slug, label, "multiSelect", validation={"options": options}, **kw)


def ref(slug, label, relation, side, multiple=True, **kw):
    return f(slug, label, "reference", validation={"relation": relation, "relationSide": side, "multiple": multiple}, **kw)


def pt(*paragraphs):
    return [{"_type": "block", "style": "normal", "children": [{"_type": "span", "text": t}]} for t in paragraphs]


def key(slug, label):
    return f(slug, label, "string", required=True, unique=True, indexed=True, searchable=True)


G = "Powerfarm"
ENG = "Engineering"
ENT = "Entities"
AUTO = "Automation"
IDN = "Identity"
CAPABILITIES = ["authority.grant", "identity.admin", "idp.keys", "idp.config", "policy.publish", "approve.destructive", "approve.profile", "mdm.command", "release.production"]
SEC = "Security"


def entity_fields(key_label, owner_relation, default_classification="internal", owner_label="Accountable owner"):
    """The entity contract (docs/ONTOLOGY-V1.2.md section 3; 1.4 adds principal_id)."""
    return [
        f("title", "Name", "string", required=True, searchable=True),
        f("code", key_label, "string", unique=True, indexed=True, searchable=True),
        f("principal_id", "Permanent Powerfarm id (set by Powerfarm)", "string", unique=True, indexed=True),
        sel("lifecycle", "Lifecycle", LIFECYCLE, required=True, indexed=True, defaultValue="intake"),
        sel("classification", "Classification", CLASSIFICATIONS, required=True, indexed=True, defaultValue=default_classification),
        ref("owner", owner_label, owner_relation, "child", multiple=False),
        f("identifiers", "Identifiers", "json", widget="powerfarm:identifiers"),
        f("review_cadence_days", "Review every (days)", "integer"),
        f("description", "Description", "text", searchable=True),
        f("merged_into", "Merged into (code of the surviving record)", "string", indexed=True),
        f("merge_rationale", "Why it was merged", "text"),
        f("origin", "Created by blueprint step", "string", unique=True, indexed=True),
        f("prepared_by_ai", "Prepared by an AI client", "boolean"),
    ]

collections = [
    {"slug": "missions", "label": "Missions", "labelSingular": "Mission", "group": G, "sortOrder": 1, "supports": ["revisions", "search"], "routable": False, "fields": [
        f("title", "Title", "string", required=True, searchable=True), key("code", "Mission code"),
        sel("mission_status", "Status", ["planned", "active", "complete", "suspended"]),
        f("objective", "Objective", "text", searchable=True), f("acceptance", "Acceptance criteria", "text", searchable=True),
        f("body", "Plan", "portableText", searchable=True),
        ref("assets", "Assets in scope", "missions_assets", "parent"), ref("procedures", "Procedures", "missions_procedures", "parent"),
        ref("projects", "Projects", "missions_projects", "parent"),
    ]},
    {"slug": "assets", "label": "Assets", "labelSingular": "Asset", "group": G, "sortOrder": 2, "supports": ["revisions", "search"], "routable": False,
     "description": "Devices. Status (identified, verified, trusted…) is derived by Powerfarm from jobs and evidence and cannot be edited.", "fields": [
        f("title", "Name", "string", required=True, searchable=True), key("asset_tag", "Asset tag"),
        sel("device_class", "Device class", DEVICE_CLASSES, required=True, indexed=True),
        sel("role", "Role", ["comms_terminal", "trusted_host", "fleet"], required=True, indexed=True),
        f("model", "Model", "string", searchable=True), f("model_year", "Model year", "string"),
        sel("chip", "Chip", ["apple_silicon", "intel", "a_series"]), f("color", "Colour", "string"),
        f("os_at_intake", "OS at intake (as reported)", "string"),
        f("os_policy", "OS acceptance policy", "string"),
        f("serial_number", "Serial number (from verified inventory)", "string", indexed=True),
        f("ecid", "ECID (from verified inventory)", "string", indexed=True),
        f("notes", "Notes", "portableText", searchable=True),
        ref("software", "Installed software", "assets_software", "parent"), ref("custodians", "Custodians", "people_assets", "child"),
        ref("missions", "Missions", "missions_assets", "child"),
    ]},
    {"slug": "procedures", "label": "Procedures", "labelSingular": "Procedure", "group": G, "sortOrder": 3, "supports": ["revisions", "search"], "routable": False, "fields": [
        f("title", "Title", "string", required=True, searchable=True), key("code", "Procedure code"),
        sel("operation", "Operation", OPERATIONS, required=True),
        msel("device_classes", "Device classes", DEVICE_CLASSES),
        f("preconditions", "Preconditions", "text", searchable=True), f("required_tools", "Required tools", "text"),
        f("physical_steps", "Operator actions", "text", searchable=True), f("expected_results", "Expected results", "text"),
        msel("required_evidence", "Required evidence", EVIDENCE_KINDS + ATTESTS),
        f("failure_instructions", "If it fails", "text", searchable=True),
        f("steps", "Procedure", "portableText", searchable=True), f("procedure_version", "Version", "string"),
        ref("software", "Uses software", "procedures_software", "parent"),
    ]},
    {"slug": "recovery_operations", "label": "Recovery operations", "labelSingular": "Recovery operation", "group": G, "sortOrder": 4,
     "description": "One proposed operation on one device. Publishing it is the approval.", "supports": ["drafts", "revisions", "search"], "routable": False, "fields": [
        f("title", "Title", "string", required=True, searchable=True),
        f("op_code", "Operation code", "string", unique=True, indexed=True, searchable=True),
        f("asset_tag", "Asset tag", "string", required=True, indexed=True),
        f("procedure_code", "Procedure code", "string", required=True, indexed=True),
        f("mission_code", "Mission code", "string", required=True, indexed=True, defaultValue="M001"),
        sel("operation", "Operation", OPERATIONS, required=True), f("parameters", "Parameters", "json"),
        f("dry_run", "Dry run only", "boolean", defaultValue=True),
        sel("data_decision", "Data-preservation decision", ["backup_verified", "backup_waived", "no_user_data", "blocked"]),
        f("backup_op_code", "Backup operation", "string", indexed=True),
        sel("risk", "Risk", ["low", "medium", "high", "destructive"]),
        f("rationale", "Rationale", "text", searchable=True), f("physical_checklist", "Operator checklist", "text"),
        f("prepared_by_ai", "Prepared by an AI client", "boolean"),
    ]},
    {"slug": "events", "label": "Events", "labelSingular": "Event", "group": G, "sortOrder": 5, "editLocking": False, "dateField": "occurred_at",
     "description": "Searchable copy of the operational journal. Written only by Powerfarm.", "supports": ["search"], "routable": False, "fields": [
        f("title", "Title", "string", required=True, searchable=True), f("event_type", "Event type", "string", required=True, indexed=True),
        f("occurred_at", "Occurred at", "datetime", required=True, indexed=True), f("stream", "Stream", "string", indexed=True),
        f("sequence", "Sequence", "integer"), f("journal_id", "Journal id", "string", unique=True, indexed=True), f("entry_hash", "Entry hash", "string"),
        f("asset_tag", "Asset tag", "string", indexed=True), f("op_code", "Operation code", "string", indexed=True), f("job_id", "Job", "string", indexed=True),
        f("actor", "Actor", "string"), f("source", "Source", "string"), f("detail", "Detail", "text", searchable=True), f("payload", "Payload", "json"),
    ]},
    {"slug": "evidence", "label": "Evidence", "labelSingular": "Evidence item", "group": G, "sortOrder": 6, "dateField": "captured_at",
     "description": "Append-only. Files are hashed by the server.", "supports": ["search"], "routable": False, "fields": [
        f("title", "Title", "string", required=True, searchable=True),
        sel("evidence_type", "Type", ["report", "manifest", "log", "photo", "screenshot", "attestation"], required=True, indexed=True),
        sel("attests", "Attests", ATTESTS + CONTROL_ATTESTS), f("artifact_kind", "Artifact kind", "string"),
        f("asset_tag", "Asset tag", "string", indexed=True), f("op_code", "Operation code", "string", indexed=True),
        f("subject", "Subject (collection:KEY)", "string", indexed=True), f("identifier", "Identifier attested (namespace:value)", "string"),
        f("job_id", "Job", "string", indexed=True), f("op_revision", "Approved revision", "string"),
        f("captured_at", "Captured at", "datetime"), f("file", "File", "file"), f("media_id", "Media id", "string", indexed=True),
        f("sha256", "SHA-256", "string"), f("size_bytes", "Size (bytes)", "integer"), f("original_filename", "Original filename", "string"),
        f("mime_type", "Type", "string"), sel("digest_status", "Digest", ["server_verified", "unverified", "none", "mismatch"]),
        f("execution_mode", "Execution mode", "string"), f("signed_by", "Signed by", "string"),
        f("description", "Description", "text", searchable=True),
    ]},
    {"slug": "software", "label": "Software", "labelSingular": "Software", "group": ENG, "sortOrder": 10, "supports": ["revisions", "search"], "routable": False, "fields": [
        f("title", "Name", "string", required=True, searchable=True),
        sel("software_kind", "Kind", ["os", "firmware", "app", "tool", "profile", "component", "service"]),
        f("vendor", "Vendor", "string"), f("software_version", "Version", "string"), f("source_revision", "Source revision", "string"),
        f("sha256", "SHA-256", "string"), f("source_url", "Source", "url"), f("notes", "Notes", "text", searchable=True),
        ref("installed_on", "Installed on", "assets_software", "child"), ref("used_by", "Used by procedures", "procedures_software", "child"),
    ]},
    {"slug": "projects", "label": "Projects", "labelSingular": "Project", "group": ENG, "sortOrder": 11, "supports": ["revisions", "search"], "routable": False, "fields": [
        f("title", "Title", "string", required=True, searchable=True), key("code", "Project code"),
        sel("project_status", "Status", ["proposed", "active", "paused", "done"]), f("summary", "Summary", "text", searchable=True),
        f("body", "Description", "portableText", searchable=True),
        ref("requirements", "Requirements", "projects_requirements", "parent"), ref("software", "Builds", "projects_software", "parent"),
    ]},
    {"slug": "requirements", "label": "Requirements", "labelSingular": "Requirement", "group": ENG, "sortOrder": 12, "supports": ["revisions", "search"], "routable": False, "fields": [
        f("title", "Title", "string", required=True, searchable=True), key("code", "Requirement code"),
        f("statement", "Statement", "text", searchable=True), sel("priority", "Priority", ["must", "should", "could"]),
        sel("requirement_status", "Status", ["proposed", "accepted", "met", "dropped"]),
        ref("decisions", "Decided by", "requirements_decisions", "parent"),
    ]},
    {"slug": "decisions", "label": "Architecture decisions", "labelSingular": "Architecture decision", "group": ENG, "sortOrder": 13, "supports": ["revisions", "search"], "routable": False, "fields": [
        f("title", "Title", "string", required=True, searchable=True), key("code", "Decision code"),
        sel("decision_status", "Status", ["proposed", "accepted", "superseded"]),
        f("context", "Context", "text", searchable=True), f("decision", "Decision", "text", searchable=True),
        f("alternatives", "Alternatives considered", "text", searchable=True), f("consequences", "Consequences", "text", searchable=True),
        ref("software", "Governs", "decisions_software", "parent"),
    ]},
    {"slug": "tests", "label": "Tests", "labelSingular": "Test", "group": ENG, "sortOrder": 14, "supports": ["revisions", "search"], "routable": False, "fields": [
        f("title", "Title", "string", required=True, searchable=True), key("code", "Test code"),
        sel("test_kind", "Kind", ["unit", "integration", "e2e", "hardware"]), f("command", "How to run", "text"),
        sel("last_result", "Last result", ["pass", "fail", "not_run"]), f("last_run_at", "Last run", "datetime"),
        f("source_revision", "Source revision", "string"), f("result_summary", "Result", "text", searchable=True),
        ref("requirements", "Verifies", "tests_requirements", "parent"), ref("software", "Tests", "tests_software", "parent"),
    ]},
    {"slug": "releases", "label": "Releases", "labelSingular": "Release", "group": ENG, "sortOrder": 15, "supports": ["drafts", "revisions", "search"], "routable": False,
     "description": "A release is drafted by CI and approved by publishing: by someone holding release.production who is not its author. Only an approved release can be deployed.", "fields": [
        f("title", "Title", "string", required=True, searchable=True), key("code", "Version"),
        f("released_at", "Released", "datetime"), f("source_revision", "Source revision", "string"),
        f("repository", "Repository", "string"), f("artifact_digest", "Artifact digest (sha256:…)", "string"),
        sel("environment", "Environment", ["production", "staging"]),
        f("test_summary", "Tests", "text"), f("author_principal", "Author (agents:AG-… or people:PE-…)", "string"),
        f("deployed_at", "Deployed", "datetime"), f("deployed_version", "Deployed version reported", "string"),
        f("origin", "Origin (set by Powerfarm)", "string", unique=True, indexed=True),
        f("emdash_revision", "EmDash revision", "string"), f("notes", "Notes", "text", searchable=True),
        ref("software", "Releases", "releases_software", "parent"), ref("tests", "Tests passed", "releases_tests", "parent"),
    ]},
    {"slug": "research", "label": "Research", "labelSingular": "Research item", "group": "Research", "sortOrder": 20, "supports": ["drafts", "revisions", "search"], "routable": False, "fields": [
        f("title", "Title", "string", required=True, searchable=True), f("summary", "Summary", "text", searchable=True),
        f("body", "Body", "portableText", searchable=True), sel("research_status", "Status", ["idea", "active", "concluded"]),
        ref("assets", "Related assets", "research_assets", "parent"), ref("procedures", "Related procedures", "research_procedures", "parent"),
    ]},
    # ---- 1.2 entities -------------------------------------------------------------------
    {"slug": "clients", "admin": {"listColumns": ["code", "lifecycle", "classification", "client_kind"]}, "label": "Clients", "labelSingular": "Client", "group": ENT, "sortOrder": 40, "supports": ["drafts", "revisions", "search"], "routable": False,
     "description": "Organisations and people Powerfarm serves. Register in Powerfarm → Register; publishing is approval. Activation needs its controls met.", "fields": entity_fields("Client code", "people_clients") + [
        sel("client_kind", "Kind", ["organization", "individual"], required=True), f("legal_name", "Legal name", "string", searchable=True),
        f("country", "Country", "string"), f("website", "Website", "url"),
        ref("products", "Products", "clients_products", "parent"), ref("projects", "Sponsored projects", "clients_projects", "parent"),
        ref("contracts", "Contracts", "clients_contracts", "parent"),
    ]},
    {"slug": "products", "admin": {"listColumns": ["code", "lifecycle", "classification", "product_kind"]}, "label": "Products", "labelSingular": "Product", "group": ENT, "sortOrder": 41, "supports": ["drafts", "revisions", "search"], "routable": False, "fields": entity_fields("Product code", "people_products") + [
        sel("product_kind", "Kind", ["offering", "internal", "platform"]), f("summary", "Summary", "text", searchable=True),
        ref("services", "Uses services", "products_services", "parent"), ref("clients", "Clients", "clients_products", "child"),
    ]},
    {"slug": "services", "admin": {"listColumns": ["code", "lifecycle", "classification", "service_kind"]}, "label": "Services", "labelSingular": "Service", "group": ENT, "sortOrder": 42, "supports": ["drafts", "revisions", "search"], "routable": False,
     "description": "The canonical service catalogue. Register a service once; projects, products and contracts reference it. Deployments are service instances.", "fields": entity_fields("Service code", "people_services") + [
        sel("service_kind", "Kind", ["application", "data", "compute", "storage", "network", "identity", "messaging", "observability", "other"], required=True),
        f("summary", "Summary", "text", searchable=True), f("support_hours", "Support hours", "string"),
        ref("software", "Implemented by", "services_software", "parent"), ref("instances", "Instances", "services_instances", "parent"),
        ref("projects", "Used by projects", "projects_services", "child"), ref("products", "Used by products", "products_services", "child"),
    ]},
    {"slug": "service_instances", "admin": {"listColumns": ["code", "lifecycle", "environment", "classification"]}, "label": "Service instances", "labelSingular": "Service instance", "group": ENT, "sortOrder": 43, "supports": ["drafts", "revisions", "search"], "routable": False,
     "description": "One concrete deployment of a catalogue service. Credentials are never stored here: record where they live in Secret references.", "fields": entity_fields("Instance code", "people_service_instances") + [
        ref("service", "Service", "services_instances", "child", multiple=False, required=True),
        sel("environment", "Environment", ["production", "staging", "development", "test"], required=True, indexed=True),
        f("region", "Region or site", "string"), f("endpoint", "Endpoint", "string"),
        f("secret_refs", "Secret references", "json", widget="powerfarm:secret-refs"),
        ref("hosts", "Runs on", "service_instances_assets", "parent"), ref("projects", "Used by projects", "projects_service_instances", "child"),
    ]},
    {"slug": "contracts", "admin": {"listColumns": ["code", "lifecycle", "classification", "contract_kind"]}, "dateField": "end_date", "label": "Contracts", "labelSingular": "Contract", "group": ENT, "sortOrder": 44, "supports": ["drafts", "revisions", "search"], "routable": False,
     "description": "Agreement records. Confidential by default. Signing is a person's attestation with the signed copy attached; nothing signs automatically.", "fields": entity_fields("Contract code", "people_contracts", "confidential") + [
        sel("contract_kind", "Kind", ["msa", "sow", "sla", "nda", "license", "dpa", "other"]),
        f("effective_date", "Effective", "datetime"), f("end_date", "Ends", "datetime"), f("renewal_date", "Renewal or notice date", "datetime"),
        f("notice_days", "Notice period (days)", "integer"), f("document", "Document", "file"),
        ref("client", "Client", "clients_contracts", "child", multiple=False), ref("products", "Covers products", "contracts_products", "parent"),
        ref("services", "Covers services", "contracts_services", "parent"),
    ]},
    {"slug": "blueprints", "admin": {"listColumns": ["code", "target_collection", "trigger", "blueprint_version"]}, "label": "Blueprints", "labelSingular": "Blueprint", "group": AUTO, "sortOrder": 50, "supports": ["drafts", "revisions", "search"], "routable": False,
     "description": "Onboarding templates. Publishing (administrators only) activates that exact revision. Steps use a fixed action catalogue; nothing executes code.", "fields": [
        f("title", "Title", "string", required=True, searchable=True), key("code", "Blueprint code"),
        sel("target_collection", "Applies to", ENTITY_COLLECTIONS, required=True, indexed=True),
        sel("trigger", "Runs when", ["registered", "activated"], required=True, indexed=True),
        f("description", "Purpose", "text", searchable=True), f("steps", "Steps", "json", required=True),
        f("failure_procedure", "If a run fails", "text"), f("blueprint_version", "Version", "string"),
    ]},
    {"slug": "work_items", "admin": {"listColumns": ["work_kind", "work_status", "subject", "pillar"]}, "dateField": "due_at", "label": "Work items", "labelSingular": "Work item", "group": AUTO, "sortOrder": 51, "supports": ["revisions", "search"], "routable": False,
     "description": "Tasks, approvals and link requests. Approvals are resolved in Powerfarm → Automation by a person with the required role.", "fields": [
        f("title", "Title", "string", required=True, searchable=True),
        f("code", "Work item code", "string", unique=True, indexed=True, searchable=True),
        sel("work_kind", "Kind", ["task", "approval", "link_request", "review", "control", "attention", "note"], required=True, indexed=True),
        sel("pillar", "Pillar", ["identity", "authority", "security", "maintenance", "general"], indexed=True),
        sel("work_status", "Status", ["open", "done", "rejected", "cancelled", "skipped"], required=True, indexed=True, defaultValue="open"),
        f("subject", "Subject (collection:KEY)", "string", indexed=True), f("due_at", "Due", "datetime", indexed=True),
        f("required_role", "Role required to resolve", "integer"), f("description", "Description", "text", searchable=True),
        sel("decision", "Decision (approvals: approve / reject; needs attention: retry / done_by_hand / give_up)", ["approve", "reject", "retry", "done_by_hand", "give_up"]),
        f("resolution", "Resolution note", "text"), f("resolved_by", "Resolved by", "string"), f("resolved_at", "Resolved", "datetime"),
        sel("control", "Control awaited", CONTROLS),
        f("run_id", "Blueprint run", "string", indexed=True), f("step_id", "Step", "string"),
        f("blueprint_code", "Blueprint", "string", indexed=True), f("blueprint_revision", "Blueprint revision", "string"),
        f("initiated_by", "Run initiated by", "string"), f("separate_from_initiator", "Initiator may not resolve", "boolean"),
        f("origin", "Created by blueprint step", "string", unique=True, indexed=True),
        ref("assignee", "Assignee", "people_work_items", "child", multiple=False),
    ]},
    {"slug": "identifiers", "admin": {"listColumns": ["subject", "namespace", "source"]}, "label": "Identifiers", "labelSingular": "Identifier", "group": ENT, "sortOrder": 45, "supports": ["revisions", "search"], "routable": False,
     "description": "The identity registry: one entry per identifier, unique across every record type. Maintained by Powerfarm from each record's Identifiers field; administrators transfer one by changing its subject, with a rationale.", "fields": [
        f("title", "Identifier", "string", required=True, searchable=True),
        f("identifier", "namespace:value", "string", required=True, unique=True, indexed=True, searchable=True),
        f("namespace", "Namespace", "string", required=True, indexed=True), f("value", "Value", "string", required=True),
        f("subject", "Identifies (collection:KEY)", "string", required=True, indexed=True),
        sel("source", "Source", ["record", "asset_mirror", "transfer"], required=True, indexed=True),
        f("rationale", "Rationale (transfers)", "text"),
    ]},
    {"slug": "incidents", "admin": {"listColumns": ["severity", "incident_status", "subject", "last_seen"]}, "dateField": "last_seen", "label": "Incidents", "labelSingular": "Incident", "group": SEC, "sortOrder": 60, "supports": ["revisions", "search"], "routable": False,
     "description": "What Powerfarm vigilance found on a managed device, or a refused device message. Opened by Powerfarm; people investigate and resolve them here.", "fields": [
        f("title", "Title", "string", required=True, searchable=True),
        sel("severity", "Severity", ["critical", "high", "medium", "low"], required=True, indexed=True),
        sel("incident_status", "Status", ["open", "investigating", "resolved", "false_positive"], required=True, indexed=True, defaultValue="open"),
        f("rule", "Rule", "string", required=True, indexed=True),
        f("subject", "Subject (assets:TAG)", "string", indexed=True),
        f("udid", "Device UDID", "string", indexed=True),
        f("detail", "What was found", "text", required=True, searchable=True),
        f("first_seen", "First seen", "datetime", required=True, indexed=True), f("last_seen", "Last seen", "datetime", required=True, indexed=True),
        f("occurrences", "Occurrences", "number"),
        f("resolution", "Resolution (what was done and why)", "text", searchable=True),
        f("resolved_by", "Resolved by", "string"), f("resolved_at", "Resolved at", "datetime"),
        f("origin", "Origin (set by Powerfarm)", "string", unique=True, indexed=True),
    ]},
    {"slug": "mdm_profiles", "admin": {"listColumns": ["identifier", "install", "platform"]}, "label": "Device profiles", "labelSingular": "Device profile", "group": SEC, "sortOrder": 61, "supports": ["drafts", "revisions", "search"], "routable": False,
     "description": "Configuration profiles for managed devices. Publishing by an administrator approves one: required profiles are then installed by Powerfarm MDM on every matching device; any profile on a device that is not listed here is reported as an incident.", "fields": [
        f("title", "Title", "string", required=True, searchable=True),
        f("identifier", "PayloadIdentifier", "string", required=True, unique=True, indexed=True, searchable=True),
        sel("install", "Install", ["required", "available", "known_external"], required=True, indexed=True, defaultValue="required"),
        sel("platform", "Platform", ["all", "ios", "macos"], required=True, defaultValue="all"),
        f("mobileconfig", "Profile (.mobileconfig XML)", "text"),
        f("description", "Why this profile", "text", searchable=True),
    ]},
    {"slug": "exceptions", "admin": {"listColumns": ["subject", "control", "code"]}, "dateField": "expires_at", "label": "Security exceptions", "labelSingular": "Security exception", "group": AUTO, "sortOrder": 52, "supports": ["drafts", "revisions", "search"], "routable": False,
     "description": "A time-limited, approved waiver of one control on one entity. Publishing by an administrator is the risk acceptance.", "fields": [
        f("title", "Title", "string", required=True, searchable=True),
        f("code", "Exception code", "string", unique=True, indexed=True, searchable=True),
        f("subject", "Subject (collection:KEY)", "string", required=True, indexed=True),
        sel("control", "Control waived", CONTROLS, required=True, indexed=True),
        f("rationale", "Rationale and compensating measures", "text", required=True, searchable=True),
        f("scope_note", "Scope", "text"), f("expires_at", "Expires", "datetime", required=True, indexed=True),
        f("prepared_by_ai", "Prepared by an AI client", "boolean"),
    ]},
    {"slug": "people", "admin": {"listColumns": ["code", "lifecycle", "relationship", "role_title"]}, "label": "People", "labelSingular": "Person", "group": IDN, "sortOrder": 30, "supports": ["drafts", "revisions", "search"], "routable": False,
     "description": "One canonical record per person. Lifecycle: intake = invited, active, suspended, retired = departed. Sign-in identities (EmDash user, OIDC subject, Managed Apple Account, Git) are Identifiers; e-mail and phone are contact details only.", "fields": entity_fields("Person code", "organizations_people", owner_label="Organisation") + [
        sel("relationship", "Relationship", ["founder", "employee", "contractor", "advisor", "external"], indexed=True),
        f("role_title", "Role", "string"),
        f("contact_email", "Contact e-mail (not an identity)", "string"), f("contact_phone", "Contact phone (not an identity)", "string"),
        f("access_groups", "Access groups (coarse, sent to Cloudflare Access)", "json"),
        ref("assets", "Responsible for", "people_assets", "parent"), ref("projects", "Responsible for projects", "people_projects", "parent"),
        ref("agents", "Responsible for agents", "people_agents", "parent"),
    ]},
    {"slug": "organizations", "admin": {"listColumns": ["code", "lifecycle", "legal_name"]}, "label": "Organisations", "labelSingular": "Organisation", "group": IDN, "sortOrder": 29, "supports": ["drafts", "revisions", "search"], "routable": False,
     "description": "Powerfarm itself (OR-0001) and the organisations it deals with as institutions. Holds legal identity and the institutional accounts that must never depend on one person.", "fields": entity_fields("Organisation code", "people_organizations") + [
        f("legal_name", "Legal name", "string", searchable=True), f("jurisdiction", "Jurisdiction", "string"),
        f("institutional_accounts", "Institutional accounts (Cloudflare, Apple Business Manager, MDM push owner, developer team, repositories)", "json"),
        ref("people", "People", "organizations_people", "parent"), ref("services", "Owns services", "organizations_services", "parent"),
    ]},
    {"slug": "agents", "admin": {"listColumns": ["code", "lifecycle", "agent_kind"]}, "label": "Agents", "labelSingular": "Agent", "group": IDN, "sortOrder": 31, "supports": ["drafts", "revisions", "search"], "routable": False,
     "description": "Non-human principals: AI agents, CI runners and release services, each a separate identity with a responsible person. Never signs in with a human method.", "fields": entity_fields("Agent code", "people_agents", owner_label="Responsible person") + [
        sel("agent_kind", "Kind", ["ai_agent", "ci_runner", "release_service", "scheduled_job", "service_account"], required=True, indexed=True),
    ]},
    {"slug": "grants", "admin": {"listColumns": ["principal", "capability", "scope", "valid_until"]}, "dateField": "valid_until", "label": "Grants", "labelSingular": "Grant", "group": IDN, "sortOrder": 32, "supports": ["drafts", "revisions", "search"], "routable": False,
     "description": "Explicit authority. Publishing a grant (by someone holding authority.grant, never to themselves) makes it effective; unpublishing or expiry revokes it.", "fields": [
        f("title", "Title", "string", required=True, searchable=True),
        f("code", "Grant code", "string", unique=True, indexed=True),
        f("principal", "Principal (people:PE-0001 or agents:AG-0001)", "string", required=True, indexed=True),
        sel("capability", "Capability", CAPABILITIES, required=True, indexed=True),
        f("scope", "Scope (* or collection or collection:KEY)", "string", required=True, defaultValue="*"),
        f("delegated_by", "Delegated by (people:PE-…; required for agents)", "string", indexed=True),
        f("task", "Task or reason", "text", required=True),
        f("valid_from", "Valid from", "datetime"), f("valid_until", "Valid until", "datetime", required=True, indexed=True),
        f("policy", "Granted under policy (code)", "string", indexed=True),
    ]},
    {"slug": "policies", "admin": {"listColumns": ["code", "policy_state", "owner_principal", "review_date"]}, "dateField": "review_date", "label": "Policies", "labelSingular": "Policy", "group": IDN, "sortOrder": 33, "supports": ["drafts", "revisions", "search"], "routable": False,
     "description": "Versioned institutional rules. Each published revision is sealed. A policy is 'enforced' only when the mechanism that applies it is running and verified.", "fields": [
        f("title", "Title", "string", required=True, searchable=True),
        f("code", "Policy code", "string", unique=True, indexed=True),
        f("owner_principal", "Owner (people:PE-…)", "string", required=True),
        f("scope", "Scope and affected resources", "text", required=True),
        f("body", "Rule", "text", required=True, searchable=True),
        f("effective_date", "Effective from", "datetime"), f("review_date", "Review by", "datetime", indexed=True),
        f("supersedes", "Supersedes (policy code)", "string"),
        sel("policy_state", "Enforcement", ["documented", "enforced"], required=True, defaultValue="documented"),
        f("enforced_by", "Enforced by (mechanism, and how it was verified)", "text"),
    ]},
]


def rel(slug, parent, child, plabel, clabel):
    return {"slug": slug, "parentCollection": parent, "childCollection": child, "parentLabel": plabel, "childLabel": clabel}


relations = [
    rel("missions_assets", "missions", "assets", "Missions", "Assets in scope"),
    rel("missions_procedures", "missions", "procedures", "Missions", "Procedures"),
    rel("missions_projects", "missions", "projects", "Missions", "Projects"),
    rel("assets_software", "assets", "software", "Installed on", "Installed software"),
    rel("procedures_software", "procedures", "software", "Used by procedures", "Uses software"),
    rel("research_assets", "research", "assets", "Research", "Related assets"),
    rel("research_procedures", "research", "procedures", "Research", "Related procedures"),
    rel("people_assets", "people", "assets", "Custodians", "Responsible for"),
    rel("people_projects", "people", "projects", "Responsible", "Responsible for projects"),
    rel("projects_requirements", "projects", "requirements", "Projects", "Requirements"),
    rel("projects_software", "projects", "software", "Built by", "Builds"),
    rel("requirements_decisions", "requirements", "decisions", "Decides", "Decided by"),
    rel("decisions_software", "decisions", "software", "Governed by", "Governs"),
    rel("tests_requirements", "tests", "requirements", "Verified by", "Verifies"),
    rel("tests_software", "tests", "software", "Tested by", "Tests"),
    rel("releases_software", "releases", "software", "Released in", "Releases"),
    rel("releases_tests", "releases", "tests", "Passed in", "Tests passed"),
]

# 1.2: entity relations. Reference fields live on the new collections, so no 1.1
# collection changes shape (docs/ONTOLOGY-V1.2.md section 7).
IDENTITY_RELATIONS = [
    rel("organizations_people", "organizations", "people", "Organisation", "People"),
    rel("organizations_services", "organizations", "services", "Owned by", "Owns services"),
    rel("people_organizations", "people", "organizations", "Owner", "Owns organisations"),
    rel("people_agents", "people", "agents", "Responsible person", "Responsible for agents"),
]
ENTITY_RELATIONS = [
    rel("people_clients", "people", "clients", "Owner", "Owns clients"),
    rel("people_products", "people", "products", "Owner", "Owns products"),
    rel("people_services", "people", "services", "Owner", "Owns services"),
    rel("people_service_instances", "people", "service_instances", "Owner", "Owns service instances"),
    rel("people_contracts", "people", "contracts", "Owner", "Owns contracts"),
    rel("people_work_items", "people", "work_items", "Assignee", "Assigned work"),
    rel("clients_products", "clients", "products", "Clients", "Products"),
    rel("clients_projects", "clients", "projects", "Sponsored by", "Sponsored projects"),
    rel("clients_contracts", "clients", "contracts", "Client", "Contracts"),
    rel("products_services", "products", "services", "Used by products", "Uses services"),
    rel("services_software", "services", "software", "Implements", "Implemented by"),
    rel("services_instances", "services", "service_instances", "Service", "Instances"),
    rel("service_instances_assets", "service_instances", "assets", "Hosts instances", "Runs on"),
    rel("projects_services", "projects", "services", "Used by projects", "Uses services"),
    rel("projects_service_instances", "projects", "service_instances", "Used by projects", "Uses instances"),
    rel("contracts_products", "contracts", "products", "Covered by contracts", "Covers products"),
    rel("contracts_services", "contracts", "services", "Covered by contracts", "Covers services"),
]
relations += ENTITY_RELATIONS + IDENTITY_RELATIONS


def entry(id_, slug, data, status="published"):
    return {"id": id_, "slug": slug, "status": status, "data": data}


# --- Fleet (names and known hardware exactly as given; identifiers come from verified inventory) ---
def asset(id_, title, tag, device_class, role, model, chip, color=None, os_at_intake=None, model_year=None):
    data = {"title": title, "asset_tag": tag, "device_class": device_class, "role": role, "model": model, "chip": chip}
    if color:
        data["color"] = color
    if os_at_intake:
        data["os_at_intake"] = os_at_intake
    if model_year:
        data["model_year"] = model_year
    return entry(id_, tag.lower(), data)


assets = [
    asset("asset-lab-001", "LAB 001", "LAB-001", "mac_intel", "comms_terminal", "MacBook Pro", "intel", os_at_intake="macOS Catalina 10.15.7", model_year="2012"),
    asset("asset-lab-512", "LAB 512", "LAB-512", "mac_apple_silicon", "trusted_host", "Mac mini (M1)", "apple_silicon"),
    asset("asset-lab-8gb", "LAB 8GB", "LAB-8GB", "mac_apple_silicon", "fleet", "Mac mini (M1)", "apple_silicon"),
    asset("asset-lab-256", "LAB 256", "LAB-256", "mac_apple_silicon", "fleet", "Mac mini (M1)", "apple_silicon"),
    asset("asset-iphone-13-red", "iPhone 13 RED", "IPHONE-13-RED", "iphone", "fleet", "iPhone 13", "a_series", color="Red"),
    asset("asset-iphone-14-purple", "iPhone 14 PURPLE", "IPHONE-14-PURPLE", "iphone", "fleet", "iPhone 14", "a_series", color="Purple"),
    asset("asset-iphone-15-black", "iPhone 15 BLACK", "IPHONE-15-BLACK", "iphone", "fleet", "iPhone 15", "a_series", color="Black"),
]
TARGETS = [a["id"] for a in assets if a["data"]["role"] != "comms_terminal"]

MAC = ["mac_apple_silicon", "mac_intel"]
AS = ["mac_apple_silicon"]
IOS = ["iphone", "ipad"]
DFU_HOST = "A second, trusted Mac running macOS 14 or later, connected directly with a USB-C data cable that supports data to the target's DFU port. LAB 001 (Catalina, Intel) cannot act as the DFU host, and neither can the Linux VM."


def proc(id_, code, title, operation, classes, pre, tools, physical, expected, evidence, failure, steps, software=False):
    data = {
        "title": title, "code": code, "operation": operation, "device_classes": classes, "preconditions": pre,
        "required_tools": tools, "physical_steps": physical, "expected_results": expected, "required_evidence": evidence,
        "failure_instructions": failure, "steps": pt(*steps), "procedure_version": "1.1",
    }
    if software:
        data["software"] = ["$ref:sw-apple-configurator"]
    return entry(id_, code.lower(), data)


procedures = [
    proc("proc-host-bootstrap", "P-HOST-BOOTSTRAP", "Trusted host bootstrap (LAB 512)", "mac_recovery_reinstall", AS,
         "Done before EmDash exists on LAB 512. Recorded afterwards with recordOnly.",
         "LAB 512's own macOS Recovery; if DFU is needed, " + DFU_HOST + " Or Apple-authorised service.",
         "1. Try macOS Recovery on LAB 512: shut down, hold the power button until 'Loading startup options', choose Options, then erase and reinstall macOS.\n2. Only if that is impossible: DFU revive or restore from the second Mac's Finder.\n3. Set up with a new administrator account and Powerfarm's own Apple Account. Do not migrate data, profiles or apps.",
         "LAB 512 boots a clean macOS, FileVault on, no unknown profiles, Activation Lock tied to Powerfarm's account.",
         ["host_bootstrap", "account_security", "activation_lock", "management_enrollment"],
         "If Recovery and DFU both fail, stop and use Apple-authorised service.",
         ["EmDash cannot vouch for the machine it runs on, so LAB 512 is recovered independently and the method and result are recorded once EmDash is available."]),
    proc("proc-inventory", "P-INVENTORY", "iPhone inventory", "inventory", IOS,
         "Device connected to the bridge host, unlocked, host trusted.", "Apple Configurator (cfgutil) on the bridge host, validated for inventory.",
         "Connect the iPhone with a USB cable. Unlock it and tap Trust when asked.",
         "Serial number, ECID, model and iOS version reported.", ["inventory_report"],
         "If the device does not appear, try another cable and port; check it is unlocked.",
         ["Read-only. Copy the reported serial number and ECID onto the asset yourself; the platform never writes identity automatically."], software=True),
    proc("proc-mac-inventory", "P-MAC-INVENTORY", "Mac inventory (manual)", "mac_inventory_manual", MAC,
         "Mac powered on, or in DFU mode on the DFU host if its ECID is wanted.", "About This Mac / System Information; Apple Configurator on the DFU host for the ECID.",
         "Open Apple menu → System Settings → General → About and note the serial number. Optionally read the ECID from Apple Configurator on the DFU host.",
         "Serial number recorded; ECID recorded if DFU is used.", ["inventory_report"],
         "If the Mac will not boot, record the serial from the underside or the original packaging and mark the source.",
         ["Complete the manual job with the observed values and attach a screenshot or report."]),
    proc("proc-ios-backup", "P-IOS-BACKUP", "iPhone backup", "backup", IOS,
         "Device connected and unlocked. Enough space on the bridge host.", "Apple Configurator (cfgutil), validated for backup.",
         "Keep the iPhone unlocked until the backup completes.", "A local backup and its manifest.", ["backup_manifest"],
         "If the backup fails, decide explicitly whether to waive it before any restore.",
         ["Preserve user data selectively. Do not restore settings, profiles or apps from an untrusted installation."], software=True),
    proc("proc-backup-manual", "P-BACKUP-MANUAL", "Manual data preservation", "backup_manual", DEVICE_CLASSES,
         "Decide which user files are worth keeping.", "External disk or the trusted host.",
         "Copy only user documents you need. Do not copy system settings, profiles, certificates or applications.",
         "A manifest of what was kept, with hashes.", ["backup_manifest"], "If nothing is needed, record 'no user data' on the restore instead.",
         ["Record the manifest as evidence."]),
    proc("proc-ios-restore", "P-IOS-RESTORE", "iPhone erase and restore", "restore", IOS,
         "Data-preservation decision recorded on the operation. Identity confirmed by inventory.", "Apple Configurator (cfgutil), validated for restore.",
         "Connect the iPhone. If it does not appear, put it in recovery mode. Type the asset tag at the bridge when asked.",
         "Device erased with current iOS from Apple; setup assistant shown.", ["restore_log"],
         "If the restore stops part-way, do not retry. The job becomes needs_inspection; inspect the device and record what you see.",
         ["Destructive. One per device at a time."], software=True),
    proc("proc-mac-recovery", "P-MAC-RECOVERY", "Mac erase and reinstall from macOS Recovery", "mac_recovery_reinstall", AS,
         "Data-preservation decision recorded. Serial number recorded.", "The Mac's own macOS Recovery and a network connection.",
         "Shut down. Hold the power button until 'Loading startup options'. Choose Options, open Disk Utility to erase, then Reinstall macOS.",
         "Clean macOS at the setup assistant.", ["attestation"],
         "If Recovery cannot erase or reinstall, use P-MAC-REVIVE, then P-MAC-RESTORE.",
         ["Manual. Complete the job afterwards with the outcome and attach evidence."]),
    proc("proc-mac-revive", "P-MAC-REVIVE", "Mac DFU revive (Finder)", "mac_dfu_revive", AS,
         DFU_HOST, "Finder on the DFU host.",
         "Put the target Mac into DFU mode and connect it to the DFU host. In Finder, select the Mac and choose Revive Mac.",
         "Firmware and recoveryOS reinstalled; data kept.", ["attestation"], "If revive fails, use P-MAC-RESTORE.",
         ["Manual Finder procedure. No automated route has been validated."]),
    proc("proc-mac-restore", "P-MAC-RESTORE", "Mac DFU erase and restore (Finder)", "mac_dfu_restore", AS,
         DFU_HOST + " Data-preservation decision recorded.", "Finder on the DFU host.",
         "Put the target Mac into DFU mode and connect it to the DFU host. In Finder, select the Mac, choose Restore Mac and confirm erasure.",
         "Mac erased; latest firmware and macOS installed.", ["attestation"],
         "If the restore fails part-way, record it; inspect before trying again.",
         ["Manual Finder procedure. Destructive."]),
    proc("proc-verify", "P-VERIFY", "iPhone verification", "verify", IOS,
         "Restore completed. Asset has serial, ECID and an OS policy recorded.", "Apple Configurator (cfgutil), validated for verify.",
         "Connect the restored iPhone to the bridge host.", "Serial and ECID match exactly; iOS meets the policy.", ["verification_report"],
         "Any mismatch blocks the device. Investigate before continuing.", ["Read-only."], software=True),
    proc("proc-mac-verify", "P-MAC-VERIFY", "Mac verification (manual)", "mac_verify_manual", MAC,
         "Restore completed. Serial and OS policy recorded.", "About This Mac / System Information.",
         "Read the serial number and macOS version and build, and enter them when completing the job.",
         "Serial matches exactly; macOS meets the policy.", ["verification_report"], "Any mismatch blocks the device.", ["Attach a screenshot or report."]),
    proc("proc-account-security", "P-ACCOUNT-SECURITY", "Account and security baseline", "security_baseline", DEVICE_CLASSES,
         "Device restored and verified.", "The device and Powerfarm's own Apple Account.",
         "Sign in with Powerfarm's Apple Account; turn on two-factor authentication and Find My; confirm Activation Lock belongs to that account; check there is no device-management enrolment or profile you do not recognise; set a passcode or FileVault.",
         "One attestation each for account security, Activation Lock and management enrolment, recorded after the latest restore.",
         ["account_security", "activation_lock", "management_enrollment"],
         "If the device is enrolled in management you do not recognise, stop: do not remove ownership information; contact the organisation that owns the enrolment or Apple.",
         ["Record each check as an Evidence attestation."]),
    proc("proc-inspect", "P-INSPECT", "Inspect after an interrupted operation", "none", DEVICE_CLASSES,
         "A job is in needs_inspection.", "The device.",
         "Look at the device without starting anything: setup screen, recovery mode, old system, or unresponsive?",
         "A written finding on the job, then a fresh inventory.", [], "If the device is unresponsive, try recovery mode or DFU only after recording the finding.",
         ["Guidance only; cannot be approved as an operation."]),
]

software = [
    entry("sw-apple-configurator", "apple-configurator", {"title": "Apple Configurator (cfgutil)", "software_kind": "tool", "vendor": "Apple",
          "notes": "Installed on LAB 512 (macOS). The Apple Hardware Bridge uses only operations validated on that host."}),
    entry("sw-emdash", "emdash", {"title": "EmDash CMS", "software_kind": "service", "vendor": "EmDash", "software_version": "1.4.0",
          "source_revision": "981c78d5d347428e77afd27b7582924607754503", "source_url": "https://github.com/emdash-cms/emdash"}),
    entry("sw-powerfarm-plugin", "powerfarm-plugin", {"title": "Powerfarm EmDash plugin", "software_kind": "component", "vendor": "Powerfarm", "software_version": "1.4.0"}),
    entry("sw-bridge", "apple-hardware-bridge", {"title": "Apple Hardware Bridge", "software_kind": "component", "vendor": "Powerfarm", "software_version": "1.1.0"}),
]

decisions = [
    entry(f"adr-{n}", f"adr-{n:04d}", {"title": t, "code": f"ADR-{n:04d}", "decision_status": "accepted", "context": c, "decision": d, "alternatives": a, "consequences": q,
          **({"software": [f"$ref:{s}" for s in sw]} if sw else {})})
    for n, t, c, d, a, q, sw in [
        (1, "EmDash is the Powerfarm platform", "Recovery, graph and knowledge needed a home.", "Build everything as EmDash content, relations, plugin storage and a native plugin.", "Separate ARCC application; external graph database.", "One installation, one database, one permission model.", ["sw-emdash", "sw-powerfarm-plugin"]),
        (2, "Approval is publication", "Destructive operations need a human decision bound to an exact version.", "A recovery operation is approved by publishing it; the job records the published revision.", "Separate approval records.", "EmDash revisions are the audit of what was approved; MCP and plugins cannot publish operations.", ["sw-powerfarm-plugin"]),
        (3, "Link fields for operational records", "Plugin and MCP writes cannot set relation-bound references.", "Operations, events and evidence link by business key; knowledge relationships use native relations.", "Core patch exposing reference writes to plugins.", "Links validated on save; graph shows both kinds.", ["sw-powerfarm-plugin"]),
        (4, "Journal in plugin storage, events as projection", "Events must not silently disappear.", "Hash-chained journal in EmDash plugin storage, projected to Events through an outbox.", "Events content as the only record.", "Projection failures are retried and visible; audit-degraded blocks trust.", ["sw-powerfarm-plugin"]),
        (5, "Mac DFU stays manual", "No automated Apple-silicon DFU route has been validated.", "Mac revive/restore are Finder procedures on a second Mac with macOS 14+; outcomes recorded in EmDash.", "Automating via cfgutil.", "The bridge never touches a Mac.", ["sw-bridge"]),
        (6, "SQLite for Mission 001", "Single process on LAB 512; EmDash search uses FTS5 on SQLite.", "Use SQLite.", "PostgreSQL.", "Simple backup; revisit if multiple processes are needed. EmDash FTS is SQLite-only.", ["sw-emdash"]),
        (7, "Private media files", "EmDash serves /_emdash/api/media/file without authentication.", "A small, isolated EmDash patch makes media files require authentication when EMDASH_PRIVATE_MEDIA=1.", "Keeping evidence outside EmDash media.", "Evidence is in EmDash media and not public.", ["sw-emdash"]),
        (8, "Reference writes for trusted plugins (patch 0002)", "Onboarding blueprints must create records linked by native relations; EmDash's plugin content.create drops references.", "Patch EmDash so in-process plugins may pass references to content.create, validated by EmDash's own create handler in the same transaction; sandboxed plugins are refused. Recovery records keep link fields (ADR-0003).", "Link fields for every new entity; asking a person to link every created record.", "Native relations for entities; one more EmDash patch to carry on upgrades.", ["sw-emdash", "sw-powerfarm-plugin"]),
        (9, "Entity status comes from evidence-backed controls", "A 'secure' or 'active' flag anyone can set proves nothing.", "Lifecycle changes are publications checked against controls derived from attestations, relations, the identity registry and approved exceptions.", "Editable status fields; checklists outside EmDash.", "Activation can be refused with a list of what is missing; nothing activates automatically.", ["sw-powerfarm-plugin"]),
        (10, "Cloudflare holds the state; the lab Macs do the compute", "The lab is less available than a cloud service, and computing in the cloud costs too much for device work.", "Run EmDash on Cloudflare (Workers, D1, R2, Cron Trigger) behind Cloudflare Access; keep device work and large files on the lab Macs, which pull jobs and report back through a disk outbox.", "EmDash on a VM in the lab (ADR-0006); compute in the cloud.", "Nothing in the lab is reachable from the internet; a lab outage delays jobs but never loses what Powerfarm records. D1 is SQLite, so ADR-0006's search reasoning holds. Two locks: Access, then EmDash's own sign-in.", ["sw-emdash", "sw-powerfarm-plugin", "sw-bridge"]),
        (11, "A thin MDM inside the Powerfarm plugin", "Six devices were compromised and attacks continue; the fleet needs continuous management, and EmDash already provides routes, storage, content, cron and audit.", "Implement Apple's MDM protocol in the Powerfarm plugin: device messages verified against a Powerfarm device CA whose key stays on the lab Mac; profiles approved by publishing; findings as incidents; a posture score for Cloudflare Access. The enrolment grants no erase, lock or passcode rights.", "A commercial MDM; a separate MDM server.", "One platform; a compromised Powerfarm cannot wipe or lock the fleet; pushes go through the lab Mac, so a lab outage delays commands.", ["sw-powerfarm-plugin", "sw-bridge"]),
        (12, "Powerfarm Identity: principals, grants and federation on EmDash", "Access to the institution must not depend on any one person's account, and authority must be explicit, scoped and auditable.", "Every principal (organisation, person, agent, service, device) is EmDash content with a permanent principal_id; sign-in identities are entries in the identifier registry; authority is published grants checked by one authorize() decision on every governed path; Powerfarm is the OIDC provider for Cloudflare Access; published institutional records are sealed.", "A separate identity platform or directory; roles as the only authority; Cloudflare or Apple as the identity root.", "One identity model; suspension and revocation take effect at Powerfarm's gates at once; EmDash core administration stays governed by EmDash roles behind a stricter Access application.", ["sw-powerfarm-plugin"]),
    ]
]

requirements = [
    entry(f"req-{n}", f"req-{n:03d}", {"title": t, "code": f"REQ-{n:03d}", "statement": s, "priority": "must", "requirement_status": "accepted", "decisions": [f"$ref:adr-{d}" for d in ds]})
    for n, t, s, ds in [
        (1, "Human approval boundary", "Only a person can approve a recovery operation; AI clients draft only.", [2]),
        (2, "Simulations never count", "No simulated or dry-run result satisfies a recovery milestone.", [2]),
        (3, "Fail-closed verification", "Identity must match exactly; missing data fails.", [2]),
        (4, "Durable operational journal", "Operational events cannot silently disappear.", [4]),
        (5, "Media-backed evidence", "Evidence is stored in EmDash media with a server-computed digest.", [7]),
        (6, "Graph access control", "The graph never reveals drafts, fields or identifiers a caller may not see.", [1, 3]),
        (7, "One active job per device", "No two jobs act on one device at once; unknown outcomes block retries.", [2]),
        (8, "Identifiers unique across types", "An identifier (VAT, LEI, domain …) identifies one record of any type; duplicates are refused, also under concurrency.", [9]),
        (9, "No automatic activation", "Creating or registering a record never activates it, grants authority, signs an agreement or provisions anything.", [8, 9]),
    ]
]

tests = [
    entry("test-plugin-unit", "test-plugin-unit", {"title": "Powerfarm plugin tests", "code": "TEST-PLUGIN", "test_kind": "unit", "command": "cd powerfarm/plugin && pnpm test",
          "last_result": "not_run", "result_summary": "Recorded at release time; see Releases.", "requirements": [f"$ref:req-{n}" for n in range(1, 10)], "software": ["$ref:sw-powerfarm-plugin"]}),
    entry("test-bridge-unit", "test-bridge-unit", {"title": "Bridge tests", "code": "TEST-BRIDGE", "test_kind": "unit", "command": "cd powerfarm/bridge && pnpm test", "last_result": "not_run", "software": ["$ref:sw-bridge"]}),
    entry("test-integration", "test-integration", {"title": "EmDash integration tests", "code": "TEST-INTEGRATION", "test_kind": "integration", "command": "scripts/setup.sh then pnpm test:integration in powerfarm/site", "last_result": "not_run", "software": ["$ref:sw-powerfarm-plugin", "$ref:sw-emdash"]}),
    entry("test-hw-ios", "test-hw-ios", {"title": "Hardware: iPhone operations on LAB 512", "code": "TEST-HW-IOS", "test_kind": "hardware", "command": "powerfarm-bridge doctor --validate", "last_result": "not_run", "software": ["$ref:sw-bridge", "$ref:sw-apple-configurator"]}),
    entry("test-hw-mac", "test-hw-mac", {"title": "Hardware: Mac Finder procedures", "code": "TEST-HW-MAC", "test_kind": "hardware", "command": "Manual; see docs/ACCEPTANCE.md", "last_result": "not_run"}),
]

releases_140 = [entry("rel-1-4-0", "v1-4-0", {"title": "Powerfarm EmDash Platform 1.4.0", "code": "1.4.0", "emdash_revision": "981c78d5d347428e77afd27b7582924607754503",
                      "notes": "Powerfarm Identity: organisations, people and agents as principals with permanent ids; grants and policies; the authorize() boundary; suspension; record seals; Access assertion check and identity/whoami; OIDC provider for Cloudflare Access; release gate; Access log feed. ADR-0012.",
                      "software": ["$ref:sw-powerfarm-plugin", "$ref:sw-bridge"], "tests": ["$ref:test-plugin-unit", "$ref:test-bridge-unit"]})]
releases_130 = [entry("rel-1-3-0", "v1-3-0", {"title": "Powerfarm EmDash Platform 1.3.0", "code": "1.3.0", "emdash_revision": "981c78d5d347428e77afd27b7582924607754503",
                      "notes": "Powerfarm Identity, first part: a thin MDM in the plugin (check-in and commands, device signatures against the Powerfarm device CA, approved profiles, vigilance and incidents, Cloudflare Access posture score, pushes and enrolment through the lab Mac). ADR-0011.",
                      "software": ["$ref:sw-powerfarm-plugin", "$ref:sw-bridge"], "tests": ["$ref:test-plugin-unit", "$ref:test-bridge-unit"]})]
releases_122 = [entry("rel-1-2-2", "v1-2-2", {"title": "Powerfarm EmDash Platform 1.2.2", "code": "1.2.2", "emdash_revision": "981c78d5d347428e77afd27b7582924607754503",
                      "notes": "Deployment on Cloudflare (Workers, D1, R2, Access) with the lab Macs as pull workers; D1-safe reads; bridge outbox for lab outages; lifecycle integrity (active records keep their controls, registered records leave by retirement, merges wait for relinking). ADR-0010.",
                      "software": ["$ref:sw-powerfarm-plugin", "$ref:sw-bridge"], "tests": ["$ref:test-plugin-unit", "$ref:test-bridge-unit"]})]
releases_12 = [entry("rel-1-2-0", "v1-2-0", {"title": "Powerfarm EmDash Platform 1.2.0", "code": "1.2.0", "emdash_revision": "981c78d5d347428e77afd27b7582924607754503",
                     "notes": "Entities (clients, products, services, service instances, contracts), identity registry as content, classification and evidence-backed lifecycle controls, onboarding blueprints run as work items. EmDash patch 0002 (plugin reference writes).",
                     "software": ["$ref:sw-powerfarm-plugin"], "tests": ["$ref:test-plugin-unit"]})]
releases = [entry("rel-1-1-0", "v1-1-0", {"title": "Powerfarm EmDash Platform 1.1.0", "code": "1.1.0", "emdash_revision": "981c78d5d347428e77afd27b7582924607754503",
                  "notes": "Mission 001 corrections: simulation semantics, fail-closed verification, journal and outbox, media evidence, graph access control, native admin integration.",
                  "software": ["$ref:sw-powerfarm-plugin", "$ref:sw-bridge"], "tests": ["$ref:test-plugin-unit", "$ref:test-bridge-unit"]})]

projects = [entry("proj-platform", "pf-platform", {"title": "Powerfarm EmDash Platform", "code": "PF-PLATFORM", "project_status": "active",
                  "summary": "EmDash as Powerfarm's institutional platform: graph, Mission 001 recovery, engineering records.",
                  "requirements": [f"$ref:req-{n}" for n in range(1, 10)], "software": ["$ref:sw-powerfarm-plugin", "$ref:sw-bridge"]})]

missions = [entry("mission-001", "m001", {
    "title": "Mission 001 — Neutralization and trusted recovery", "code": "M001", "mission_status": "active",
    "objective": "Establish a trusted recovery path, stop relying on untrusted installations, rebuild LAB 512, LAB 8GB, LAB 256, iPhone 13 RED, iPhone 14 PURPLE and iPhone 15 BLACK, and verify them.",
    "acceptance": "All six recovery targets are 'trusted': real restore, exact identity verification after it, security attestations after it, intact audit journal, and an administrator's trust sign-off.",
    "body": pt("LAB 001 is the communications terminal and is not a recovery target.",
               "LAB 512 is recovered first and independently, then hosts EmDash (in an Ubuntu VM) and the Apple Hardware Bridge (on macOS).",
               "iPhones are handled by the bridge; Macs by documented manual procedures. Every destructive step is a recovery operation that a person approves by publishing it."),
    "assets": [f"$ref:{a}" for a in TARGETS],
    "procedures": [f"$ref:{p['id']}" for p in procedures],
    "projects": ["$ref:proj-platform"],
})]

people = [entry("person-director", "director", {"title": "Powerfarm Director", "role_title": "Institutional authority",
                "assets": [f"$ref:{a['id']}" for a in assets], "projects": ["$ref:proj-platform"]})]

ONBOARDING_STEPS = [
    {"id": "owner", "action": "create_task", "title": "Confirm the accountable owner for {{subject.title}}", "pillar": "authority",
     "description": "Set the client's Accountable owner in the editor and publish.", "dueInDays": 3, "when": {"reference": "owner", "empty": True}},
    {"id": "identity", "action": "create_task", "title": "Verify the identity of {{subject.title}}", "pillar": "identity", "assignee": "$subject.owner",
     "description": "Check each identifier with its issuer. Record an identity_verified attestation (Evidence, subject {{subject.ref}}) naming the identifier; attach the issuer's record if you have it.", "dueInDays": 7},
    {"id": "classification", "action": "create_task", "title": "Review the classification of {{subject.title}} ({{subject.classification}})", "pillar": "security", "assignee": "$subject.owner",
     "description": "Confirm the classification fits the information held. Record a classification_reviewed attestation.", "dueInDays": 7},
    {"id": "access", "action": "create_task", "title": "Review who may access {{subject.title}}'s records", "pillar": "authority",
     "description": "Confidential and restricted clients need an administrator's access_reviewed attestation before activation.", "dueInDays": 7,
     "when": {"field": "classification", "in": ["confidential", "restricted"]}},
    {"id": "links", "action": "request_link", "title": "Link the products and shared services {{subject.title}} uses", "pillar": "general",
     "description": "Select existing Products on the client and publish. Do not register a second copy of a service that is already in the catalogue.",
     "when": {"reference": "products", "empty": True}},
    {"id": "contract", "action": "create_record", "collection": "contracts",
     "fields": {"title": "Agreement with {{subject.title}}", "contract_kind": "msa"},
     "references": {"client": ["$subject"], "products": ["$subject.products"], "owner": ["$subject.owner"]}},
    {"id": "contract_review", "action": "request_approval", "title": "Review the draft agreement for {{subject.title}}", "requiredRole": 50,
     "description": "Open the draft contract this run created. Approve when its terms are ready to negotiate. Approving does not sign it: signing is a contract_signed attestation with the signed copy.",
     "dependsOn": ["contract"]},
    {"id": "maintenance", "action": "create_task", "title": "Set the review cadence for {{subject.title}} and record a maintenance plan", "pillar": "maintenance", "assignee": "$subject.owner", "dueInDays": 14},
    {"id": "identity_check", "action": "wait_for_control", "control": "identity_verified", "timeoutDays": 30, "dependsOn": ["identity"]},
    {"id": "done", "action": "record_provenance", "title": "Onboarding work for {{subject.title}} is in place", "dependsOn": ["contract_review", "identity_check"]},
]

blueprints = [entry("bp-client-onboarding", "bp-client-onboarding", {
    "title": "Client onboarding", "code": "BP-CLIENT-ONBOARDING", "target_collection": "clients", "trigger": "registered",
    "description": "When a client registration is approved: owner, identity, classification and access reviews, product links, a draft agreement for review, a maintenance plan.",
    "steps": ONBOARDING_STEPS,
    "failure_procedure": "Open Powerfarm → Automation, read the failed step, fix the cause, then mark the step resolved or cancel the run. Never re-register the client to re-run onboarding.",
    "blueprint_version": "1.0",
}, status="draft")]

seed = {
    "$schema": "https://emdashcms.com/seed.schema.json",
    "version": "1",
    "meta": {"name": "Powerfarm", "description": "Powerfarm institutional platform on EmDash (content model 1.2)", "author": "Powerfarm"},
    "settings": {"title": "Powerfarm", "tagline": "Institutional operating platform", "timezone": "Europe/Lisbon"},
    "collections": collections,
    "relations": relations,
    "content": {
        "software": software, "decisions": decisions, "requirements": requirements, "tests": tests, "releases": releases + releases_12 + releases_122 + releases_130 + releases_140,
        "projects": projects, "assets": assets, "procedures": procedures, "missions": missions, "people": people,
        "blueprints": blueprints,
    },
}

OUT.write_text(json.dumps(seed, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8")
print(f"wrote {OUT}")

# 1.1 -> 1.2 migration: the new collections and relations, plus `evidence` in full
# (it gains `subject`, `identifier` and the control attestation options). Applied
# with --no-content --on-conflict update (schema), then --on-conflict skip
# (adds the draft blueprint only if missing). See scripts/migrate-1.2.sh.
NEW_COLLECTIONS = ENTITY_COLLECTIONS + ["identifiers", "blueprints", "work_items", "exceptions"]
migration = {
    "$schema": "https://emdashcms.com/seed.schema.json",
    "version": "1",
    "meta": {"name": "Powerfarm 1.1 to 1.2", "description": "Additive migration: entities, automation, evidence subject fields", "author": "Powerfarm"},
    "collections": [c for c in collections if c["slug"] in NEW_COLLECTIONS or c["slug"] == "evidence"],
    "relations": ENTITY_RELATIONS,
    "content": {"blueprints": blueprints},
}
MIG14 = OUT.parent / "migrations" / "1.4.0.json"
MIG14.write_text(json.dumps({
    "$schema": "https://emdashcms.com/seed.schema.json",
    "version": "1",
    "meta": {"name": "Powerfarm 1.3 to 1.4", "description": "Additive migration: Powerfarm Identity (organisations, agents, grants, policies; people and releases extended; principal_id on every entity)", "author": "Powerfarm"},
    "collections": [c for c in collections if c["slug"] in ["people", "organizations", "agents", "grants", "policies", "releases"] + ENTITY_COLLECTIONS],
    "relations": IDENTITY_RELATIONS,
}, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8")
print(f"wrote {MIG14}")
MIG13 = OUT.parent / "migrations" / "1.3.0.json"
MIG13.parent.mkdir(exist_ok=True)
MIG13.write_text(json.dumps({
    "$schema": "https://emdashcms.com/seed.schema.json",
    "version": "1",
    "meta": {"name": "Powerfarm 1.2 to 1.3", "description": "Additive migration: incidents and device profiles (Powerfarm MDM)", "author": "Powerfarm"},
    "collections": [c for c in collections if c["slug"] in ("incidents", "mdm_profiles")],
}, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8")
print(f"wrote {MIG13}")
MIG = OUT.parent / "migrations" / "1.2.0.json"
MIG.parent.mkdir(exist_ok=True)
MIG.write_text(json.dumps(migration, indent="\t", ensure_ascii=False) + "\n", encoding="utf-8")
print(f"wrote {MIG}")
