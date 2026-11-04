#!/bin/bash
#
# E2E test: install from an npm package, the way a user would.
#
#   1. `npm pack` ships product, not state
#   2. `npm i -g <tarball>` puts `myjarbis` on the prefix's PATH
#   3. before setup, a command says "not set up" instead of failing deep
#   4. `myjarbis setup` builds the runtime, records the npm channel and
#      registers the MCP server at the RUNTIME path, never the package's
#   5. a second setup is a no-op: no npm install, no second registration
#   6. a package newer than the runtime is reported; setup clears it
#   7. update on the npm channel: a dry run installs nothing, and a package
#      manager that fails leaves the runtime as it was
#   8. a git install moved to npm keeps its registry and flips its channel
#
# Everything runs against a throwaway HOME and npm prefix. Claude Code is a
# stub that records its arguments. The npm install inside the runtime is real
# (better-sqlite3 has to build), with --prefer-offline so a warm cache keeps
# it off the network.
#
# Exits 0 on success, non-zero if any assertion fails.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d -t myjarbis-npm-install-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"

unset MYJARBIS_INSTALL_DIR MYJARBIS_REGISTRY MYJARBIS_HOME MYJARBIS_ASSUME_YES
export npm_config_prefer_offline=true npm_config_audit=false npm_config_fund=false \
       npm_config_update_notifier=false
REAL_NPM="$(command -v npm)"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }
strip() { sed 's/\x1b\[[0-9;]*m//g'; }

# Claude Code stub: `mcp list` reports what `mcp add` registered.
mkdir -p "$WORK/stubs"
cat > "$WORK/stubs/claude" <<'EOF'
#!/bin/bash
echo "$*" >> "$HOME/claude-calls.log"
case "$1 $2" in
  "mcp list") [ -f "$HOME/.mcp-registered" ] && cat "$HOME/.mcp-registered"; exit 0 ;;
  "mcp add")  echo "myjarbis: $4 $5" > "$HOME/.mcp-registered" ;;
esac
exit 0
EOF
# npm stub for [7]: refuses to fetch myjarbis@latest (it is not published
# from here), logs that it was asked, passes everything else through.
cat > "$WORK/stubs/npm" <<EOF
#!/bin/bash
if [ "\$*" = "install -g myjarbis@latest" ]; then
  echo "asked" >> "\$HOME/npm-latest.log"
  echo "npm error 404 myjarbis@latest" >&2
  exit 1
fi
exec "$REAL_NPM" "\$@"
EOF
chmod +x "$WORK/stubs/claude" "$WORK/stubs/npm"

# Runs a command, never failing the suite itself; output in $OUT, status in $STATUS.
run() {
  set +e
  OUT="$("$@" </dev/null 2>&1 | strip)"
  STATUS=${PIPESTATUS[0]}
  set -e
}

# A fresh user: own HOME, own npm prefix, the prefix's bin first on PATH.
new_user() {
  export HOME="$WORK/$1/home"
  export npm_config_prefix="$WORK/$1/prefix"
  mkdir -p "$HOME" "$npm_config_prefix"
  export PATH="$npm_config_prefix/bin:$WORK/stubs:$BASE_PATH"
  RUNTIME="$HOME/.myjarbis-global"
}
BASE_PATH="$PATH"

# ─── [1] pack ─────────────────────────────────────────────────────
echo "→ [1] npm pack ships product, not state"
(cd "$REPO_ROOT" && npm pack --silent --pack-destination "$WORK" >/dev/null 2>&1)
TARBALL="$(ls "$WORK"/myjarbis-*.tgz 2>/dev/null | head -1)"
if [ -z "$TARBALL" ]; then
  oops "npm pack produced no tarball"; exit 1
fi
pass "packed $(basename "$TARBALL")"
CONTENTS="$(tar tzf "$TARBALL")"
if printf '%s\n' "$CONTENTS" | grep -qE '(projects-registry\.json|memory\.db|/\.myjarbis/|node_modules/|/build/)'; then
  oops "the tarball contains state: $(printf '%s\n' "$CONTENTS" | grep -E 'registry|memory\.db|\.myjarbis|node_modules|/build/' | head -3 | tr '\n' ' ')"
else
  pass "no registry, memory.db, .myjarbis/, node_modules/ or build/"
fi
for need in package/bin/myjarbis-setup package/install.sh package/global/mcp-server/src/index.ts; do
  printf '%s\n' "$CONTENTS" | grep -qx "$need" && pass "ships ${need#package/}" || oops "missing ${need#package/}"
done

