#!/bin/bash
#
# E2E test: who owns the active session, the hook's process or the server's.
#
# The SessionStart hook opens the session in a short-lived CLI process. The MCP
# server is a different, long-lived one. The active session used to live only in
# the server's memory, so the banner announced a session the server could not
# see: the first `save_observation` of every session failed, and recovering with
# `start_session` auto-closed the hook's session and opened a second one.
#
# Every step below runs in its OWN node process on purpose. That is the whole
# point — a single-process test cannot see this bug at all, which is why 273
# passing checks never caught it.
#
# What it pins:
#
#   · a fresh process adopts the session the hook left open, instead of
#     refusing to write to it
#   · the observation lands on the HOOK's session id, not a new one
#   · no session churn: adopting does not create a second session row
#   · `search(scope="module")` stays bounded to the module — with the module
#     unresolved it silently widened to the whole project, which quietly broke
#     the "default scope = active module" guarantee in every hook-opened session
#   · after `end_session`, adoption is suppressed: closing then writing must
#     still fail rather than land the note on some leftover open session
#   · with genuinely nothing open it still fails, as v04-close-ritual requires
#   · `end_session` missing `next_session` reports the truncation cause and the
#     summary length, instead of a bare "next_session: Required"
#
# Exits 0 on success, non-zero on the first failed assertion.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$B/cli.js"

