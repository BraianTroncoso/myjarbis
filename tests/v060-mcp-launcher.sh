#!/bin/bash
#
# E2E test: no project's Claude Code entry carries the location of the code.
#
#   1. the launcher is written where MYJARBIS_HOME is, and runs
#   2. it finds the server through MYJARBIS_INSTALL_DIR, then the recorded
#      install dir, then the default — and says so when it finds nothing
#   3. the code moving does not break it: it is rewritten, and the path
#      ~/.claude.json holds never changed
#   4. `init` registers the launcher, not a path into the install dir
#   5. `update` rewrites an entry that still carries such a path
#   6. and backs ~/.claude.json up before doing it
#   7. and leaves every other MCP server, and every other project, alone
#   8. `--dry-run` reports how many it would rewrite and rewrites none
#   9. an unparseable ~/.claude.json is left untouched, with a warning
#
# Why: `~/.claude.json` recorded `node <install dir>/mcp-server/build/index.js`
# once per project. With 23 projects that is 23 copies of where the code is,
# in a file that belongs to Claude Code — and installing by package manager
# moves the code, so all 23 would have had to be rewritten. They point at one
# generated launcher under MYJARBIS_HOME instead, which no update and no
# package manager replaces. Absolute rather than a bare command on PATH:
# Claude Code is not always started from a shell that has ours.
#
# Exits 0 on success, non-zero if any assertion fails.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$REPO_ROOT/bin/myjarbis-env.sh"
UPDATE="$REPO_ROOT/bin/myjarbis-update"

WORK="$(mktemp -d -t myjarbis-launcher-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false
unset MYJARBIS_REGISTRY

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

jqlike() { node -e "
  const d = JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
  const f = new Function('d', 'return ' + process.argv[2]);
  const v = f(d);
  console.log(v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : v));
" "$1" "$2"; }

# An install dir whose "server" prints a sentinel and its own path, so the
# launcher's resolution can be observed without a real build.
make_fake_install() {
  local dir="$1" tag="$2"
  mkdir -p "$dir/mcp-server/build" "$dir/templates"
  printf 'console.log("SERVER %s");\n' "$tag" > "$dir/mcp-server/build/index.js"
}

INSTALL="$WORK/install"
STATE="$WORK/state"
make_fake_install "$INSTALL" "at-install"

echo "→ [1] the launcher is written under MYJARBIS_HOME and runs"
env MYJARBIS_INSTALL_DIR="$INSTALL" MYJARBIS_HOME="$STATE" bash -c '
  . "$1"; mj_write_mcp_launcher; echo "$MCP_LAUNCHER"' _ "$LIB" > "$WORK/launcher-path"
LAUNCHER="$(cat "$WORK/launcher-path")"
[ "$LAUNCHER" = "$STATE/bin/myjarbis-mcp" ] \
  && pass "written at $LAUNCHER" \
  || oops "expected $STATE/bin/myjarbis-mcp, got $LAUNCHER"
[ -x "$LAUNCHER" ] && pass "and it is executable" || oops "the launcher is not executable"
OUT="$(env -u MYJARBIS_INSTALL_DIR "$LAUNCHER" 2>&1)"
[ "$OUT" = "SERVER at-install" ] \
  && pass "it started the server at the install dir it was written for" \
  || oops "the launcher did not reach the server: $OUT"

echo "→ [2] the order it looks in"
make_fake_install "$WORK/override" "at-override"
OUT="$(MYJARBIS_INSTALL_DIR="$WORK/override" "$LAUNCHER" 2>&1)"
[ "$OUT" = "SERVER at-override" ] \
  && pass "MYJARBIS_INSTALL_DIR first" \
  || oops "the env var was not preferred: $OUT"