# ─── [2] global install ───────────────────────────────────────────
echo "→ [2] npm i -g puts myjarbis on the PATH"
new_user a
run npm install -g "$TARBALL"
[ "$STATUS" = 0 ] && pass "npm install -g succeeded" || { oops "npm install -g failed: $OUT"; exit 1; }
WHICH="$(command -v myjarbis || true)"
[ "$WHICH" = "$npm_config_prefix/bin/myjarbis" ] \
  && pass "myjarbis resolves to the prefix's bin link" \
  || oops "myjarbis resolves to '$WHICH'"

# ─── [3] before setup ─────────────────────────────────────────────
echo "→ [3] before setup"
run myjarbis list
[ "$STATUS" != 0 ] && pass "a command exits non-zero" || oops "list succeeded with no runtime"
echo "$OUT" | grep -q "installed but not set up" \
  && pass "and says to run setup" || oops "no 'not set up' message: $OUT"
run myjarbis --version
echo "$OUT" | grep -q "not set up" && pass "--version says so too" || oops "--version: $OUT"

# ─── [4] setup ────────────────────────────────────────────────────
echo "→ [4] myjarbis setup"
mkdir -p "$RUNTIME"
cat > "$RUNTIME/projects-registry.json" <<'EOF'
{ "_version": "1.0", "projects": { "keep-me": { "name": "keep-me", "path": "/nowhere" } } }
EOF
run myjarbis setup --yes --no-projects
[ "$STATUS" = 0 ] && pass "setup exited 0" || { oops "setup failed ($STATUS): $(echo "$OUT" | tail -20)"; exit 1; }
[ -f "$RUNTIME/mcp-server/build/index.js" ] && pass "runtime build present" || oops "no build in the runtime"
[ -x "$RUNTIME/bin/myjarbis" ] && pass "runtime bin/ synced" || oops "no runtime bin/myjarbis"
[ "$(cat "$RUNTIME/.channel" 2>/dev/null)" = "npm" ] && pass ".channel = npm" || oops ".channel = '$(cat "$RUNTIME/.channel" 2>/dev/null)'"
PKG_DIR="$(cd -P "$npm_config_prefix/lib/node_modules/myjarbis" && pwd)"
[ "$(cat "$RUNTIME/.source" 2>/dev/null)" = "$PKG_DIR" ] && pass ".source is the package" || oops ".source = '$(cat "$RUNTIME/.source" 2>/dev/null)'"
node -e "process.exit(require('$RUNTIME/projects-registry.json').projects['keep-me'] ? 0 : 1)" \
  && pass "a pre-existing registry survived" || oops "the registry lost its project"
if grep -q "mcp add myjarbis node $RUNTIME/mcp-server/build/index.js" "$HOME/claude-calls.log" 2>/dev/null; then
  pass "MCP registered at the runtime path"
else
  oops "MCP not registered at the runtime path: $(grep 'mcp add' "$HOME/claude-calls.log" 2>/dev/null)"
fi
grep 'mcp add' "$HOME/claude-calls.log" | grep -q node_modules \
  && oops "MCP registered inside node_modules — breaks on nvm use" \
  || pass "nothing registered inside node_modules"
echo "$OUT" | grep -q "will lose every myjarbis tool" \
  && oops "a fresh install warned about a live session" \
  || pass "no live-session warning on a fresh install"
run myjarbis --version
[ "$OUT" = "MyJarbis v$(node -p "require('$PKG_DIR/package.json').version")" ] \
  && pass "--version: $OUT" || oops "--version: $OUT"

# ─── [5] idempotent ───────────────────────────────────────────────
echo "→ [5] a second setup changes nothing"
ADDS_BEFORE="$(grep -c 'mcp add' "$HOME/claude-calls.log")"
run myjarbis setup --yes --no-projects
[ "$STATUS" = 0 ] && pass "second setup exited 0" || oops "second setup failed: $(echo "$OUT" | tail -10)"
echo "$OUT" | grep -q "npm install skipped" && pass "npm install skipped" || oops "npm install ran again"
echo "$OUT" | grep -q "already registered" && pass "MCP already registered" || oops "no 'already registered'"
[ "$(grep -c 'mcp add' "$HOME/claude-calls.log")" = "$ADDS_BEFORE" ] \
  && pass "no second mcp add" || oops "mcp add ran again"

# ─── [6] drift ────────────────────────────────────────────────────
echo "→ [6] package newer than the runtime"
sed -i.bak 's/"version": "[^"]*"/"version": "99.0.0"/' "$PKG_DIR/package.json" && rm -f "$PKG_DIR/package.json.bak"
run myjarbis list
echo "$OUT" | grep -q "myjarbis 99.0.0 installed, runtime is" \
  && pass "drift hint printed" || oops "no drift hint: $OUT"