if [ ! -f "$B/context.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-ownership-XXXXXX)"
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
"$MJ" init --yes --skip-memory >/dev/null 2>&1

# Two modules, so a widened search has somewhere to widen to.
"$MJ" module add checkout --description="Checkout flow" >/dev/null
"$MJ" module add catalog  --description="Catalog" >/dev/null

# ── [1] the hook opens a session in its own process ───────────────
echo "[1] the hook's process opens the session"
"$MJ" module use checkout >/dev/null
HOOK_OUT=$(node "$CLI" hook session-start 2>&1 || true)
HOOK_SESSION=$(node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  const ctx = ServerContext.initialize();
  const row = ctx.db.db.prepare('SELECT id FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC, id DESC LIMIT 1').get();
  console.log(row ? row.id : 'none');
  ctx.close();
")
if [ "$HOOK_SESSION" != "none" ]; then
  pass "hook left session #$HOOK_SESSION open"
else
  oops "the hook did not open a session: $(echo "$HOOK_OUT" | tail -2 | tr '\n' ' ')"
fi

SESSIONS_BEFORE=$(node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  const ctx = ServerContext.initialize();
  console.log(ctx.db.db.prepare('SELECT count(*) c FROM sessions').get().c);
  ctx.close();
")

# ── [2] a different process writes to it as its FIRST call ────────
echo "[2] the server's process writes without calling start_session"
if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { saveObservation } from '$B/tools/observations.js';
  const ctx = ServerContext.initialize();
  const r = saveObservation(ctx, {
    kind: 'discovery',
    title: 'The hook and the server are two processes',
    content: 'WHY: the active session was per-process memory. WHAT: the first write failed. HOW: adopt from the brain.',
  });
  ctx.close();
  if (r.sessionId !== $HOOK_SESSION) {
    console.error('landed on session', r.sessionId, 'but the hook opened', $HOOK_SESSION);
    process.exit(1);
  }
" 2>/dev/null; then
  pass "the observation landed on the hook's session #$HOOK_SESSION"
else
  oops "a fresh process could not write to the session the hook opened"
fi

SESSIONS_AFTER=$(node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  const ctx = ServerContext.initialize();
  console.log(ctx.db.db.prepare('SELECT count(*) c FROM sessions').get().c);
  ctx.close();
")
if [ "$SESSIONS_BEFORE" = "$SESSIONS_AFTER" ]; then
  pass "no session churn ($SESSIONS_BEFORE before, $SESSIONS_AFTER after)"
else
  oops "adopting created a session row: $SESSIONS_BEFORE -> $SESSIONS_AFTER"
fi

# ── [3] search stays bounded to the module ────────────────────────
echo "[3] search(scope=module) resolves the module"
# The silent failure this pins: with activeModuleId null, search.ts does not
# error — it drops the module filter and searches the whole project, reporting
# a scopeContext with no module in it. Nothing in the output says it widened.
if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { search } from '$B/tools/search.js';
  const ctx = ServerContext.initialize();
  const r = search(ctx, { query: 'checkout' });
  ctx.close();
  if (r.scopeContext.module !== 'checkout') {
    console.error('scope widened: scopeContext.module =', r.scopeContext.module);
    process.exit(1);
  }
" 2>/dev/null; then
  pass "scopeContext.module is 'checkout', the search did not widen"
else
  oops "search silently widened past the active module"
fi

# ── [4] after end_session, adoption is suppressed ─────────────────
echo "[4] closing then writing must still fail"
# Otherwise the fix would trade one silent error for a worse one: a note
# landing on whatever session happened to be open somewhere else.
if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { startSession, endSession } from '$B/tools/session.js';
  import { saveObservation } from '$B/tools/observations.js';
  const ctx = ServerContext.initialize();
  startSession(ctx, { module: 'catalog' });
  endSession(ctx, { summary: 'Closed on purpose.', next_session: 'Nothing pending.' });
  try {
    saveObservation(ctx, { kind: 'gotcha', title: 'should not be stored', content: 'WHY. WHAT. HOW.' });
    console.error('a write after end_session was accepted');
    ctx.close();
    process.exit(1);
  } catch (e) {
    ctx.close();
    if (!String(e.message).includes('end_session')) {
      console.error('wrong error:', e.message);
      process.exit(1);
    }
  }
" 2>/dev/null; then
  pass "refused, and the message names end_session as the reason"
else
  oops "a write after end_session was not refused"
fi

# ── [5] nothing open at all still fails ──────────────────────────
echo "[5] nothing open anywhere"
# `start_session` auto-closes per MODULE, not per project, so the hook's
# checkout session is still open at this point — `autoCloseAll` is what clears
# the project. Worth stating: this test asserted "nothing is open" here and was
# wrong about it, which is the kind of assumption a per-module auto-close hides.
node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { autoCloseAll } from '$B/tools/autoClose.js';
  const ctx = ServerContext.initialize();
  autoCloseAll(ctx);
  ctx.close();
" >/dev/null 2>&1
if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { saveObservation } from '$B/tools/observations.js';
  const ctx = ServerContext.initialize();
  const open = ctx.db.db.prepare('SELECT count(*) c FROM sessions WHERE ended_at IS NULL').get().c;
  if (open !== 0) { console.error('expected nothing open, found', open); ctx.close(); process.exit(1); }
  try {
    saveObservation(ctx, { kind: 'gotcha', title: 'should not be stored', content: 'WHY. WHAT. HOW.' });
    console.error('accepted a write with no session anywhere');
    ctx.close();
    process.exit(1);
  } catch (e) {
    ctx.close();
    if (!String(e.message).includes('start_session')) {
      console.error('wrong error:', e.message);
      process.exit(1);
    }
  }
" 2>/dev/null; then
  pass "refused and pointed at start_session"
else
  oops "writing with nothing open did not fail cleanly"
fi

# ── [6] end_session names the truncation, not a missing argument ──
echo "[6] end_session without next_session"
# The real cause is a long summary getting the rest of the arguments cut off in
# transit. A bare validator error blames the caller for forgetting a field; it
# cost four retries and left two sessions with throwaway handoffs.
if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { startSession, endSession } from '$B/tools/session.js';
  const ctx = ServerContext.initialize();
  startSession(ctx, { module: 'checkout' });
  const summary = 'x'.repeat(2500);
  try {
    endSession(ctx, { summary });
    console.error('a close with no next_session was accepted');
    ctx.close();
    process.exit(1);
  } catch (e) {
    ctx.close();
    const m = String(e.message);
    if (!m.includes('2500')) { console.error('does not report the summary length:', m); process.exit(1); }
    if (!m.includes('truncated')) { console.error('does not name the truncation cause:', m); process.exit(1); }
  }
" 2>/dev/null; then
  pass "reports the 2500-character summary and names truncation"
else
  oops "end_session gave a bare validator error instead of the cause"
fi

# ── [7] the handoff is not damaged by the refused close ───────────
echo "[7] the refused close left no trace"
if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  const ctx = ServerContext.initialize();
  const row = ctx.db.db.prepare(\"SELECT count(*) c FROM sessions WHERE summary LIKE 'xxx%'\").get().c;
  ctx.close();
  if (row !== 0) { console.error('a refused close still wrote a summary'); process.exit(1); }
"; then
  pass "no session was closed with the oversized summary"
else
  oops "the refused close persisted anyway"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ v045-session-ownership: all assertions passed"
  exit 0
fi
echo "✗ v045-session-ownership: $FAILED assertion(s) failed" >&2
exit 1
