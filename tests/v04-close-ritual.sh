#!/bin/bash
#
# E2E test: the /jarbis-close ritual, read back by the NEXT session.
#
# `commands sync` tests that the command file arrives. This tests that what
# the command tells the agent to write is actually there afterwards, read
# through the same tools a fresh agent calls — because the whole point of
# the ritual is the handoff, and a handoff is only real if the next session
# gets it. Each step runs in its own node process, so nothing is proved by
# state left in memory from the step before: that is what makes this an
# end-to-end test and not a unit test of three functions.
#
# What it pins, none of which the other suites cover:
#
#   · the three artifacts of the ritual (observations, project_state,
#     end_session) all survive into a new session, with no [auto] marker
#     and nothing buried
#   · project_state REPLACES — the command says "write the whole picture,
#     not a delta", and a state that accumulated would make that a lie
#   · saving twice under one topic_key updates in place instead of adding
#     a rival, which is the behaviour the ritual tells the agent to rely on
#   · keep_history chains supersedes instead, the other branch of that flag
#   · the SessionStart hook prints the handoff, which is the only part of
#     all this the user ever sees
#   · closing when nothing is open fails cleanly, as the command's own
#     "if no session is open" rule requires
#
# Exits 0 on success, non-zero on the first failed assertion.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$B/cli.js"