[ "$STATUS" = 0 ] && pass "and the command still ran" || oops "the hint broke the command"
run myjarbis setup --yes --no-projects
run myjarbis list
echo "$OUT" | grep -q "runtime is" && oops "hint still there after setup" || pass "setup cleared the hint"
[ "$(cat "$RUNTIME/.version")" = "99.0.0" ] && pass ".version follows the package" || oops ".version = $(cat "$RUNTIME/.version")"

# ─── [7] update on the npm channel ────────────────────────────────
echo "→ [7] myjarbis update on the npm channel"
rm -f "$HOME/npm-latest.log"
run myjarbis update --dry-run --no-projects
[ ! -f "$HOME/npm-latest.log" ] && pass "a dry run did not call the package manager" || oops "a dry run ran npm install"
echo "$OUT" | grep -q "would run: npm install -g myjarbis@latest" \
  && pass "and says what it would run" || oops "dry run: $(echo "$OUT" | head -12)"
BUILD_BEFORE="$(ls -i "$RUNTIME/mcp-server/build/index.js" | awk '{print $1}')"
run myjarbis update --yes --no-projects
[ -f "$HOME/npm-latest.log" ] && pass "update asked npm for myjarbis@latest" || oops "npm was not asked"
[ "$STATUS" != 0 ] && pass "a failed fetch is a failed update" || oops "update exited 0 after npm failed"
echo "$OUT" | grep -q "nothing else was changed" && pass "and says nothing was changed" || oops "update: $(echo "$OUT" | tail -5)"
[ "$(ls -i "$RUNTIME/mcp-server/build/index.js" | awk '{print $1}')" = "$BUILD_BEFORE" ] \
  && pass "the runtime build was left alone" || oops "the build was swapped anyway"

# ─── [8] git → npm ────────────────────────────────────────────────
echo "→ [8] a git install moved to npm"
new_user b
mkdir -p "$RUNTIME"
cat > "$RUNTIME/projects-registry.json" <<'EOF'
{ "_version": "1.0", "projects": { "old-one": { "name": "old-one", "path": "/nowhere" } } }
EOF
run "$REPO_ROOT/bin/myjarbis-setup" --from="$REPO_ROOT" --yes --no-projects
[ "$STATUS" = 0 ] && pass "git-channel setup" || { oops "git setup failed: $(echo "$OUT" | tail -10)"; exit 1; }
[ "$(cat "$RUNTIME/.channel")" = "git" ] && pass ".channel = git" || oops ".channel = $(cat "$RUNTIME/.channel")"
# What the old install.sh left on macOS: `cp -r` of node_modules followed
# the symlinks, so .bin/tsc is a copy of the stub, resolving ../lib/tsc.js
# from .bin. Found on a real machine; every build there failed.
BIN_TSC="$RUNTIME/mcp-server/node_modules/.bin/tsc"
NATIVE="$(find "$RUNTIME/mcp-server/node_modules/better-sqlite3" -name 'better_sqlite3.node' | head -1)"
NATIVE_INODE="$(ls -i "$NATIVE" | awk '{print $1}')"
rm -f "$BIN_TSC" && cp "$RUNTIME/mcp-server/node_modules/typescript/bin/tsc" "$BIN_TSC"
[ -L "$BIN_TSC" ] && oops "could not simulate the copied .bin" || pass "simulated an old install's copied .bin/tsc"
run npm install -g "$TARBALL"
run myjarbis setup --yes --no-projects
[ "$STATUS" = 0 ] && pass "npm setup over a git install" || oops "npm setup failed: $(echo "$OUT" | tail -10)"
[ "$(cat "$RUNTIME/.channel")" = "npm" ] && pass ".channel flipped to npm" || oops ".channel = $(cat "$RUNTIME/.channel")"
echo "$OUT" | grep -q "holds copies, not links" && pass "the copied .bin was detected" || oops "the copied .bin went unnoticed"
[ -L "$BIN_TSC" ] && pass ".bin/tsc is a link again" || oops ".bin/tsc is still a copy"
[ "$(ls -i "$NATIVE" | awk '{print $1}')" = "$NATIVE_INODE" ] \
  && pass "the native module was not rewritten" || oops "better_sqlite3.node was replaced"
node -e "process.exit(require('$RUNTIME/projects-registry.json').projects['old-one'] ? 0 : 1)" \
  && pass "the registry kept its project" || oops "the registry lost its project"

echo
if [ "$FAILED" -gt 0 ]; then
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
echo "✓ npm install: all checks passed"
