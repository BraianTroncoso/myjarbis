#!/bin/bash
#
# E2E test: detecting a project whose hook scripts are fine but bound to
# nothing.
#
# The bug this covers is the second half of the one v04-hook-wiring.sh
# covers. That suite proved `init` wires the hooks and `doctor` warns when
# a single project is unwired. What nothing asserted was the fleet view:
#
#   · health decided a project's hook state by diffing
#     .claude-plugin/hooks/hooks.json against the installed template, and
#     never read the settings file that makes those scripts run. A project
#     holding a byte-identical copy of the template with no wiring at all
#     reported `hooks: current` — rendered as "up to date".
#
#   · `myjarbis update --projects`, the command meant to repair this, gated
#     its whole refresh loop on `hooks != current`. So the false reading
#     above did not merely misreport: it switched the repair off. On the
#     author's own machine 6 of 23 projects were unwired and the command
#     would have visited none of them.
#
# So the assertions are about the two halves agreeing: the detector must
# see an unwired project, and the repair must then act on it. Plus the
# case that motivated separating `wiring` from `hooks` rather than folding
# unwired into stale — they have different repairs and can occur alone.
#
# Also asserted: update must refuse to overwrite its own source checkout
# with the installed copy of the template, which is a revert, not a sync.
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

WORK="$(mktemp -d -t myjarbis-unwired-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export HOME="$WORK/home"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

# One field out of `health --json` for one project, by name. Node rather
# than jq so the suite has no dependency the others do not have.
#
# Reading a field that does not exist prints 'undefined' rather than
# throwing. That matters when this suite is run against the bug it covers
# — which the conventions require before trusting it: without the fix
# there is no `wiring` field at all, and an uncaught throw here would
# abort the whole script on the first assertion instead of reporting each
# one as failed.
hq() { node -e "
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{
  try {
    const r=JSON.parse(raw);
    const p=(r.projects||[]).find(x=>x.name==='$1');
    if(!p){console.log('NOPROJECT');return}
    console.log(String($2));
  } catch { console.log('undefined'); }
});" ; }

# Same reasoning for the totals: a missing key must read as a failed
# assertion, not as a dead suite.
tq() { node -e "
let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{
  try { console.log(String(JSON.parse(raw).totals.$1)); }
  catch { console.log('undefined'); }
});" ; }

health() { node "$CLI" health --json 2>/dev/null; }

# ── fixture: two projects, both initialised properly ──────────────
for n in alpha beta; do
  mkdir -p "$WORK/$n" && cd "$WORK/$n" && git init -q .
  git config user.email t@example.com && git config user.name Test
  "$MJ" init --yes --skip-memory >/dev/null 2>&1
done

# ── [1] a correctly initialised project reads as wired ────────────
echo "[1] baseline: init leaves a project wired"

W=$(health | hq alpha 'p.wiring')
if [ "$W" = "wired" ]; then
  pass "alpha reports wiring=wired"
else
  oops "expected alpha wiring=wired, got '$W'"
fi

UNWIRED=$(health | tq hooksUnwired)
if [ "$UNWIRED" = "0" ]; then
  pass "totals.hooksUnwired is 0 with nothing broken"
else
  oops "expected hooksUnwired=0, got '$UNWIRED'"
fi

# ── [2] strip the wiring, keep the scripts ───────────────────────
# This is the exact shape of the bug: the scripts stay byte-identical to
# the template, only the settings file loses the hooks block. Before the
# fix this project was indistinguishable from a healthy one.
echo "[2] scripts current + no wiring is detected"

rm -f "$WORK/beta/.claude/settings.local.json"

H=$(health | hq beta 'p.hooks')
W=$(health | hq beta 'p.wiring')
if [ "$H" = "current" ]; then
  pass "beta still reports hooks=current (scripts untouched, as the bug requires)"
else
  oops "fixture is wrong: expected beta hooks=current, got '$H'"
fi
if [ "$W" = "unwired" ]; then
  pass "beta reports wiring=unwired — the reading that did not exist"
else
  oops "expected beta wiring=unwired, got '$W'"
fi

MISSING=$(health | hq beta 'p.wiringMissing.length')
if [ "$MISSING" -ge 4 ] 2>/dev/null; then
  pass "beta lists its unbound events ($MISSING of them)"
else
  oops "expected 4+ unbound events listed, got '$MISSING'"
fi

UNWIRED=$(health | tq hooksUnwired)
if [ "$UNWIRED" = "1" ]; then
  pass "totals.hooksUnwired counts it"
else
  oops "expected hooksUnwired=1, got '$UNWIRED'"
fi

# ── [3] a settings file with other content but no hooks ──────────
# The common real case is not a missing file: it is a settings.local.json
# that already carries a permission allowlist and predates the wiring.
echo "[3] settings file present, hooks block absent"

mkdir -p "$WORK/beta/.claude"
cat > "$WORK/beta/.claude/settings.local.json" <<'JSON'
{ "permissions": { "allow": ["Bash(ls:*)"] } }
JSON

W=$(health | hq beta 'p.wiring')
if [ "$W" = "unwired" ]; then
  pass "a settings file with no hooks block still reads as unwired"
else
  oops "expected wiring=unwired for a hook-less settings file, got '$W'"
fi

# ── [4] partial wiring is its own state ─────────────────────────
# Half a wiring is not health: a project with SessionStart bound but no
# SessionEnd greets you and never closes the session.
echo "[4] partial wiring is distinguished from both"