if [ ! -f "$B/tools/session.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-close-XXXXXX)"
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

NEXT='Run myjarbis commands sync --all --apply; 22 projects still lack the command.'
STATE1='First picture: the feature is built and the suite is green.'
STATE2='Second picture: the feature is built, green, and pushed to master.'

# ── [1] run the ritual in the order the command prescribes ────────
echo "[1] the ritual writes its three artifacts"
node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { startSession, endSession } from '$B/tools/session.js';
  import { saveObservation } from '$B/tools/observations.js';
  import { setProjectState } from '$B/tools/state.js';
  const ctx = ServerContext.initialize();
  startSession(ctx, { module: '_general' });
  saveObservation(ctx, {
    kind: 'gotcha',
    title: 'One control byte makes a source file binary to git',
    content: 'WHY: a raw NUL in a template literal. WHAT: git calls the file Bin. HOW: use the escape.',
    topic_key: 'git/binary-source-files',
  });
  saveObservation(ctx, {
    kind: 'progress',
    title: 'Ship the closing command',
    content: 'WHY: typing the sentence every time. WHAT: a slash command. HOW: templates plus init.',
  });
  setProjectState(ctx, { content: '$STATE1', session_tag: 'ritual-test' });
  const r = endSession(ctx, { summary: 'Shipped the command and its propagation path.', next_session: '$NEXT' });
  if (r.observationsCount !== 2) { console.error('observationsCount', r.observationsCount); process.exit(1); }
  ctx.close();
" && pass "session closed with 2 observations, state and a handoff" \
  || oops "the ritual did not complete"

# ── [2] a fresh session reads all of it back ──────────────────────
echo "[2] what the next agent gets"
if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { startSession } from '$B/tools/session.js';
  import { getProjectState } from '$B/tools/state.js';
  const ctx = ServerContext.initialize();
  const s = startSession(ctx, { module: '_general' });
  const st = getProjectState(ctx);
  ctx.close();
  const p = s.previousSession;
  if (!p || p.nextSession !== '$NEXT') { console.error('handoff wrong:', p && p.nextSession); process.exit(1); }
  if (p.nextSession.startsWith('[auto]')) { console.error('handoff is machine-written'); process.exit(1); }
  if (s.curatedResume) { console.error('nothing was buried, so curatedResume must be absent'); process.exit(1); }
  if (st.content !== '$STATE1') { console.error('state wrong:', st.content); process.exit(1); }
"; then
  pass "handoff verbatim, not [auto], nothing buried, state readable"
else
  oops "a fresh session did not read the ritual back"
fi

# ── [3] project_state replaces, it never accumulates ──────────────
echo "[3] the state is one row, overwritten"
if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { setProjectState, getProjectState } from '$B/tools/state.js';
  const ctx = ServerContext.initialize();
  const r = setProjectState(ctx, { content: '$STATE2', session_tag: 'ritual-test', force: true });
  const st = getProjectState(ctx);
  const rows = ctx.db.db.prepare('SELECT count(*) c FROM project_state').get().c;
  ctx.close();
  if (rows !== 1) { console.error('project_state rows:', rows); process.exit(1); }
  if (st.content !== '$STATE2') { console.error('not overwritten:', st.content); process.exit(1); }
  if (r.previousLength !== '$STATE1'.length) { console.error('previousLength', r.previousLength); process.exit(1); }
"; then
  pass "one row, holding the newer picture"
else
  oops "state accumulated or did not replace"
fi

# ── [4] one topic_key updates in place ────────────────────────────
echo "[4] saving twice under one topic_key"
if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { startSession } from '$B/tools/session.js';
  import { saveObservation } from '$B/tools/observations.js';
  const ctx = ServerContext.initialize();
  startSession(ctx, { module: '_general' });
  const before = ctx.db.db.prepare('SELECT count(*) c FROM observations').get().c;
  saveObservation(ctx, {
    kind: 'gotcha',
    title: 'One control byte makes a source file binary to git',
    content: 'WHY: a raw NUL. WHAT: git calls it Bin. HOW: escape it, and grep -P lies on binaries.',
    topic_key: 'git/binary-source-files',
  });
  const after = ctx.db.db.prepare('SELECT count(*) c FROM observations').get().c;
  const row = ctx.db.db.prepare(\"SELECT content, supersedes FROM observations WHERE topic_key='git/binary-source-files'\").all();
  ctx.close();
  if (after !== before) { console.error('count changed', before, '->', after); process.exit(1); }
  if (row.length !== 1) { console.error('rival notes under one key:', row.length); process.exit(1); }
  if (!row[0].content.includes('grep -P lies')) { console.error('content was not updated'); process.exit(1); }
"; then
  pass "updated the note, did not add a rival"
else
  oops "topic_key did not update in place"
fi

# ── [5] keep_history chains instead of overwriting ────────────────
echo "[5] keep_history keeps the old note"
if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { startSession } from '$B/tools/session.js';
  import { saveObservation } from '$B/tools/observations.js';
  const ctx = ServerContext.initialize();
  startSession(ctx, { module: '_general' });
  const before = ctx.db.db.prepare('SELECT count(*) c FROM observations').get().c;
  saveObservation(ctx, {
    kind: 'gotcha',
    title: 'One control byte makes a source file binary to git',
    content: 'WHY: third version. WHAT: kept on purpose. HOW: keep_history.',
    topic_key: 'git/binary-source-files',
    keep_history: true,
  });
  const after = ctx.db.db.prepare('SELECT count(*) c FROM observations').get().c;
  const keyed = ctx.db.db.prepare(\"SELECT count(*) c FROM observations WHERE topic_key='git/binary-source-files'\").get().c;
  const chained = ctx.db.db.prepare('SELECT count(*) c FROM observations WHERE supersedes IS NOT NULL').get().c;
  ctx.close();
  if (after !== before + 1) { console.error('expected one more note, got', before, '->', after); process.exit(1); }
  if (keyed !== 1) { console.error('the key must still name exactly one note, got', keyed); process.exit(1); }
  if (chained < 1) { console.error('nothing was chained with supersedes'); process.exit(1); }
"; then
  pass "added a note, chained it, and the key still names one"
else
  oops "keep_history did not chain"
fi

# ── [6] the hook prints the handoff — the only part the user sees ──
echo "[6] the SessionStart hook surfaces it"
# Opened and closed in ONE process, which is now belt and braces rather than
# a requirement: requireActiveSession() adopts whatever this project has left
# open in the brain (see v045-session-ownership), so a second process could
# close it too. Keeping it in one process pins the straightforward path.
node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { startSession, endSession } from '$B/tools/session.js';
  const ctx = ServerContext.initialize();
  startSession(ctx, { module: '_general' });
  endSession(ctx, { summary: 'Closed by hand again.', next_session: '$NEXT' });
  ctx.close();
" >/dev/null 2>&1 || oops "could not close a session for the hook to read"
HOOK_OUT=$(node "$CLI" hook session-start 2>&1 || true)
if echo "$HOOK_OUT" | grep -q "22 projects still lack the command"; then
  pass "the handoff text reached the terminal"
else
  oops "the hook did not print the handoff: $(echo "$HOOK_OUT" | tail -3 | tr '\n' ' ')"
fi

# ── [7] closing with nothing open fails cleanly ───────────────────
echo "[7] closing when nothing is open"
# A process that never called start_session has no active session, which is
# the situation the command's "if no session is open" rule describes: the
# agent must say so rather than fabricate a close.
BEFORE_SESSIONS=$(node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  const ctx = ServerContext.initialize();
  console.log(ctx.db.db.prepare('SELECT count(*) c FROM sessions').get().c);
  ctx.close();
")
if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { endSession } from '$B/tools/session.js';
  const ctx = ServerContext.initialize();
  try {
    endSession(ctx, { summary: 'nothing is open', next_session: 'should not be stored' });
    ctx.close();
    process.exit(1);
  } catch (e) {
    ctx.close();
    process.exit(0);
  }
"; then
  pass "refused instead of inventing a session to close"
else
  oops "closing with nothing open did not fail"
fi

AFTER_SESSIONS=$(node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  const ctx = ServerContext.initialize();
  console.log(ctx.db.db.prepare('SELECT count(*) c FROM sessions').get().c);
  ctx.close();
")
if [ "$BEFORE_SESSIONS" = "$AFTER_SESSIONS" ]; then
  pass "no phantom session row ($BEFORE_SESSIONS before, $AFTER_SESSIONS after)"
else
  oops "session count changed on a failed close: $BEFORE_SESSIONS -> $AFTER_SESSIONS"
fi

if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { resume } from '$B/tools/session.js';
  const ctx = ServerContext.initialize();
  const r = resume(ctx, { module: '_general' });
  ctx.close();
  if (!r.nextSession || r.nextSession.includes('should not be stored')) {
    console.error('a failed close overwrote the handoff:', r.nextSession);
    process.exit(1);
  }
"; then
  pass "the stored handoff survived the failed close"
else
  oops "the failed close damaged the handoff"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ v04-close-ritual: all assertions passed"
  exit 0
fi
echo "✗ v04-close-ritual: $FAILED assertion(s) failed" >&2
exit 1
