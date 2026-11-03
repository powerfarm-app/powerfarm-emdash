#!/usr/bin/env bash
# Test Powerfarm on this machine exactly as CI does, with a summary at the end.
#
#   bash scripts/test.sh           everything: quick tests, then the full build on pinned EmDash
#   bash scripts/test.sh --quick   only the quick tests (a few seconds, no EmDash build)
#
# Needs Node.js 22.16+, git and internet access to GitHub and the npm registry.
# Works with macOS's bash 3.2. Writes a full log to .upstream/test-<time>.log.
# Exit code 0 only if every step passed.
set -uo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
QUICK=0
[[ "${1:-}" == "--quick" ]] && QUICK=1

mkdir -p .upstream
LOG="$HERE/.upstream/test-$(date +%Y%m%d-%H%M%S).log"
: > "$LOG"
NAMES=()
RESULTS=()
FAILED=0

step() {
	# step "<name>" <command...>: run it, keep its output in the log, record the result.
	local name="$1"; shift
	printf '%-58s ' "$name"
	local start=$SECONDS
	if ( "$@" ) >>"$LOG" 2>&1; then
		echo "PASS  ($((SECONDS - start))s)"; RESULTS+=("PASS")
	else
		echo "FAIL  ($((SECONDS - start))s)  -> see $LOG"; RESULTS+=("FAIL"); FAILED=1
	fi
	NAMES+=("$name")
	echo "----- end of: $name" >>"$LOG"
}

prereqs() {
	command -v node >/dev/null || { echo "node not found"; return 1; }
	command -v git >/dev/null || { echo "git not found"; return 1; }
	node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=16)?0:1)' \
		|| { echo "Node.js 22.16+ required, found $(node -v)"; return 1; }
	echo "node $(node -v), git $(git --version)"
}

zod() {
	# The route tests import astro/zod. Outside EmDash's workspace, use zod 4.5.4 (EmDash's catalog pin).
	if [[ -n "${POWERFARM_ZOD:-}" ]]; then echo "using POWERFARM_ZOD=$POWERFARM_ZOD"; return 0; fi
	local dir="$HERE/.upstream/zod"
	mkdir -p "$dir"
	npm install --prefix "$dir" --no-save --ignore-scripts --no-audit --no-fund zod@4.5.4 || return 1
	(cd "$dir" && node --input-type=module -e "console.log(new URL(import.meta.resolve('zod')).pathname)") > "$HERE/.upstream/zod-path" || return 1
}

plugin_tests() {
	export POWERFARM_ZOD="${POWERFARM_ZOD:-$(cat "$HERE/.upstream/zod-path")}"
	cd "$HERE/plugin" && node --import ./test/ts-resolve.mjs --experimental-strip-types --no-warnings --test test/*.test.ts
}

bridge_tests() { cd "$HERE/mac/bridge" && node --test test/*.test.mjs; }

scripts_parse() { for f in "$HERE"/scripts/*.mjs; do node --check "$f" || return 1; done; bash -n "$HERE/scripts/setup.sh"; }

full_build() { bash "$HERE/scripts/setup.sh"; }

echo "Powerfarm test run — log: $LOG"
echo
step "Prerequisites (Node 22.16+, git)" prereqs
if [[ ${RESULTS[0]} == "PASS" ]]; then
	step "Zod for the route tests" zod
	step "Plugin tests (Identity, MDM, release gate, OIDC, seals)" plugin_tests
	step "Mac bridge tests" bridge_tests
	step "Scripts parse" scripts_parse
	if [[ $QUICK -eq 0 ]]; then
		echo
		echo "Full build on pinned EmDash (fetch, patches, install, build, all checks)."
		echo "The first run downloads EmDash and its packages: allow 10–30 minutes."
		step "EmDash at the pin + patches + build + all checks" full_build
	fi
fi

echo
echo "Summary"
i=0
while [[ $i -lt ${#NAMES[@]} ]]; do
	printf '  %-5s %s\n' "${RESULTS[$i]}" "${NAMES[$i]}"
	i=$((i + 1))
done
if [[ $FAILED -eq 0 ]]; then
	echo
	echo "All passed."
else
	echo
	echo "Something failed. The log has the full output: $LOG"
	echo "Hints: a 'PATCH CONFLICT' means EmDash moved under a patch (docs/UPSTREAM.md);"
	echo "'changed EmDash's dependency set' means a package was added that EmDash does not lock."
fi
exit $FAILED
