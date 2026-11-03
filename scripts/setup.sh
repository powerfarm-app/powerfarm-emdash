#!/usr/bin/env bash
# Build Powerfarm on the EmDash it is pinned to. Used by people and by CI alike.
#
#   scripts/setup.sh [TARGET_DIR] [--ref <commit-or-tag>] [--skip-build] [--skip-checks]
#
# TARGET_DIR (default ./.upstream/emdash, git-ignored) gets EmDash at the commit in
# upstream/emdash.json (or --ref, used only by the upstream check), Powerfarm's two
# patches (upstream/patches/*.patch), and this repository linked in as
# TARGET_DIR/powerfarm (plugin, site and mac/bridge as workspace packages).
#
# EmDash is never copied into this repository and never upgraded here: the pin
# changes only in a reviewed PR (docs/UPSTREAM.md).
#
# Rules this script enforces:
#   - packages/core must report the version in the pin;
#   - every patch must apply (3-way when upstream moved around it); a conflict stops;
#   - Powerfarm adds no third-party package to EmDash's lockfile
#     (scripts/check-lockfile.mjs): the dependency set is EmDash's own, reviewed upstream.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$HERE/.upstream/emdash"
REF=""
BUILD=1
CHECKS=1
while [[ $# -gt 0 ]]; do
	case "$1" in
		--ref) REF="$2"; shift 2 ;;
		--skip-build) BUILD=0; CHECKS=0; shift ;;
		--skip-checks) CHECKS=0; shift ;;
		-*) echo "Unknown option $1" >&2; exit 2 ;;
		*) TARGET="$1"; shift ;;
	esac
done

# The registry occasionally times out on one of the ~2,000 packages EmDash's pnpm
# verifies against its supply-chain policy. Installs are idempotent: retry them.
retry() {
	local n=1
	until "$@"; do
		[[ $n -ge 3 ]] && { echo "Failed after $n attempts: $*" >&2; return 1; }
		echo "Registry error; retrying in $((n * 30))s (attempt $((n + 1)) of 3): $*" >&2
		sleep $((n * 30)); n=$((n + 1))
	done
}
export npm_config_fetch_retries="${npm_config_fetch_retries:-5}"
export npm_config_fetch_timeout="${npm_config_fetch_timeout:-120000}"

pin() { node -e "process.stdout.write(String(require('$HERE/upstream/emdash.json')['$1']))"; }
REPO="$(pin repository)"
COMMIT="${REF:-$(pin commit)}"
VERSION="$(pin version)"

need() { command -v "$1" >/dev/null || { echo "Missing $1. $2" >&2; exit 1; }; }
need node "Install Node.js 22.16 or newer."
need git "Install git."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=16)?0:1)' \
	|| { echo "Node.js 22.16+ is required (found $(node -v))." >&2; exit 1; }
command -v pnpm >/dev/null || { echo "Enabling pnpm through corepack"; corepack enable; }

echo "EmDash: $REPO @ $COMMIT"
if [[ -n "${EMDASH_SOURCE:-}" ]]; then
	# Offline: an existing EmDash tree at the pinned commit (for example an unpacked release).
	mkdir -p "$TARGET"
	cp -a "$EMDASH_SOURCE/." "$TARGET/"
	[[ -d "$TARGET/.git" ]] || git -C "$TARGET" init --quiet
else
	mkdir -p "$TARGET"
	[[ -d "$TARGET/.git" ]] || git -C "$TARGET" init --quiet
	git -C "$TARGET" remote get-url origin >/dev/null 2>&1 || git -C "$TARGET" remote add origin "$REPO"
	git -C "$TARGET" fetch --quiet --depth 1 origin "$COMMIT"
	git -C "$TARGET" checkout --quiet --force FETCH_HEAD
	git -C "$TARGET" clean --quiet -fdx -e node_modules -e powerfarm
fi

if [[ -z "$REF" ]]; then
	grep -q "\"version\": \"$VERSION\"" "$TARGET/packages/core/package.json" \
		|| { echo "packages/core is not emdash $VERSION. The pin in upstream/emdash.json and the checkout disagree. Stopping." >&2; exit 1; }
fi

