#!/bin/bash
#
# E2E test: MYJARBIS_REGISTRY overrides the registry location everywhere.
#
#   1. no bin/ script that reads the registry builds its path from the
#      install dir alone
#   2. `start` lists the projects of the registry the override names
#   3. `doctor` checks registration against that same registry
#
# doctor and start used to build "$INSTALL_DIR/projects-registry.json" by
# hand and ignore the override. A hermetic run points MYJARBIS_REGISTRY at
# its own fixture while leaving MYJARBIS_INSTALL_DIR on a real-looking
# install, so both scripts reached past the fixture and reported on whatever
# registry the developer's machine had — a test that read production state
# and a `start` that offered projects the caller had excluded.
#
# Exits 0 on success, non-zero if any assertion fails.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
START="$REPO_ROOT/bin/myjarbis-start"
DOCTOR="$REPO_ROOT/bin/myjarbis-doctor"

WORK="$(mktemp -d -t myjarbis-registry-override-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
unset TMUX WSL_DISTRO_NAME

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

# Two registries that disagree. The override names one, the install dir
# holds the other; every assertion below asks which one won.
export MYJARBIS_INSTALL_DIR="$WORK/install"; mkdir -p "$MYJARBIS_INSTALL_DIR"
export MYJARBIS_REGISTRY="$WORK/fixture-registry.json"

mkdir -p "$WORK/p/fixture-only" "$WORK/p/install-only"
cat > "$MYJARBIS_REGISTRY" <<EOF
{
  "projects": {
    "fixture-only": { "name": "fixture-only", "path": "$WORK/p/fixture-only", "framework": "generic" }
  }
}
EOF
cat > "$MYJARBIS_INSTALL_DIR/projects-registry.json" <<EOF
{
  "projects": {
    "install-only": { "name": "install-only", "path": "$WORK/p/install-only", "framework": "generic" }
  }
}
EOF

echo "→ [1] no bin/ script builds the registry path from the install dir alone"
# Comment lines are skipped: naming the file in prose is fine.
HITS="$(grep -nE '[^{]INSTALL_DIR[^}]*/projects-registry\.json' \
  "$REPO_ROOT"/bin/* 2>/dev/null \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' \
  | grep -vE 'MYJARBIS_REGISTRY:-' || true)"
if [ -z "$HITS" ]; then
  pass "every reader goes through MYJARBIS_REGISTRY first"
else
  oops "registry path built without the override:"
  echo "$HITS" | sed 's/^/        /' >&2
fi

echo "→ [2] start reads the registry the override names"
set +e
OUT="$("$START" --json </dev/null 2>&1)"
STATUS=$?
set -e
if [ "$STATUS" -eq 0 ] && grep -q "fixture-only" <<<"$OUT" && ! grep -q "install-only" <<<"$OUT"; then
  pass "start lists fixture-only and not install-only"
else
  oops "start did not honour MYJARBIS_REGISTRY (exit $STATUS): $OUT"
fi

echo "→ [3] doctor checks registration against the override"
# A project whose name is in the fixture registry and absent from the
# install dir's. doctor only reaches the check inside a project.
PROJ="$WORK/p/fixture-only"
mkdir -p "$PROJ/.myjarbis/config"
cat > "$PROJ/.myjarbis/config/settings.json" <<'EOF'
{ "name": "fixture-only", "framework": "generic" }
EOF
set +e
OUT="$(cd "$PROJ" && "$DOCTOR" </dev/null 2>&1)"
STATUS=$?
set -e
if grep -q "registered in global registry" <<<"$OUT" \
   && ! grep -q "not registered in global registry" <<<"$OUT"; then
  pass "doctor finds fixture-only registered"
else
  oops "doctor read past the override (exit $STATUS): $(grep -m1 -i 'registry' <<<"$OUT" || true)"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ all assertions passed"
else
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
