#!/bin/bash
#
# E2E test: the user's state lives outside the directory the code lives in.
#
#   1. with nothing yet, the registry resolves under MYJARBIS_HOME
#   2. an installation that still has it in the install dir keeps being read
#   3. with both, the one outside the install dir wins
#   4. MYJARBIS_REGISTRY still overrides both
#   5. bash and TypeScript agree on all four
#   6. `update` moves a legacy registry out, intact, and leaves a copy behind
#   7. `update` moves the brain backups out, without landing on a snapshot of
#      the same name that is already there
#   8. `--dry-run` says it would move them and moves nothing
#
# Why this matters: the registry and the brain backups used to live INSIDE
# ~/.myjarbis-global. That directory is replaced wholesale by an update and
# owned outright by a package manager, so `pnpm up -g` would have taken the
# user's list of projects with it. install.sh already had to rescue the file
# across a reinstall by hand, which was the tell.
#
# The resolution is implemented twice — bin/myjarbis-env.sh for the commands,
# src/org/registry.ts for the server — and [5] is the only thing stopping the
# two from drifting apart.
#
# Exits 0 on success, non-zero if any assertion fails.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$REPO_ROOT/bin/myjarbis-env.sh"
UPDATE="$REPO_ROOT/bin/myjarbis-update"
TS_REGISTRY="$REPO_ROOT/global/mcp-server/build/org/registry.js"

if [ ! -f "$TS_REGISTRY" ]; then
  echo "✗ build not found at $TS_REGISTRY — run: cd global/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-state-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
# Hermetic HOME: this suite is about which directory a path lands in, so the
# real ~/.myjarbis and ~/.myjarbis-global must be out of reach.
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
unset MYJARBIS_REGISTRY

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

# What the two implementations answer, under the env given as VAR=VALUE args.
ask_bash() { env "$@" bash -c '. "$1"; echo "$REGISTRY_FILE"' _ "$LIB"; }
ask_ts()   { env "$@" node --input-type=module -e "
  import { registryPath } from '$TS_REGISTRY';
  console.log(registryPath());
"; }

INSTALL="$WORK/install"; mkdir -p "$INSTALL"
STATE="$WORK/state"
BOTH=(MYJARBIS_INSTALL_DIR="$INSTALL" MYJARBIS_HOME="$STATE")

echo "→ [1] nothing yet"
GOT="$(ask_bash "${BOTH[@]}")"
[ "$GOT" = "$STATE/projects-registry.json" ] \
  && pass "resolves under MYJARBIS_HOME" \
  || oops "expected $STATE/projects-registry.json, got $GOT"

echo "→ [2] only the install dir has one"
printf '{ "projects": { "legacy": { "name": "legacy", "path": "/tmp" } } }\n' \
  > "$INSTALL/projects-registry.json"
GOT="$(ask_bash "${BOTH[@]}")"
[ "$GOT" = "$INSTALL/projects-registry.json" ] \
  && pass "an installation that has not been updated yet is still read" \
  || oops "expected the legacy path, got $GOT"

echo "→ [3] both exist"
mkdir -p "$STATE"
printf '{ "projects": {} }\n' > "$STATE/projects-registry.json"
GOT="$(ask_bash "${BOTH[@]}")"
[ "$GOT" = "$STATE/projects-registry.json" ] \
  && pass "the one outside the install dir wins" \
  || oops "expected the state dir's, got $GOT"

echo "→ [4] the override"
GOT="$(ask_bash "${BOTH[@]}" MYJARBIS_REGISTRY="$WORK/elsewhere.json")"
[ "$GOT" = "$WORK/elsewhere.json" ] \
  && pass "MYJARBIS_REGISTRY beats both" \
  || oops "the override was ignored: got $GOT"

echo "→ [5] bash and TypeScript agree"
AGREED=1
check_agreement() {
  local label="$1"; shift
  local b t
  b="$(ask_bash "$@")"
  t="$(ask_ts "$@")"
  if [ "$b" != "$t" ]; then
    oops "they disagree on $label: bash says $b, TypeScript says $t"
    AGREED=0
  fi
}
rm -f "$STATE/projects-registry.json" "$INSTALL/projects-registry.json"
check_agreement "nothing yet" "${BOTH[@]}"
printf '{ "projects": {} }\n' > "$INSTALL/projects-registry.json"
check_agreement "only the install dir" "${BOTH[@]}"
mkdir -p "$STATE"; printf '{ "projects": {} }\n' > "$STATE/projects-registry.json"
check_agreement "both" "${BOTH[@]}"
check_agreement "the override" "${BOTH[@]}" MYJARBIS_REGISTRY="$WORK/elsewhere.json"
[ "$AGREED" -eq 1 ] && pass "the same answer in all four cases"

# ── a sandbox installation for the real update to move state out of ──────
#
# MYJARBIS_INSTALL_DIR and MYJARBIS_HOME both sit inside $WORK, so a bug here
# cannot reach the real installation. MYJARBIS_REGISTRY is deliberately NOT
# set: it pins the path, which is exactly the thing being moved.
SB="$WORK/sandbox"
SB_INSTALL="$SB/install"
SB_STATE="$SB/state"
SB_SOURCE="$SB/checkout"
mkdir -p "$SB_INSTALL/bin" "$SB_INSTALL/mcp-server" "$SB_INSTALL/backups" \
         "$SB_SOURCE/global/mcp-server" "$SB_SOURCE/bin"
touch "$SB_SOURCE/install.sh"
cp "$REPO_ROOT/bin/myjarbis-env.sh" "$SB_SOURCE/bin/"

# Dependency-free mcp-server so step 4 is a real run that needs no network.
cat > "$SB_SOURCE/global/mcp-server/package.json" <<'PKG'
{
  "name": "sandbox-mcp-server",
  "version": "9.9.9",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "mkdir -p build/db && echo '' > build/index.js && echo 'export const SCHEMA_VERSION = 5;' > build/db/schema.js"
  }
}
PKG

