#!/bin/bash
#
# E2E test: the conversational path — what happens when the user asks for
# something by TALKING instead of typing a CLI verb.
#
# Every suite before this one drove the CLI or the tool functions as a
# developer would. The command file documents a different surface: a table
# of things the user says ("settings, switch me to English", "decidí X",
# "¿dónde estaba?") and the tool the agent is supposed to call for each.
# That surface had no coverage, and it is the one a user actually touches.
#
# It found a real defect, which is case [2] here: the language lives in two
# places — the interaction-style skill, which the agent reads, and
# settings.json, which the SessionStart hook reads because it runs before
# any agent exists. Persisting to settings.json was bolted onto the CLI
# path only, so changing the language from inside Claude updated the skill
# and left the terminal printing the old language forever. Worse, the skill
# upsert reports `unchanged` once the skill already matches, so the second
# attempt could not repair it either.
#
# `compact-cycle.sh` already covers the pre-compact snapshot trigger, so it
# is not repeated here.
#
# Exits 0 on success, non-zero on the first failed assertion.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$B/cli.js"

if [ ! -f "$B/tools/interactionStyle.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-chat-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export HOME="$WORK/home"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

mkdir -p "$WORK/proj" && cd "$WORK/proj" && git init -q .
git config user.email t@example.com && git config user.name Test
MYJARBIS_LANGUAGE=ES MYJARBIS_PERSONA=concise "$MJ" init --yes --skip-memory >/dev/null 2>&1
SETTINGS="$WORK/proj/.myjarbis/config/settings.json"
lang_in_settings() { node -e "console.log(JSON.parse(require('fs').readFileSync('$SETTINGS','utf-8')).language)"; }

# ── [1] "settings, switch me to English" ──────────────────────────
echo '[1] the user asks for English in the chat'
if [ "$(lang_in_settings)" = "es" ]; then
  pass "starts in ES, as init was told"
else
  oops "fixture wrong: settings says $(lang_in_settings)"
fi

node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { setInteractionStyle } from '$B/tools/interactionStyle.js';
  const ctx = ServerContext.initialize();
  const r = setInteractionStyle(ctx, { language: 'EN' });
  ctx.close();
  if (r.language !== 'EN') { console.error('tool returned', r.language); process.exit(1); }
" >/dev/null 2>&1 || oops "set_interaction_style failed outright"

if [ "$(lang_in_settings)" = "en" ]; then
  pass "settings.json followed the skill"
else
  oops "settings.json still says $(lang_in_settings) — the hook will keep printing the old language"
fi

HOOK_OUT=$(node "$CLI" hook session-start 2>&1 || true)
# The language signal moved: with no active module the hook prints a
# one-line pointer rather than the menu, so that line is what carries the
# locale now. Matched on the phrase, not on punctuation around it.
if echo "$HOOK_OUT" | grep -q "none active"; then
  pass "the hook renders in English"
else
  oops "the hook did not switch language: $(echo "$HOOK_OUT" | sed -n '3p')"
fi

# ── [2] the drift case: skill already EN, settings left behind ────
echo '[2] asking again when only settings.json is stale'
# This is the shape the bug took in the wild, and the reason the fix cannot
# live behind the `unchanged` early return.
node -e "
  const fs=require('fs');
  const s=JSON.parse(fs.readFileSync('$SETTINGS','utf-8'));
  s.language='es';
  fs.writeFileSync('$SETTINGS', JSON.stringify(s,null,2)+'\n');
"
STATUS=$(node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { setInteractionStyle } from '$B/tools/interactionStyle.js';
  const ctx = ServerContext.initialize();
  const r = setInteractionStyle(ctx, { language: 'EN' });
  ctx.close();
  console.log(r.status);
")
if [ "$STATUS" = "unchanged" ]; then
  pass "the skill is reported unchanged, which is what used to skip the repair"
else
  oops "expected status=unchanged for an identical skill, got $STATUS"
fi
if [ "$(lang_in_settings)" = "en" ]; then
  pass "settings.json was repaired anyway"
else
  oops "a stale settings.json survived the request that was meant to fix it"
fi

# ── [3] the CLI door agrees with the chat door ────────────────────
echo '[3] the same change through the CLI'
# Forced to a third language first, on purpose. Asserting "ES after asking
# for ES" passed even with the fix reverted, because the previous case had
# already left the file at es — the assertion was reading the fixture, not
# the behaviour. The teeth check is what exposed that.
node -e "
  const fs=require('fs');
  const s=JSON.parse(fs.readFileSync('$SETTINGS','utf-8'));
  s.language='pt';
  fs.writeFileSync('$SETTINGS', JSON.stringify(s,null,2)+'\n');
"
"$MJ" config language ES >/dev/null 2>&1 || oops "myjarbis config language failed"
if [ "$(lang_in_settings)" = "es" ]; then
  pass "CLI writes both stores too, so the two doors behave the same"
else
  oops "the CLI path left settings.json at $(lang_in_settings)"
fi
HOOK_ES=$(node "$CLI" hook session-start 2>&1 || true)
if echo "$HOOK_ES" | grep -q "ninguno activo"; then
  pass "and the hook is back in Spanish"
else
  oops "the hook did not follow the CLI change"
fi

# ── [4] "¿dónde estaba?" with nothing to resume ───────────────────
echo '[4] the user asks where they left off, on a fresh module'
if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { resume } from '$B/tools/session.js';
  const ctx = ServerContext.initialize();
  const r = resume(ctx, { module: '_general' });
  ctx.close();
  if (r.hasNextSession !== false || r.nextSession) {
    console.error('invented a handoff:', JSON.stringify(r));
    process.exit(1);
  }
"; then
  pass "reports no handoff instead of inventing one"
else
  oops "resume returned something to read on a module that never closed a session"
fi

# ── [5] "decidí X" is findable later, which is the whole point ────
echo '[5] a decision saved by talking is retrievable afterwards'
node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { startSession } from '$B/tools/session.js';
  import { saveObservation } from '$B/tools/observations.js';
  const ctx = ServerContext.initialize();
  startSession(ctx, { module: '_general' });
  saveObservation(ctx, {
    kind: 'decision',
    title: 'Usar JWT en vez de sesiones en memoria',
    content: 'POR QUE: hay dos instancias detras del balanceador, asi que la sesion en memoria no sirve.',
    files: 'auth.js',
  });
  ctx.close();
" >/dev/null 2>&1 || oops "could not save the decision"

if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { search } from '$B/tools/search.js';
  const ctx = ServerContext.initialize();
  // Accents folded on purpose: the user types 'sesion', the note says 'sesiones'.
  const r = search(ctx, { query: 'JWT balanceador', scope: 'observations' });
  ctx.close();
  if (!r.hits.length || !r.hits[0].title.includes('JWT')) {
    console.error('search found', r.count, 'hits');
    process.exit(1);
  }
"; then
  pass "FTS5 finds it from a later process"
else
  oops "a decision saved in conversation was not retrievable"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ v04-chat-triggers: all assertions passed"
  exit 0
fi
echo "✗ v04-chat-triggers: $FAILED assertion(s) failed" >&2
exit 1
