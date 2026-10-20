#!/bin/bash
#
# E2E test: Claude Code hook wiring.
#
# The bug this covers: `init` used to copy .claude-plugin/ into the
# project and stop there. Claude Code only reads a plugin's hooks.json
# for plugins installed from a marketplace, and never auto-discovers a
# .claude-plugin/ directory in the working tree — so every project
# MyJarbis initialised had all four events dead. The scripts worked when
# run by hand, which is why `doctor` kept passing green: it asserted the
# files existed, never that anything ran them.
#
# What binds them is a hooks block in .claude/settings.local.json. That
# file also holds the user's permission allowlist, so most of the
# assertions here are about what the wiring must NOT do:
#
#   · unrelated keys (permissions, env) survive untouched.
#   · hooks the user added themselves survive, including on an event we
#     also bind.
#   · malformed JSON is refused rather than overwritten — a blind rewrite
#     would silently discard real configuration.
#   · re-running is a no-op, not a second copy of every entry.
#
# Plus the check that would have caught the original bug: doctor must
# warn when the scripts are present but nothing is wired.
#
# Exits 0 on success, non-zero on the first failed assertion.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$B/cli.js"

if [ ! -f "$CLI" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-hookwire-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export HOME="$WORK/home"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

# Reads one value out of the settings file with node, so the assertions
# never depend on jq being installed.
q() { node -e "
const s = JSON.parse(require('fs').readFileSync('$1/.claude/settings.local.json','utf8'));
$2
"; }

mkdir -p "$WORK/proj" && cd "$WORK/proj" && git init -q .
git config user.email t@example.com && git config user.name Test
"$MJ" init --yes --skip-memory >/dev/null 2>&1
P="$WORK/proj"

# ── [1] init wires the hooks, not just the scripts ────────────────
echo "[1] init leaves the hooks bound"

if [ -f "$P/.claude/settings.local.json" ]; then
  pass "init created .claude/settings.local.json"
else
  oops "init did not create .claude/settings.local.json"
fi

EVENTS=$(q "$P" 'console.log(Object.keys(s.hooks||{}).sort().join(","))' 2>/dev/null || echo "")
if [ "$EVENTS" = "SessionEnd,SessionStart,Stop,UserPromptSubmit" ]; then
  pass "all four events bound: $EVENTS"
else
  oops "expected the four lifecycle events, got: '$EVENTS'"
fi

# SessionStart carries two entries (startup|clear and compact), which is
# the case a naive "one entry per event" writer would collapse.
SS=$(q "$P" 'console.log((s.hooks.SessionStart||[]).length)' 2>/dev/null || echo 0)
if [ "$SS" = "2" ]; then
  pass "SessionStart has both matchers (startup|clear and compact)"
else
  oops "SessionStart should have 2 entries, has $SS"
fi

# ── [2] every bound command actually runs ─────────────────────────
echo "[2] each wired command executes"

COUNT=0
while IFS= read -r cmd; do
  COUNT=$((COUNT + 1))
  # CLAUDE_PROJECT_DIR has to be exported, not prefixed: Claude Code puts
  # it in the hook's environment, and a `VAR=x echo ... | eval` prefix
  # would scope it to the echo and leave the eval expanding it to "".
  if ( cd "$P" && export CLAUDE_PROJECT_DIR="$P" && echo '{"source":"startup"}' | eval "$cmd" ) >/dev/null 2>&1; then
    pass "runs: $(basename "${cmd%\"}")"
  else
    oops "wired command failed: $cmd"
  fi
done < <(q "$P" '
for (const arr of Object.values(s.hooks||{})) for (const e of arr) for (const h of e.hooks) console.log(h.command);
' 2>/dev/null || true)
if [ "$COUNT" = "5" ]; then
  pass "all 5 scripts are reachable through the wiring"
else
  oops "expected 5 wired commands, found $COUNT"
fi

# Guard the unit, not just the presence: `timeout` is in seconds, and the
# hooks.json this replaced said 10000, which reads as nearly three hours.
MAXT=$(q "$P" '
let m=0; for (const arr of Object.values(s.hooks||{})) for (const e of arr) for (const h of e.hooks) m=Math.max(m,h.timeout||0);
console.log(m);
' 2>/dev/null || echo 0)
if [ "$MAXT" -le 60 ]; then
  pass "timeouts are in seconds (max ${MAXT}s)"
else
  oops "timeout looks like milliseconds: ${MAXT}"
fi

# ── [3] the merge is not destructive ──────────────────────────────
echo "[3] unrelated settings and the user's own hooks survive"

node -e "
const f='$P/.claude/settings.local.json';
const s=JSON.parse(require('fs').readFileSync(f,'utf8'));
s.env={MY_VAR:'keepme'};
s.hooks.Stop.push({hooks:[{type:'command',command:'echo my-own-stop-hook'}]});
s.hooks.PostToolUse=[{matcher:'Write',hooks:[{type:'command',command:'prettier --write'}]}];
require('fs').writeFileSync(f, JSON.stringify(s,null,2)+'\n');
"
PERMS_BEFORE=$(q "$P" 'console.log(JSON.stringify(s.permissions||null))')
( cd "$P" && node "$CLI" hook install claude ) >/dev/null 2>&1

if [ "$(q "$P" 'console.log(JSON.stringify(s.permissions||null))')" = "$PERMS_BEFORE" ]; then
  pass "permissions block unchanged"
else
  oops "permissions block was altered by re-wiring"
fi
if [ "$(q "$P" 'console.log((s.env||{}).MY_VAR)')" = "keepme" ]; then
  pass "unrelated env key preserved"
else
  oops "unrelated env key was dropped"
fi
if [ "$(q "$P" 'console.log(((s.hooks.PostToolUse||[])[0]||{}).matcher)')" = "Write" ]; then
  pass "hook on an event we do not bind left alone"
else
  oops "PostToolUse hook was dropped"
fi
if q "$P" '
const own=(s.hooks.Stop||[]).filter(e=>e.hooks.some(h=>h.command==="echo my-own-stop-hook"));
process.exit(own.length===1?0:1);
'; then
  pass "the user's own Stop hook survived alongside ours"
else
  oops "re-wiring destroyed the user's own Stop hook"
fi

# ── [4] idempotent ────────────────────────────────────────────────
echo "[4] re-running does not duplicate entries"

cp "$P/.claude/settings.local.json" "$WORK/once.json"
( cd "$P" && node "$CLI" hook install claude ) >/dev/null 2>&1
( cd "$P" && node "$CLI" hook install claude ) >/dev/null 2>&1
if diff -q "$WORK/once.json" "$P/.claude/settings.local.json" >/dev/null; then
  pass "two further runs left the file byte-identical"
else
  oops "re-running changed the file: $(diff "$WORK/once.json" "$P/.claude/settings.local.json" | head -5)"
fi

# ── [5] malformed JSON is refused, never overwritten ──────────────
echo "[5] a broken settings file is left for the user to fix"

printf '{ "permissions": { "allow": [ "Bash(npm *)" ]\n' > "$P/.claude/settings.local.json"
BROKEN=$(cat "$P/.claude/settings.local.json")
if ( cd "$P" && node "$CLI" hook install claude ) >/dev/null 2>&1; then
  oops "wiring reported success over malformed JSON"
else
  pass "refused with a non-zero exit"
fi
if [ "$(cat "$P/.claude/settings.local.json")" = "$BROKEN" ]; then
  pass "the malformed file was not rewritten"
else
  oops "the malformed file was overwritten — user config lost"
fi

# Put it back for the remaining sections.
rm -f "$P/.claude/settings.local.json"
( cd "$P" && node "$CLI" hook install claude ) >/dev/null 2>&1

# ── [6] --check reports without writing ───────────────────────────
echo "[6] --check is read-only"

if ( cd "$P" && node "$CLI" hook install claude --check ) | grep -q WIRED; then
  pass "--check reports WIRED on a wired project"
else
  oops "--check did not report WIRED"
fi

node -e "
const f='$P/.claude/settings.local.json';
const s=JSON.parse(require('fs').readFileSync(f,'utf8'));
delete s.hooks;
require('fs').writeFileSync(f, JSON.stringify(s,null,2)+'\n');
"
if ( cd "$P" && node "$CLI" hook install claude --check ) >/dev/null 2>&1; then
  oops "--check reported success on an unwired project"
else
  pass "--check exits non-zero when nothing is wired"
fi
if q "$P" 'process.exit(s.hooks===undefined?0:1)'; then
  pass "--check wrote nothing"
else
  oops "--check modified the file"
fi

# ── [7] doctor catches the original bug ───────────────────────────
echo "[7] doctor warns when scripts are present but unwired"

# Still unwired from [6], and the scripts are all on disk.
DOC=$( cd "$P" && "$REPO_ROOT/bin/myjarbis-doctor" 2>&1 || true )
if echo "$DOC" | grep -q "NOT wired"; then
  pass "doctor warns about the unwired scripts"
else
  oops "doctor stayed silent — this is exactly the blind spot that hid the bug"
fi
if echo "$DOC" | grep -q "5 hook scripts present"; then
  pass "doctor counts all five scripts (session-end.sh was missing from the list)"
else
  oops "doctor does not count five hook scripts"
fi

( cd "$P" && node "$CLI" hook install claude ) >/dev/null 2>&1
DOC=$( cd "$P" && "$REPO_ROOT/bin/myjarbis-doctor" 2>&1 || true )
if echo "$DOC" | grep -q "hooks wired into"; then
  pass "doctor passes once the hooks are wired"
else
  oops "doctor does not confirm the wiring: $(echo "$DOC" | grep -i hook)"
fi

# ── [8] the wiring leaves nothing to commit ───────────────────────
echo "[8] a user's repo stays clean"

cd "$P"
if [ -z "$(git status --porcelain -- .claude/settings.local.json)" ]; then
  pass ".claude/settings.local.json is gitignored"
else
  oops "the wiring dirtied the user's git status: $(git status --porcelain -- .claude/settings.local.json)"
fi

# ── [9] the two declarations of the wiring cannot drift ───────────
#
# The bindings are written down twice: CLAUDE_HOOKS in
# global/mcp-server/src/hooks.ts, which is what `hook install claude`
# actually writes into settings, and templates/.claude-plugin/hooks/hooks.json,
# which is copied into every project and is the fingerprint `update` compares
# to decide a project's hooks are stale.
#
# Claude Code never reads that hooks.json — that was the original bug — so
# drift between them is invisible twice over: the binding keeps working, and
# the staleness check keeps saying "current" while the two disagree about what
# current means. Adding a matcher to one and not the other would ship a hook
# that fires for a source no project is ever told about.
#
# Same guard the SHIPPED_COMMANDS list gets in v04-commands-sync, for the same
# reason: a list maintained by hand in two files needs a test, not discipline.
echo "[9] hooks.ts and the template hooks.json declare the same bindings"

if node --input-type=module -e "
  import { CLAUDE_HOOKS, hookCommand } from '$B/hooks.js';
  import * as fs from 'fs';
  const tpl = JSON.parse(fs.readFileSync(
    '$MYJARBIS_INSTALL_DIR/templates/.claude-plugin/hooks/hooks.json', 'utf-8'));

  const fromTemplate = [];
  for (const [event, entries] of Object.entries(tpl.hooks || {})) {
    for (const entry of entries) {
      for (const h of entry.hooks || []) {
        fromTemplate.push([event, entry.matcher ?? '', h.command, h.timeout].join(' · '));
      }
    }
  }
  const fromCode = CLAUDE_HOOKS.map(
    (h) => [h.event, h.matcher ?? '', hookCommand(h.script), h.timeout].join(' · '),
  );

  const missing = fromCode.filter((x) => !fromTemplate.includes(x));
  const extra = fromTemplate.filter((x) => !fromCode.includes(x));
  if (missing.length || extra.length) {
    console.error('in hooks.ts but not in the template:\n  ' + (missing.join('\n  ') || '(none)'));
    console.error('in the template but not in hooks.ts:\n  ' + (extra.join('\n  ') || '(none)'));
    process.exit(1);
  }
  console.log(fromCode.length);
" 2>"$WORK/drift.txt" >"$WORK/drift-count.txt"; then
  pass "all $(cat "$WORK/drift-count.txt") bindings match on event, matcher, command and timeout"
else
  oops "the two declarations disagree:"
  sed 's/^/        /' "$WORK/drift.txt" >&2
fi

echo
if [ "$FAILED" -gt 0 ]; then
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
echo "✓ hook wiring suite passed"
