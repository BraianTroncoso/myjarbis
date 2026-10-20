#!/bin/bash
#
# E2E test: a SessionEnd must not close another Claude's session.
#
# Claude Code starts the new process's SessionStart hook BEFORE the exiting
# process's SessionEnd hook. Measured on 2026-10-20:
#
#   13:56:02  new Claude · SessionStart · opened session #477
#   13:56:12  old Claude · SessionEnd   · autoCloseAll closed #477
#   13:56:52  the agent in the new process wrote → SESSION_NOT_ACTIVE
#
# So the session the user was sitting in was closed and stamped `[auto]` with
# "0m open, 0 observations saved, nothing was recorded" — and because a
# generated close is the module's newest close, it also pushed the handoff a
# human had written down one level into `curatedResume`. Once per restart.
#
# The fix is ownership, not a timing guess: each hook gets Claude's own
# `session_id` on stdin, SessionStart writes a claim naming the brain sessions
# it opened, and SessionEnd skips sessions another live claim is holding.
#
# What it pins:
#
#   · the race itself: an old process's SessionEnd leaves the new process's
#     session open, and says so
#   · the feature still works: that same SessionEnd closes its OWN session
#   · no regression: an UNCLAIMED open session is still auto-closed, which is
#     the whole reason the hook exists
#   · the banner tells "started" from "resumed" — it used to say "resumed" for
#     every session, including ones it had just created
#   · claims are released on exit and pruned when a process is killed
#
# Every hook below runs in its own process, as it does in reality, and each one
# is fed the JSON payload Claude Code sends on stdin.
#
# Exits 0 on success, non-zero on the first failed assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$B/cli.js"