node -e "
const fs=require('fs');
const f='$WORK/beta/.claude/settings.local.json';
const s=JSON.parse(fs.readFileSync(f,'utf8'));
s.hooks={SessionStart:[{matcher:'startup|clear',hooks:[{type:'command',
  command:'\"\${CLAUDE_PROJECT_DIR}/.claude-plugin/scripts/session-start.sh\"',timeout:10}]}]};
fs.writeFileSync(f,JSON.stringify(s,null,2));
"

W=$(health | hq beta 'p.wiring')
if [ "$W" = "partial" ]; then
  pass "one event bound out of several reads as partial"
else
  oops "expected wiring=partial, got '$W'"
fi

# ── [5] a user's own hooks are not mistaken for ours ────────────
# isMyJarbisHookEntry only counts entries whose commands point into
# .claude-plugin/scripts/. Someone else's SessionStart hook must not make
# an unwired project look wired.
echo "[5] a foreign hook does not count as our wiring"

cat > "$WORK/beta/.claude/settings.local.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "echo hello", "timeout": 5 }] }
    ]
  }
}
JSON

W=$(health | hq beta 'p.wiring')
if [ "$W" = "unwired" ]; then
  pass "someone else's SessionStart hook does not read as wired"
else
  oops "expected wiring=unwired with only a foreign hook, got '$W'"
fi

# ── [6] malformed JSON is reported as unknown, not unwired ──────
# Different repair: `hook install claude` refuses to touch a file it
# cannot parse, so calling this "unwired" would suggest a command that
# will not work.
echo "[6] unparseable settings reads as unknown"

echo '{ this is not json' > "$WORK/beta/.claude/settings.local.json"

W=$(health | hq beta 'p.wiring')
if [ "$W" = "unknown" ]; then
  pass "malformed settings reads as unknown rather than unwired"
else
  oops "expected wiring=unknown for malformed JSON, got '$W'"
fi

# ── [7] the repair now acts on an unwired project ──────────────
# The assertion that matters most: before the fix this loop skipped
# anything with `hooks = current`, which is exactly this project.
#
# --projects-only exists partly for this test and mostly for real use: the
# full `update` pulls, re-syncs and runs npm install + build, none of which
# a hook repair needs. Asserting through it keeps the suite off the network
# and leaves the install dir untouched.
echo "[7] update --projects-only repairs scripts-current-but-unwired"

rm -f "$WORK/beta/.claude/settings.local.json"
W=$(health | hq beta 'p.wiring')
[ "$W" = "unwired" ] || oops "fixture is wrong: beta should be unwired before the repair, got '$W'"

OUT=$("$MJ" update --projects-only --yes 2>&1 || true)

W=$(health | hq beta 'p.wiring')
if [ "$W" = "wired" ]; then
  pass "update --projects-only wired beta back up"
else
  oops "expected beta wiring=wired after the repair, got '$W'"
  echo "$OUT" | tail -25 | sed 's/^/        /' >&2
fi

if echo "$OUT" | grep -q "scripts were already current"; then
  pass "it wired beta without copying the scripts over"
else
  oops "expected the 'scripts were already current' path to be taken"
  echo "$OUT" | tail -25 | sed 's/^/        /' >&2
fi

# The skipped steps must still be announced — the step numbering is how
# this output is read, and a silently missing step 4 reads as a crash.
if echo "$OUT" | grep -q "the running build is left alone"; then
  pass "the rebuild was skipped and said so"
else
  oops "expected step 4 to report itself skipped"
fi

# alpha was healthy throughout and must not have been touched.
W=$(health | hq alpha 'p.wiring')
if [ "$W" = "wired" ]; then
  pass "alpha, already wired, came through untouched"
else
  oops "expected alpha to stay wired, got '$W'"
fi

# ── [8] the repair refuses to touch its own source checkout ────
# The installed templates/ is a snapshot of the checkout, so copying it
# back over the checkout reverts whatever is in progress there. A minimal
# fake checkout is enough: step 1 only looks for global/ and install.sh.
echo "[8] the source checkout is never refreshed from its own copy"

SRC="$WORK/src"
mkdir -p "$SRC/global" && touch "$SRC/install.sh"
cd "$SRC" && git init -q . && git config user.email t@example.com
git config user.name Test
"$MJ" init --yes --skip-memory >/dev/null 2>&1

# Make it look stale AND unwired, so both halves of the loop would
# otherwise want to act on it.
echo '{"marker":"checkout-ahead"}' > "$SRC/.claude-plugin/hooks/hooks.json"
rm -f "$SRC/.claude/settings.local.json"

OUT=$("$MJ" update --projects-only --yes --from="$SRC" 2>&1 || true)

if grep -q 'checkout-ahead' "$SRC/.claude-plugin/hooks/hooks.json"; then
  pass "the checkout's own .claude-plugin was left alone"
else
  oops "the repair overwrote the source checkout with the installed copy"
  echo "$OUT" | tail -25 | sed 's/^/        /' >&2
fi

if echo "$OUT" | grep -q "source checkout, not refreshing"; then
  pass "it said why it skipped the checkout"
else
  oops "expected the skip to be explained in the output"
  echo "$OUT" | tail -25 | sed 's/^/        /' >&2
fi

# --projects-only must not have remembered the throwaway checkout as the
# installation's source: that would break the next real update.
if [ ! -f "$MYJARBIS_INSTALL_DIR/.source" ] || \
   ! grep -q "$SRC" "$MYJARBIS_INSTALL_DIR/.source" 2>/dev/null; then
  pass "--from on a --projects-only run was not persisted as .source"
else
  oops "a --projects-only run overwrote the recorded source checkout"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ all unwired-detection checks passed"
  exit 0
fi
echo "✗ $FAILED check(s) failed"
exit 1
