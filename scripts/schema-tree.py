#!/usr/bin/env python3
"""Inventory EmDash (at the pin) and the Powerfarm plugin as two trees.

    python3 scripts/schema-tree.py [--emdash .upstream/emdash] [--out docs/generated]

Reads source files as text and never imports or runs them. Writes:
  schema-tree.json   both trees, machine-readable (for diffs across EmDash upgrades)
  schema-tree.md     the same, as indented trees for people

Run it after scripts/setup.sh has fetched EmDash at the pin. The regexes follow
EmDash 1.4's source layout; an upgrade that moves things shows up as an empty
branch, which is itself worth a look.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def loc(p: Path) -> int:
    return read(p).count("\n")


def block(text: str, start_pattern: str) -> str:
    """The text of the first bracketed block ({…} or […]) after start_pattern."""
    m = re.search(start_pattern, text)
    if not m:
        return ""
    i = m.end()
    while i < len(text) and text[i] not in "{[":
        i += 1
    if i >= len(text):
        return ""
    open_c = text[i]
    close_c = "}" if open_c == "{" else "]"
    depth = 0
    for j in range(i, len(text)):
        if text[j] == open_c:
            depth += 1
        elif text[j] == close_c:
            depth -= 1
            if depth == 0:
                return text[i + 1 : j]
    return ""


def strings_in(text: str) -> list[str]:
    return re.findall(r'"([^"\n]+)"', text)


def top_keys(body: str) -> list[str]:
    """Keys at depth 0 of an object literal body."""
    keys, depth, line_start = [], 0, True
    for line in body.split("\n"):
        if depth == 0:
            m = re.match(r'\s*(?:"([^"]+)"|\'([^\']+)\'|(?:\[[A-Z_]+\.)?([A-Za-z0-9_$.]+)\]?)\??\s*:', line)
            if m and not line.strip().startswith("//"):
                keys.append(next(g for g in m.groups() if g))
        depth += line.count("{") + line.count("[") + line.count("(") - line.count("}") - line.count("]") - line.count(")")
    return keys


# ---------------------------------------------------------------- EmDash
def emdash_tree(base: Path) -> dict:
    core = base / "packages/core/src"
    tree: dict = {}

    areas = {}
    for d in sorted(p for p in core.iterdir() if p.is_dir()):
        files = [f for f in d.rglob("*.ts*") if ".d.ts" not in f.name]
        areas[d.name] = {"files": len(files), "lines": sum(loc(f) for f in files)}
    tree["core areas (packages/core/src)"] = areas

    routes = {}
    rdir = core / "astro/routes/api"
    for f in sorted(rdir.rglob("*.ts")):
        methods = re.findall(r"export const (GET|POST|PUT|PATCH|DELETE)\b", read(f))
        if methods:
            rel = "/_emdash/api/" + str(f.relative_to(rdir)).removesuffix(".ts").removesuffix("/index")
            routes[rel] = methods
    tree["REST API routes"] = routes

    mcp = read(core / "mcp/server.ts")
    tree["MCP tools"] = sorted(set(re.findall(r'registerTool\(\s*"([a-z0-9_]+)"', mcp)))

    manifest = read(core / "plugins/manifest-schema.ts")
    tree["plugin hooks"] = strings_in(block(manifest, r"export const HOOK_NAMES ="))
    tree["plugin capabilities"] = strings_in(block(manifest, r"export const CURRENT_PLUGIN_CAPABILITIES ="))
    tree["field types"] = strings_in(block(manifest, r"const FIELD_TYPES ="))

    types = read(core / "plugins/types.ts")
    tree["plugin context (ctx.*)"] = top_keys(block(types, r"export interface PluginContext[^{]*"))

    rbac = read(base / "packages/auth/src/rbac.ts")
    perms = re.findall(r'^\s*"([a-z_:.]+)":\s*Role\.(\w+)', block(rbac, r"export const Permissions ="), re.M)
    by_role: dict[str, list[str]] = {}
    for perm, role in perms:
        by_role.setdefault(role, []).append(perm)
    tree["permissions by minimum role"] = by_role

    tables = set()
    for f in (core / "database/migrations").glob("*.ts"):
        tables.update(re.findall(r'createTable\(\s*"([^"]+)"', read(f)))
    tree["system tables"] = sorted(tables)

    plugins_dir = base / "packages/plugins"
    tree["first-party plugins"] = sorted(p.name for p in plugins_dir.iterdir() if p.is_dir() and (p / "package.json").exists())
    tree["packages"] = sorted(p.name for p in (base / "packages").iterdir() if (p / "package.json").exists())
    tree["apps"] = sorted(p.name for p in (base / "apps").iterdir() if p.is_dir())
    return tree


# ---------------------------------------------------------------- Powerfarm
def powerfarm_tree(root: Path) -> dict:
    src = root / "plugin/src"
    tree: dict = {}

    modules = {}
    for f in sorted(src.rglob("*.ts*")):
        if f.name.endswith(".d.ts"):
            continue
        text = read(f)
        head = re.search(r"^(?://|/\*\*?|\s\*)\s*(\S.+)$", text, re.M)
        modules[str(f.relative_to(src))] = {"lines": text.count("\n"), "about": head.group(1).strip(" */") if head else ""}
    tree["modules (plugin/src)"] = modules

    index = read(src / "index.ts")
    tree["EmDash capabilities requested"] = strings_in(block(index, r"const CAPABILITIES: PluginCapability\[\] ="))
    hook_names = set(strings_in(block(read(ROOT / ".upstream/emdash/packages/core/src/plugins/manifest-schema.ts"), r"export const HOOK_NAMES =")))
    hooks = top_keys(block(index, r"hooks:\s*"))
    tree["EmDash hooks used"] = sorted(h for h in hooks if h in hook_names or not hook_names)
    tree["admin pages"] = re.findall(r'path:\s*"([^"]+)"', block(index, r"const ADMIN_PAGES ="))
    tree["admin widgets"] = re.findall(r'id:\s*"([^"]+)"', block(index, r"const ADMIN_WIDGETS ="))

    routes = {}
    sources = {f: read(f) for f in src.rglob("*.ts")}
    for fn in ["apiRoutes", "bridgeRoutes", "mdmBridgeRoutes", "mdmRoutes", "identityRoutes"]:
        for f, text in sources.items():
            at = text.find(f"export function {fn}(")
            body = block(text[at:], r"return\s*(?=\{)") if at >= 0 else ""
            if body:
                for key in top_keys(body):
                    if not key.startswith("..."):
                        routes[key] = str(f.relative_to(src))
    tree["plugin routes (/_emdash/api/plugins/powerfarm/…)"] = routes

    tree["MCP tools (scope mcp:tools:powerfarm)"] = re.findall(r"^\s*([a-z_]+):\s*t\(", block(read(src / "routes.ts"), r"export function mcpTools\(\)[^{]*\{\s*const t[^;]*;\s*return"), re.M)

    storage = [k for k in top_keys(block(read(src / "jobs.ts"), r"export const STORAGE =")) if not k.startswith("...")]
    storage += top_keys(block(read(src / "journal.ts"), r"export const JOURNAL_STORAGE ="))
    storage += top_keys(block(read(src / "mdm/model.ts"), r"export const MDM_STORAGE ="))
    tree["plugin storage collections"] = storage

    tree["cron tasks"] = dict(re.findall(r'^\s*"?([a-z-]+)"?:\s*"([^"]+)"', block(read(src / "reconcile.ts"), r"export const TASKS ="), re.M))
    tree["Powerfarm capabilities (authority)"] = top_keys(block(read(src / "authority.ts"), r"export const CAPABILITIES ="))
    tree["settings"] = re.findall(r'label:\s*"([^"]+)"', block(index, r"SETTINGS_SCHEMA[^=]*="))

    onto = read(src / "ontology.ts")
    tree["ontology node types"] = re.findall(r"^\t([a-z_]+):\s*\{\s*domain:", onto, re.M)

    all_src = "".join(read(f) for f in src.rglob("*.ts"))
    # Direct `ctx.x` and the optional-API cast `(ctx as { x?: … }).x`.
    uses = sorted(set(re.findall(r"\bctx\.([a-z]+)\b", all_src)) | set(re.findall(r"\(ctx as \{ ([a-z]+)\?:", all_src)))
    tree["EmDash ctx APIs used"] = uses

    seed = json.loads(read(root / "site/seed/seed.json") or "{}")
    cols = {c.get("slug"): len(c.get("fields", [])) for c in seed.get("collections", [])}
    for mf in sorted((root / "site/seed/migrations").glob("*.json")):
        for c in json.loads(read(mf) or "{}").get("collections", []):
            cols.setdefault(c.get("slug"), len(c.get("fields", [])))
    tree["EmDash collections (seed + migrations): fields"] = cols
    tree["taxonomies (seed)"] = [t.get("name") for t in seed.get("taxonomies", [])]
    return tree


# ---------------------------------------------------------------- output
def render(name: str, node, depth: int = 0) -> list[str]:
    pad = "  " * depth
    out = []
    if isinstance(node, dict):
        out.append(f"{pad}- {name} ({len(node)})")
        for k, v in node.items():
            if isinstance(v, (dict, list)) and not (isinstance(v, dict) and set(v) <= {"files", "lines", "about", "file", "public"}):
                out += render(str(k), v, depth + 1)
            else:
                out.append(f"{pad}  - {k}: {v if not isinstance(v, dict) else ', '.join(f'{a}={b}' for a, b in v.items())}")
    elif isinstance(node, list):
        out.append(f"{pad}- {name} ({len(node)}): {', '.join(map(str, node))}")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--emdash", default=str(ROOT / ".upstream/emdash"))
    ap.add_argument("--out", default=str(ROOT / "docs/generated"))
    a = ap.parse_args()
    base = Path(a.emdash)
    if not (base / "packages/core/src").is_dir():
        print(f"No EmDash checkout at {base}. Run scripts/setup.sh first.", file=sys.stderr)
        return 1
    pin = json.loads(read(ROOT / "upstream/emdash.json"))
    data = {"emdash": {"pin": pin.get("commit"), "version": pin.get("version"), **emdash_tree(base)}, "powerfarm": powerfarm_tree(ROOT)}
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "schema-tree.json").write_text(json.dumps(data, indent=2) + "\n")
    lines = ["# EmDash and Powerfarm: schema trees", "", f"Generated by `scripts/schema-tree.py` from EmDash {pin.get('version')} at `{str(pin.get('commit'))[:7]}`. Do not edit by hand.", ""]
    for name, tree in data.items():
        lines += ["", f"## {name}", ""] + render(name, tree)
    (out / "schema-tree.md").write_text("\n".join(lines) + "\n")
    print(f"Wrote {out}/schema-tree.json and schema-tree.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