if [ ! -f "$B/context.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-sessionowner-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export HOME="$WORK/home"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"
RUN_DIR="$MYJARBIS_HOME/run"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

mkdir -p "$WORK/proj" && cd "$WORK/proj" && git init -q .
git config user.email t@example.com && git config user.name Test
"$MJ" init --yes --skip-memory >/dev/null 2>&1
"$MJ" module add cli --description="CLI" >/dev/null
"$MJ" module use cli >/dev/null

# A hook as Claude Code actually invokes it: its own process, payload on stdin.
hook() {
  local event="$1" claude_id="$2"
  if [ "$claude_id" = "-" ]; then
    printf '' | node "$CLI" hook "$event" 2>&1
  else
    printf '{"session_id":"%s","cwd":"%s","hook_event_name":"x"}' "$claude_id" "$WORK/proj" \
      | node "$CLI" hook "$event" 2>&1
  fi
}

open_sessions() {
  node --input-type=module -e "
    process.chdir('$WORK/proj');
    import { ServerContext } from '$B/context.js';
    const ctx = ServerContext.initialize();
    const rows = ctx.db.db.prepare('SELECT id FROM sessions WHERE ended_at IS NULL ORDER BY id').all();
    console.log(rows.map(r => r.id).join(','));
    ctx.close();
  " 2>/dev/null
}

session_is_open() {
  node --input-type=module -e "
    process.chdir('$WORK/proj');
    import { ServerContext } from '$B/context.js';
    const ctx = ServerContext.initialize();
    const row = ctx.db.db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get($1);
    console.log(row && row.ended_at === null ? 'open' : 'closed');
    ctx.close();
  " 2>/dev/null
}

# ── [1] the new process opens and claims a session ──────────────────────
echo "[1] SessionStart opens a session and claims it for this Claude"
OUT_NEW="$(hook session-start NEW)"
NEW_SESSION="$(open_sessions)"
if [ -n "$NEW_SESSION" ]; then
    pass "session #$NEW_SESSION is open"
else
    oops "SessionStart opened no session: $OUT_NEW"
fi
if echo "$OUT_NEW" | grep -q "Session #$NEW_SESSION started"; then
    pass "the banner says 'started', not 'resumed' — it had just been created"
else
    oops "the banner misreports a brand-new session: $(echo "$OUT_NEW" | grep -i 'Session #' || echo '(no session line)')"
fi
if [ -f "$RUN_DIR/claude-NEW.json" ]; then
    pass "a claim file was written for this Claude session"
else
    oops "no claim written — nothing protects this session (looked in $RUN_DIR)"
fi

# ── [2] the exiting process must not touch it ───────────────────────────
echo "[2] a DIFFERENT Claude's SessionEnd leaves it open"
OUT_OLD="$(hook session-end OLD)"
if [ "$(session_is_open "$NEW_SESSION")" = "open" ]; then
    pass "session #$NEW_SESSION survived the other process's SessionEnd"
else
    oops "session #$NEW_SESSION was closed by another Claude's SessionEnd — this is the bug"
fi
if echo "$OUT_OLD" | grep -q "left 1 session(s) open"; then
    pass "and it said so instead of reporting nothing to close"
else
    oops "the skip was silent: $OUT_OLD"
fi

# ── [3] but its owner still closes it ───────────────────────────────────
echo "[3] the owning Claude's SessionEnd does close it"
OUT_OWN="$(hook session-end NEW)"
if [ "$(session_is_open "$NEW_SESSION")" = "closed" ]; then
    pass "session #$NEW_SESSION closed by the process that owned it"
else
    oops "the owner's SessionEnd did not close its own session: $OUT_OWN"
fi
if [ ! -f "$RUN_DIR/claude-NEW.json" ]; then
    pass "the claim was released on the way out"
else
    oops "the claim file outlived its editor session"
fi

# ── [4] a resumed session is reported as resumed ────────────────────────
echo "[4] adopting an already-open session reports 'resumed'"
hook session-start A1 >/dev/null
RESUMED="$(open_sessions)"
OUT_A2="$(hook session-start A2)"
if echo "$OUT_A2" | grep -q "Session #$RESUMED resumed"; then
    pass "the second SessionStart adopted #$RESUMED and said 'resumed'"
else
    oops "a resumed session was misreported: $(echo "$OUT_A2" | grep -i 'Session #' || echo '(no session line)')"
fi
if [ "$(open_sessions)" = "$RESUMED" ]; then
    pass "and no second session was created for the same module"
else
    oops "session churn: open sessions are now $(open_sessions)"
fi
# Both claims name the same brain session, so whichever process exits first
# must leave it to the other.
OUT_A1_END="$(hook session-end A1)"
if [ "$(session_is_open "$RESUMED")" = "open" ]; then
    pass "the first of two processes sharing a session leaves it open"
else
    oops "a shared session was closed while another process still held it: $OUT_A1_END"
fi
hook session-end A2 >/dev/null
if [ "$(session_is_open "$RESUMED")" = "closed" ]; then
    pass "the last one out closes it"
else
    oops "nobody closed the shared session"
fi

# ── [5] no regression: an unclaimed session is still auto-closed ────────
#
# The reason the feature exists: an agent opens a session through the MCP
# server and never calls end_session. With no claim naming it, SessionEnd must
# still close it — otherwise the fix would have traded one silent failure for
# another.
echo "[5] an unclaimed open session is still closed on exit"
rm -f "$RUN_DIR"/claude-*.json
UNCLAIMED="$(node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  const ctx = ServerContext.initialize();
  const m = ctx.db.modules.listByProject(ctx.project.id).find(x => x.name === 'cli');
  const s = ctx.db.sessions.start(m.id);
  console.log(s.id);
  ctx.close();
" 2>/dev/null)"
if [ "$(session_is_open "$UNCLAIMED")" = "open" ]; then
    pass "session #$UNCLAIMED opened with no claim naming it"
else
    oops "could not create an unclaimed session"
fi
hook session-end ORPHAN >/dev/null
if [ "$(session_is_open "$UNCLAIMED")" = "closed" ]; then
    pass "SessionEnd closed it — the safety net is intact"
else
    oops "an unclaimed session survived SessionEnd: the auto-close guarantee is gone"
fi

# ── [5b] the degradation path is visible, not silent ───────────────────
#
# Everything above rests on `session_id` being the same at a session's
# SessionStart and its SessionEnd. Claude Code's hook reference documents that
# the field is always sent, but NOT that the value is stable. If it ever is
# not, SessionEnd finds no claim of its own — and must say so, because the
# symptom (a session that never closed) is otherwise indistinguishable from
# the bug this fix replaced.
echo "[5b] a SessionEnd whose id claimed nothing says so"
rm -f "$RUN_DIR"/claude-*.json
hook session-start OWNER >/dev/null
HELD="$(open_sessions)"
OUT_STRANGER="$(hook session-end STRANGER)"
if echo "$OUT_STRANGER" | grep -q 'no claim of our own'; then
    pass "it reported having no claim instead of closing blind"
else
    oops "the degradation was silent: $OUT_STRANGER"
fi
if [ "$(session_is_open "$HELD")" = "open" ]; then
    pass "and erred toward leaving the claimed session alone"
else
    oops "session #$HELD was closed by a process that did not own it"
fi
hook session-end OWNER >/dev/null

# ── [6] a killed process's claim is debris, not a lock ──────────────────
echo "[6] stale claims are pruned"
mkdir -p "$RUN_DIR"
cat > "$RUN_DIR/claude-ANCIENT.json" <<'CLAIM'
{ "claudeSessionId": "ANCIENT", "projectId": 1, "sessionIds": [999], "at": "2020-01-01T00:00:00.000Z" }
CLAIM
cat > "$RUN_DIR/claude-FRESH.json" <<CLAIM
{ "claudeSessionId": "FRESH", "projectId": 1, "sessionIds": [998], "at": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" }
CLAIM
hook session-start PRUNER >/dev/null
if [ ! -f "$RUN_DIR/claude-ANCIENT.json" ]; then
    pass "a claim from 2020 was removed"
else
    oops "stale claims accumulate forever in $RUN_DIR"
fi
if [ -f "$RUN_DIR/claude-FRESH.json" ]; then
    pass "a current claim was left alone"
else
    oops "pruning deleted a live claim — it would stop protecting its session"
fi
hook session-end PRUNER >/dev/null

# ── [7] a malformed claim must not break the hook ───────────────────────
echo "[7] an unreadable claim is ignored, not fatal"
printf 'not json at all' > "$RUN_DIR/claude-BROKEN.json"
OUT_BROKEN="$(hook session-start AFTERBROKEN)"
if echo "$OUT_BROKEN" | grep -q 'MyJarbis ·'; then
    pass "SessionStart still produced its greeting"
else
    oops "a malformed claim broke the hook: $OUT_BROKEN"
fi
LAST="$(open_sessions)"
if [ -z "$LAST" ]; then
    oops "SessionStart opened no session, so the close below proves nothing"
else
    hook session-end AFTERBROKEN >/dev/null
    if [ "$(session_is_open "$LAST")" = "closed" ]; then
        pass "and SessionEnd still closed its own session"
    else
        oops "SessionEnd failed with a malformed claim present"
    fi
fi

echo
if [ "$FAILED" -eq 0 ]; then
    echo "✓ v045-sessionend-ownership: all assertions passed"
    exit 0
fi
echo "✗ v045-sessionend-ownership: $FAILED assertion(s) failed"
exit 1