echo "Applying Powerfarm's patches"
git -C "$TARGET" config user.email "ci@powerfarm.invalid"
git -C "$TARGET" config user.name "Powerfarm setup"
for p in "$HERE"/upstream/patches/*.patch; do
	name="$(basename "$p")"
	if git -C "$TARGET" apply --reverse --check "$p" 2>/dev/null; then
		echo "  already applied: $name"
	elif git -C "$TARGET" apply --check "$p" 2>/dev/null; then
		git -C "$TARGET" apply "$p"; echo "  applied: $name"
	elif git -C "$TARGET" apply --3way "$p" 2>/dev/null; then
		echo "  applied with a 3-way merge (upstream moved around it): $name — refresh the patch file (docs/UPSTREAM.md)"
	else
		echo "PATCH CONFLICT: $name no longer applies to EmDash $COMMIT." >&2
		echo "Either upstream now does what the patch did (drop it), or the patch must be rewritten (docs/UPSTREAM.md, 'When code overlaps')." >&2
		exit 3
	fi
done

link_powerfarm() {
	echo "Linking Powerfarm into the workspace"
	rm -rf "$TARGET/powerfarm"
	mkdir -p "$TARGET/powerfarm"
	for part in plugin site mac scripts docs upstream deploy README.md; do
		[[ -e "$HERE/$part" ]] && cp -a "$HERE/$part" "$TARGET/powerfarm/$part"
	done
	rm -rf "$TARGET/powerfarm/site/node_modules" "$TARGET/powerfarm/plugin/node_modules" "$TARGET/powerfarm/mac/bridge/node_modules"
	if ! grep -q '^  - powerfarm/plugin$' "$TARGET/pnpm-workspace.yaml"; then
		awk '{print} /^packages:/ && !done {print "  - powerfarm/plugin\n  - powerfarm/site\n  - powerfarm/mac/bridge"; done=1}' "$TARGET/pnpm-workspace.yaml" > "$TARGET/pnpm-workspace.yaml.tmp"
		mv "$TARGET/pnpm-workspace.yaml.tmp" "$TARGET/pnpm-workspace.yaml"
	fi
}

if [[ $BUILD -eq 0 ]]; then
	link_powerfarm
	echo "Prepared $TARGET (no install or build)."
	exit 0
fi

cd "$TARGET"
# Baseline: EmDash's dependency set as pnpm resolves it on EmDash's own tree, before
# Powerfarm is linked in. (EmDash's committed lockfile can lag its package.json files
# between releases, so the committed file alone is not a fair baseline.)
rm -rf "$TARGET/powerfarm"
git checkout --quiet -- pnpm-workspace.yaml pnpm-lock.yaml
retry pnpm install --lockfile-only --no-frozen-lockfile
cp pnpm-lock.yaml .baseline-lock.yaml
if ! cmp -s .baseline-lock.yaml <(git show HEAD:pnpm-lock.yaml); then
	echo "Note: EmDash's committed lockfile is not in sync with its package files at this commit; using pnpm's resolution of EmDash's own tree as the baseline."
fi

link_powerfarm
# The lockfile gains importer entries for Powerfarm's packages, so it cannot be frozen;
# check-lockfile.mjs then proves Powerfarm added or changed no package.
retry pnpm install --no-frozen-lockfile
node "$HERE/scripts/check-lockfile.mjs" .baseline-lock.yaml pnpm-lock.yaml
pnpm build
# pnpm links a package's bin only if its target exists at install time, and EmDash's
# CLI (packages/core/dist/cli) exists only after the build; a second install reports
# "Already up to date" and links nothing. So link the CLI explicitly where Powerfarm
# and the people running it need it, and put it on PATH for the checks below.
CLI="$TARGET/packages/core/dist/cli/index.mjs"
[[ -f "$CLI" ]] || { echo "EmDash's CLI was not built ($CLI)." >&2; exit 1; }
for bindir in "$TARGET/node_modules/.bin" "$TARGET/powerfarm/site/node_modules/.bin" "$TARGET/powerfarm/plugin/node_modules/.bin"; do
	mkdir -p "$bindir"
	for name in emdash em; do
		printf '#!/bin/sh\nexec node "%s" "$@"\n' "$CLI" > "$bindir/$name"
		chmod +x "$bindir/$name"
	done
done
export PATH="$TARGET/node_modules/.bin:$PATH"
emdash --version >/dev/null 2>&1 || emdash --help >/dev/null 2>&1 || { echo "EmDash's CLI does not run." >&2; exit 1; }

[[ $CHECKS -eq 1 ]] || { echo "Built $TARGET."; exit 0; }

echo
echo "Checks"
(cd packages/core && pnpm vitest run tests/unit/middleware/private-media.test.ts tests/unit/plugins/content-create-references.test.ts)
(cd powerfarm/plugin && pnpm test)
(cd powerfarm/plugin && pnpm typecheck)
(cd powerfarm/mac/bridge && pnpm test)
(cd powerfarm/site && pnpm seed:validate && pnpm seed:validate:migration)
(cd powerfarm/site && pnpm cf:types)
(cd powerfarm/site && pnpm typecheck)
(cd powerfarm/site && pnpm build)
(cd powerfarm/site && pnpm doctor || true)   # scheduler wiring; its local-database check does not apply to D1

cat <<EOF

Built and checked for Cloudflare in $TARGET. First live deploy: docs/DEPLOYMENT-CLOUDFLARE.md.
EOF