make_fake_install "$HOME/.myjarbis-global" "at-default"
mv "$INSTALL" "$INSTALL.moved"
OUT="$(env -u MYJARBIS_INSTALL_DIR "$LAUNCHER" 2>&1)"
[ "$OUT" = "SERVER at-default" ] \
  && pass "then ~/.myjarbis-global, when the recorded one is gone" \
  || oops "the default was not reached: $OUT"
rm -rf "$HOME/.myjarbis-global"
OUT="$(env -u MYJARBIS_INSTALL_DIR "$LAUNCHER" 2>&1)"
grep -q "no MCP server build found" <<<"$OUT" \
  && pass "and with nothing anywhere it says what to run" \
  || oops "a missing build produced: $OUT"
mv "$INSTALL.moved" "$INSTALL"

echo "→ [3] the code moving does not change what Claude Code holds"
BEFORE="$LAUNCHER"
NEW_INSTALL="$WORK/somewhere-else"
make_fake_install "$NEW_INSTALL" "at-new-place"
env MYJARBIS_INSTALL_DIR="$NEW_INSTALL" MYJARBIS_HOME="$STATE" bash -c '
  . "$1"; mj_write_mcp_launcher' _ "$LIB"
OUT="$(env -u MYJARBIS_INSTALL_DIR "$BEFORE" 2>&1)"
if [ "$OUT" = "SERVER at-new-place" ] && [ "$BEFORE" = "$STATE/bin/myjarbis-mcp" ]; then
  pass "same path, new destination — the entries never had to be touched"
else
  oops "after the move the launcher gave: $OUT (path $BEFORE)"
fi

# ── a sandbox installation for the real update ───────────────────────────
SB="$WORK/sandbox"
SB_INSTALL="$SB/install"; SB_STATE="$SB/state"; SB_SOURCE="$SB/checkout"
mkdir -p "$SB_INSTALL/bin" "$SB_INSTALL/mcp-server" \
         "$SB_SOURCE/global/mcp-server" "$SB_SOURCE/bin"
touch "$SB_SOURCE/install.sh"
cp "$REPO_ROOT/bin/myjarbis-env.sh" "$SB_SOURCE/bin/"
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

# Claude Code's file, as an installation that predates the launcher leaves it:
# one project on the old absolute path, one already on a launcher of its own,
# one with another MCP server beside ours, and one with no myjarbis at all.
SB_LAUNCHER="$SB_STATE/bin/myjarbis-mcp"
cat > "$HOME/.claude.json" <<EOF
{
  "numStartups": 7,
  "projects": {
    "/code/alpha": {
      "mcpServers": {
        "myjarbis": {
          "type": "stdio",
          "command": "node",
          "args": ["$HOME/.myjarbis-global/mcp-server/build/index.js"],
          "env": {}
        }
      }
    },
    "/code/beta": {
      "mcpServers": {
        "tracker": { "type": "stdio", "command": "tracker-mcp", "args": [] },
        "myjarbis": {
          "type": "stdio",
          "command": "node",
          "args": ["$HOME/.myjarbis-global/mcp-server/build/index.js"],
          "env": {}
        }
      }
    },
    "/code/gamma": {
      "mcpServers": {
        "something-else": { "type": "stdio", "command": "else-mcp", "args": [] }
      }
    }
  }
}
EOF
cp "$HOME/.claude.json" "$WORK/claude.json.pristine"

run_update() {
  env -u MYJARBIS_REGISTRY \
      MYJARBIS_INSTALL_DIR="$SB_INSTALL" MYJARBIS_HOME="$SB_STATE" \
      bash "$UPDATE" --from="$SB_SOURCE" --no-pull --yes --no-projects "$@" 2>&1
}

echo "→ [8] --dry-run reports and writes nothing"
OUT="$(run_update --dry-run)"
grep -q "would point 2 project(s) in ~/.claude.json at it" <<<"$OUT" \
  && pass "it counted the two entries that carry a path into the install dir" \
  || oops "the dry run did not report 2: $(grep -i 'would point' <<<"$OUT" || echo none)"