# The legacy state: a registry with two projects, and three brain backups.
printf '{ "projects": { "alpha": { "name": "alpha", "path": "/tmp/alpha" }, "beta": { "name": "beta", "path": "/tmp/beta" } } }\n' \
  > "$SB_INSTALL/projects-registry.json"
echo "snapshot-one"   > "$SB_INSTALL/backups/memory.db.one"
echo "snapshot-two"   > "$SB_INSTALL/backups/memory.db.two"
echo "legacy-clash"   > "$SB_INSTALL/backups/memory.db.clash"
# A snapshot of the same name is ALREADY outside. It must not be overwritten
# by the legacy one: the copy outside is the newer of the two by construction.
mkdir -p "$SB_STATE/backups"
echo "the-one-outside" > "$SB_STATE/backups/memory.db.clash"

run_update() {
  env -u MYJARBIS_REGISTRY \
      MYJARBIS_INSTALL_DIR="$SB_INSTALL" MYJARBIS_HOME="$SB_STATE" \
      bash "$UPDATE" --from="$SB_SOURCE" --no-pull --yes --no-projects "$@" 2>&1
}

echo "→ [8] --dry-run moves nothing"
OUT="$(run_update --dry-run)"
if grep -q "would move the registry out of the install dir" <<<"$OUT" \
   && grep -q "would move 3 brain backup(s)" <<<"$OUT"; then
  pass "the dry run reports both moves"
else
  oops "the dry run did not report the moves: $(grep -i 'would move' <<<"$OUT" || echo none)"
fi
[ -f "$SB_INSTALL/projects-registry.json" ] && [ ! -f "$SB_STATE/projects-registry.json" ] \
  && pass "and wrote nothing" \
  || oops "the dry run moved something"

echo "→ [6] the real run moves the registry out, intact"
OUT="$(run_update)"
RC=$?
[ "$RC" -eq 0 ] || oops "the update failed (rc=$RC): $(tail -5 <<<"$OUT")"
if [ -f "$SB_STATE/projects-registry.json" ]; then
  COUNT="$(node -e "
    const r = JSON.parse(require('fs').readFileSync('$SB_STATE/projects-registry.json','utf8'));
    console.log(Object.keys(r.projects || {}).length);
  ")"
  [ "$COUNT" = "2" ] \
    && pass "both projects arrived at $SB_STATE/projects-registry.json" \
    || oops "the moved registry holds $COUNT project(s), not 2"
else
  oops "the registry was not moved out of the install dir"
fi
grep -q "registry moved out of the install dir" <<<"$OUT" \
  && pass "and the step said so" \
  || oops "the move was silent"
[ -f "$SB_INSTALL/projects-registry.json" ] \
  && pass "a copy stays at the old path for anything not updated yet" \
  || oops "the old path was emptied, so an un-updated reader now sees nothing"

echo "→ [7] the brain backups move too"
[ -f "$SB_STATE/backups/memory.db.one" ] && [ -f "$SB_STATE/backups/memory.db.two" ] \
  && pass "the snapshots are outside the install dir now" \
  || oops "the brain backups did not move"
[ "$(cat "$SB_STATE/backups/memory.db.clash")" = "the-one-outside" ] \
  && pass "a snapshot already outside was not overwritten by the legacy one" \
  || oops "the legacy snapshot landed on top of the one already outside"
[ -f "$SB_INSTALL/backups/memory.db.clash" ] \
  && pass "and the one it could not move stayed where it was" \
  || oops "a snapshot that could not be moved was lost"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ all assertions passed"
else
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
