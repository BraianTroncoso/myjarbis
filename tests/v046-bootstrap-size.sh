#!/bin/bash
#
# E2E test: what the bootstrap puts in front of the model must not scale with
# the size of the project.
#
# The SessionStart menu printed each module's description IN FULL. On a
# 19-module project averaging 376 characters of description, that is 7.1 KB of
# an 11.2 KB menu — and the menu is read before the user has typed anything,
# on top of a 15 KB slash command. What the agent did with that is the part
# worth pinning: handed a wall of text it already had, it went and re-queried
# the database for it (`myjarbis module list`, `SELECT ... FROM projects`),
# which is the one thing the command explicitly forbids at bootstrap.
#
# The menu also listed every module TWICE: once numbered with its description,
# then again as a "· <name> or <n> → start a session" option line per module.
#
# What this pins:
#
#   · a module's description is clipped in the menu, so menu size is bounded
#     by the module COUNT and not by how much anyone wrote
#   · the full description is still intact in the database — the menu clips
#     the view, it does not truncate the data
#   · each module appears ONCE
#   · the most recently worked module is marked, and the others are not
#   · the baseline read-only permissions are pre-approved, the user's own
#     entries survive, and a second run adds nothing
#   · the module-orchestration skill does not tell the agent to call
#     `list_modules` at session start, which is what the hook already did
#
# Exits 0 on success, non-zero on the first failed assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"