diff -q "$HOME/.claude.json" "$WORK/claude.json.pristine" >/dev/null \
  && pass "and changed nothing" \
  || oops "the dry run modified ~/.claude.json"

echo "→ [5] the real run rewrites them"
OUT="$(run_update)"
grep -q "2 project(s) now start the server through $SB_LAUNCHER" <<<"$OUT" \
  && pass "the step reported both" \
  || oops "the rewrite was not reported: $(grep -i 'start the server' <<<"$OUT" || echo none)"
[ "$(jqlike "$HOME/.claude.json" 'd.projects["/code/alpha"].mcpServers.myjarbis.command')" = "$SB_LAUNCHER" ] \
  && pass "alpha points at the launcher" \
  || oops "alpha still has $(jqlike "$HOME/.claude.json" 'd.projects["/code/alpha"].mcpServers.myjarbis.command')"
[ "$(jqlike "$HOME/.claude.json" 'd.projects["/code/alpha"].mcpServers.myjarbis.args')" = "[]" ] \
  && pass "and carries no path in its args" \
  || oops "alpha kept args: $(jqlike "$HOME/.claude.json" 'd.projects["/code/alpha"].mcpServers.myjarbis.args')"

echo "→ [6] the file was backed up first"
BAKS=$( (ls "$HOME"/.claude.json.bak-* 2>/dev/null || true) | wc -l | tr -d ' ')
[ "$BAKS" = "1" ] \
  && pass "one backup, in the .bak-<ms> naming gc already uses" \
  || oops "expected 1 backup, found $BAKS"

echo "→ [7] nothing else was touched"
[ "$(jqlike "$HOME/.claude.json" 'd.projects["/code/beta"].mcpServers.tracker.command')" = "tracker-mcp" ] \
  && pass "beta's other MCP server is still registered" \
  || oops "the project's other MCP server was dropped — the v0.5.2 bug, again"
[ "$(jqlike "$HOME/.claude.json" 'd.projects["/code/gamma"].mcpServers["something-else"].command')" = "else-mcp" ] \
  && pass "a project without myjarbis was left alone" \
  || oops "gamma was modified"
[ "$(jqlike "$HOME/.claude.json" 'd.numStartups')" = "7" ] \
  && pass "and Claude Code's own keys survived" \
  || oops "a top-level key of ~/.claude.json was lost"

echo "    · and running it again is a no-op"
OUT="$(run_update)"
grep -q "now start the server through" <<<"$OUT" \
  && oops "a second run rewrote entries that were already correct" \
  || pass "the second run found nothing to rewrite"
BAKS=$( (ls "$HOME"/.claude.json.bak-* 2>/dev/null || true) | wc -l | tr -d ' ')
[ "$BAKS" = "1" ] \
  && pass "and left no second backup" \
  || oops "a no-op run still backed the file up ($BAKS copies)"

echo "→ [9] an unparseable ~/.claude.json"
printf '{ "projects": { oops\n' > "$HOME/.claude.json"
OUT="$(run_update)"
grep -q "does not parse" <<<"$OUT" \
  && pass "it says so" \
  || oops "an unparseable file produced no warning: $(tail -3 <<<"$OUT")"
grep -q "oops" "$HOME/.claude.json" \
  && pass "and left the file exactly as it was" \
  || oops "the unparseable file was rewritten"

echo "→ [4] init registers the launcher, not a path into the install dir"
# Static: the one line that writes the entry must not name the build.
grep -q "MYJARBIS_MCP_LAUNCHER" "$REPO_ROOT/bin/myjarbis-init" \
  && pass "init takes the command from the launcher variable" \
  || oops "init no longer registers through the launcher"
grep -q "args': \[os.path.expanduser" "$REPO_ROOT/bin/myjarbis-init" \
  && oops "init still writes an absolute path into args" \
  || pass "and writes no absolute path into args"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ all assertions passed"
else
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