if [ ! -f "$B/cli.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-bootsize-XXXXXX)"
trap 'cd /; rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
# Pinned so the suite cannot touch the real home, the real brain or the real
# registry — three suites were found writing into the live 23-project brain.
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

# The menu branch emits JSON now: the module list rides in `systemMessage`,
# which Claude Code DISPLAYS to the user, while the model gets a short
# summary in `additionalContext`. Assertions about what the menu LOOKS LIKE
# have to read the displayed field — grepping raw stdout would be measuring
# one long line of JSON and calling it a menu.
menu_text() {
  node "$B/cli.js" hook session-start 2>/dev/null \
    | node -e "
let s='';
process.stdin.on('data',(d)=>(s+=d)).on('end',()=>{
  try { process.stdout.write(JSON.parse(s).systemMessage || ''); }
  catch { process.stdout.write(s); }
});" 2>/dev/null || true
}

mkdir -p "$WORK/proj" && cd "$WORK/proj" && git init -q .
git config user.email t@example.com && git config user.name Test
"$MJ" init --yes --skip-memory >/dev/null 2>&1

# A description of the shape that caused this: one long paragraph, far past
# anything a picker needs.
LONG="Vertical de control financiero por proyecto (solo superadmin, USD): entidad FinanceProject propia con cliente, presupuesto y link opcional a un board del tracker, mas movimientos de ingreso y gasto con descripcion y referencia. KPIs: presupuesto, cobrado, gastado, saldo y margen restante, para saber cuanto presupuesto queda y como estamos cobrando por proyecto."
echo "→ description fixture: ${#LONG} chars"

"$MJ" module add alpha --description="$LONG" >/dev/null
"$MJ" module add bravo --description="$LONG" >/dev/null
"$MJ" module add charlie --description="$LONG" >/dev/null

# ── [1] the description is clipped in the menu ──────────────────────────
echo '[1] a long description does not reach the menu whole'
HOOK_OUT=$(menu_text)

if echo "$HOOK_OUT" | grep -q "Modules ("; then
  pass "the menu rendered"
else
  oops "no menu in the hook output: $(echo "$HOOK_OUT" | head -3)"
fi

# The tail of the paragraph is the part that must not survive. Asserting on
# the tail rather than on a byte budget means this keeps testing the property
# if MENU_DESC_LEN is ever retuned.
if echo "$HOOK_OUT" | grep -q "como estamos cobrando por proyecto"; then
  oops "the full description reached the menu — it is not being clipped"
else
  pass "the end of the paragraph never reaches the menu"
fi

if echo "$HOOK_OUT" | grep -q "Vertical de control financiero"; then
  pass "but the beginning does, so the module is still identifiable"
else
  oops "the description is gone entirely — clipped too hard to pick a module by"
fi

LONGEST=$(echo "$HOOK_OUT" | awk '{ print length }' | sort -rn | head -1)
if [ "$LONGEST" -lt 200 ]; then
  pass "no menu line exceeds 200 chars (longest: $LONGEST)"
else
  oops "a menu line is $LONGEST chars long — descriptions are leaking through"
fi

# ── [2] the data is untouched; only the view is clipped ─────────────────
echo '[2] the database still holds the whole description'
STORED=$(node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  const ctx = ServerContext.initialize();
  try {
    const m = ctx.db.modules.listByProject(ctx.project.id).find(x => x.name === 'alpha');
    console.log(String(m.description).length);
  } finally { ctx.close(); }
" 2>/dev/null)
if [ "$STORED" = "${#LONG}" ]; then
  pass "alpha's description is still ${#LONG} chars in the DB"
else
  oops "the DB description is $STORED chars, expected ${#LONG} — the menu truncated the DATA"
fi

# ── [3] each module appears once ────────────────────────────────────────
echo '[3] the menu does not list every module twice'
COUNT=$(echo "$HOOK_OUT" | grep -c "alpha")
if [ "$COUNT" -eq 1 ]; then
  pass "alpha appears exactly once"
else
  oops "alpha appears $COUNT times — the per-module option list is back"
fi

# ── [4] the last worked module is marked, and only it ───────────────────
echo '[4] the most recently worked module is highlighted'
node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  const ctx = ServerContext.initialize();
  try {
    const db = ctx.db;
    const bravo = db.modules.listByProject(ctx.project.id).find(x => x.name === 'bravo');
    const s = db.sessions.start(bravo.id);
    db.sessions.end(s.id, 'did work', 'pick up from here');
  } finally { ctx.close(); }
" >/dev/null 2>&1

HOOK2=$(menu_text)
if echo "$HOOK2" | grep -q "▸.*bravo"; then
  pass "bravo is marked as the last worked module"
else
  oops "bravo is not marked: $(echo "$HOOK2" | grep bravo)"
fi
# Anchored at column 0: a module row starts with the mark, while the header's
# "▸ = last worked in" legend carries one mid-line and must not be counted.
MARKS=$(echo "$HOOK2" | grep -c "^▸" || true)
if [ "$MARKS" -eq 1 ]; then
  pass "exactly one module carries the mark"
else
  oops "$MARKS modules are marked — the highlight is not unique"
fi
if echo "$HOOK2" | grep -q "alpha" && echo "$HOOK2" | grep -q "charlie"; then
  pass "the modules that were not worked in are still listed"
else
  oops "highlighting one module dropped the others from the menu"
fi

# ── [5] baseline permissions ────────────────────────────────────────────
echo '[5] read-only permissions are pre-approved without eating the user'"'"'s'
mkdir -p "$WORK/proj/.claude"
cat > "$WORK/proj/.claude/settings.local.json" <<'JSON'
{
  "permissions": {
    "allow": ["Bash(npm run build)"],
    "deny": ["Bash(curl *)"]
  }
}
JSON
node "$B/cli.js" hook install claude >/dev/null 2>&1

read_perms() {
  node -e "
    const j = require('$WORK/proj/.claude/settings.local.json');
    console.log(JSON.stringify(j.permissions));
  " 2>/dev/null
}
P="$(read_perms)"

if echo "$P" | grep -q 'mcp__myjarbis__\*'; then
  pass "the MCP wildcard covers every myjarbis tool in one entry"
else
  oops "mcp__myjarbis__* was not added: $P"
fi
if echo "$P" | grep -q 'Bash(npm run build)'; then
  pass "the user's own allow entry survived"
else
  oops "the user's allow entry was dropped: $P"
fi
if echo "$P" | grep -q 'Bash(curl \*)'; then
  pass "the user's deny list was not touched"
else
  oops "the deny list was lost: $P"
fi
# Nothing that writes. If this ever fails, someone widened the baseline past
# what an installer is allowed to decide on the user's behalf.
for DANGER in 'Bash(git push' 'Bash(rm ' 'Write(' 'Edit('; do
  if echo "$P" | grep -qF "$DANGER"; then
    oops "the baseline pre-approves a WRITE: $DANGER"
  fi
done
pass "the baseline pre-approves nothing that writes, pushes or deletes"

BEFORE="$(read_perms)"
node "$B/cli.js" hook install claude >/dev/null 2>&1
if [ "$(read_perms)" = "$BEFORE" ]; then
  pass "a second run adds nothing (idempotent)"
else
  oops "running twice changed the permissions again"
fi

# ── [5b] a project whose hooks are already fine still gets them ─────────
#
# This is the hole the first fleet run fell into. `update` only called
# `hook install claude` for projects the health report flagged as needing
# hook repair, and `wireClaudeHooks` is also where the permission merge
# lives — so 23 projects reporting "up to date" received 0 of 6 entries.
# The fleet that is healthiest is the one that would never be reached.
echo '[5b] an already-wired project still receives the baseline'
rm -f "$WORK/proj/.claude/settings.local.json"
node "$B/cli.js" hook install claude >/dev/null 2>&1   # wire from scratch
FIRST="$(read_perms)"
# Strip the permissions, leave the hooks wired: exactly the state of a
# project that was wired before the baseline existed.
node -e "
  const fs = require('fs');
  const p = '$WORK/proj/.claude/settings.local.json';
  const j = JSON.parse(fs.readFileSync(p, 'utf-8'));
  delete j.permissions;
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
" 2>/dev/null
node "$B/cli.js" hook install claude >/dev/null 2>&1
if [ -n "$(read_perms)" ] && [ "$(read_perms)" = "$FIRST" ]; then
  pass "a wired project with no permissions block gets the baseline back"
else
  oops "an already-wired project was left without the baseline: $(read_perms)"
fi

# ── [6] the skill agrees with the command ───────────────────────────────
echo '[6] module-orchestration does not re-query what the hook handed over'
SKILL="$WORK/proj/.claude/skills/myjarbis-module-orchestration/SKILL.md"
if [ -f "$SKILL" ]; then
  # The skill is materialized into every project and its description pulls it
  # in at session start. While it said "Call list_modules to see the
  # verticals", it was instructing the exact behaviour the command forbids —
  # and the agent followed the skill.
  if grep -q 'Call `list_modules`' "$SKILL"; then
    oops "the skill still tells the agent to call list_modules at session start"
  else
    pass "the skill no longer orders a list_modules call at session start"
  fi
  if grep -q 'Do NOT call `list_modules`' "$SKILL"; then
    pass "and says so explicitly, so the agent does not reinvent it"
  else
    oops "the skill does not warn against re-querying the bootstrap"
  fi
else
  oops "module-orchestration was not materialized at $SKILL"
fi

# ── [7] the menu goes to the USER, a summary goes to the model ──────────
echo '[7] the menu is displayed to the user, not spent on the model'
# Plain stdout from a SessionStart hook is added to the model's context and
# is NOT printed to the user's terminal. Rendering the menu there spent
# ~11 KB of context on eighteen descriptions the model has no use for yet,
# AND left the person who had to choose staring at "which module?" with no
# list. `systemMessage` is the field Claude Code displays.
MENU_JSON=$(node "$B/cli.js" hook session-start 2>/dev/null || true)
# Quoted heredoc: the script below reaches node byte for byte, so its own
# quotes and regexes are not re-interpreted by the shell first.
cat > "$WORK/parse.js" <<'PARSEJS'
let s = '';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  try {
    const j = JSON.parse(s);
    const sm = j.systemMessage || '';
    const ac = (j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || '';
    console.log(JSON.stringify({
      smLen: sm.length,
      acLen: ac.length,
      smHasModules: /alpha/.test(sm),
      acHasModules: /alpha/.test(ac),
      acWarnsNoRequery: /Do NOT call list_modules/.test(ac),
      acHasFallback: /cannot see any list/.test(ac),
    }));
  } catch {
    console.log('PARSE_FAIL');
  }
});
PARSEJS
PARSED=$(echo "$MENU_JSON" | node "$WORK/parse.js" 2>/dev/null || echo PARSE_FAIL)

if [ "$PARSED" = "PARSE_FAIL" ] || [ -z "$PARSED" ]; then
  oops "the menu branch did not emit parseable JSON: $(echo "$MENU_JSON" | head -2)"
else
  cat > "$WORK/field.js" <<'FIELDJS'
let s = '';
process.stdin.on('data', (d) => (s += d))
  .on('end', () => console.log(JSON.parse(s)[process.argv[2]]));
FIELDJS
  field() { echo "$PARSED" | node "$WORK/field.js" "$1"; }
  [ "$(field smHasModules)" = "true" ] \
    && pass "the module list is in systemMessage, where the user sees it" \
    || oops "systemMessage does not carry the module list"
  [ "$(field acHasModules)" = "false" ] \
    && pass "the module list is NOT spent on the model's context" \
    || oops "the model still receives the full module list"
  [ "$(field acWarnsNoRequery)" = "true" ] \
    && pass "the model is told not to re-query what it was not given" \
    || oops "nothing stops the model from calling list_modules anyway"
  # Without this the failure is silent AND unrecoverable: if systemMessage
  # ever stops rendering, the user sees nothing and the model, correctly
  # believing a menu is on screen, keeps asking them to pick from it.
  [ "$(field acHasFallback)" = "true" ] \
    && pass "and given a recovery path if the user sees no list" \
    || oops "no recovery path when systemMessage does not render"
  AC_LEN=$(field acLen)
  [ "$AC_LEN" -lt 2000 ] \
    && pass "the model's bootstrap is $AC_LEN bytes (was ~11000)" \
    || oops "the model's bootstrap is $AC_LEN bytes — the menu leaked back in"
fi

TPL_DIR="$REPO_ROOT/global/templates/.claude/commands"
for L in es en pt; do
  F="$TPL_DIR/jarbis.$L.md"
  [ -f "$F" ] || { oops "missing template: jarbis.$L.md"; continue; }
  if grep -qiE "no ve ninguna lista|cannot see any list|não vê nenhuma lista" "$F"; then
    pass "jarbis.$L.md carries the same recovery path"
  else
    oops "jarbis.$L.md has no recovery path for an invisible menu"
  fi
done

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ v046-bootstrap-size: all assertions passed"
  exit 0
fi
echo "✗ v046-bootstrap-size: $FAILED assertion(s) failed" >&2
exit 1
