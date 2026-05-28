#!/bin/bash
#
# E2E test for the dx-batch-1 trio:
#   1. stale-resume warning surfaces in start_session + SessionStart hook
#      when the previous next_session is older than the threshold.
#   2. `myjarbis timeline <module>` prints sessions + observations in
#      chronological order (newest first) and supports --json + --limit.
#   3. `myjarbis hook install git-post-commit` writes a working
#      post-commit hook, and a real `git commit` triggers an auto
#      observation with the right kind, story_local_id, and tags.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$MYJARBIS_INSTALL_DIR/mcp-server/build/cli.js"

# The post-commit hook script calls `myjarbis` by name from PATH. We need
# the test to hit the local build, not whatever happens to be in
# ~/.myjarbis-global. Override PATH for the duration of the test.
export PATH="$REPO_ROOT/bin:$PATH"

if [ ! -f "$CLI" ]; then
  echo "✗ MyJarbis MCP build not found at $CLI"
  echo "  run: (cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build)"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-dx-batch-1-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
cd "$WORK"

# ──────────────────────────────────────────────────────────────────────
# Setup: init project + module + git repo (post-commit needs a real
# repo). Run as a quiet stranger so commit hooks can be tested.
# ──────────────────────────────────────────────────────────────────────
echo "→ [setup] init MyJarbis + git"
"$MJ" init >/dev/null <<< 'y'
"$MJ" module add ACME --description="Acme module" >/dev/null

git init -q
git config user.email "dx-batch-1@test.local"
git config user.name "dx-batch-1"
echo "hello" > seed.txt
git add seed.txt
git commit -q -m "chore: seed" --no-verify

# Pick the active module for the hook fast path + observations.
"$MJ" module use ACME >/dev/null

# ──────────────────────────────────────────────────────────────────────
# Feature 3: stale-resume warning
# ──────────────────────────────────────────────────────────────────────
echo "→ [3] stale-resume warning"

# Open + immediately close a session, then back-date ended_at to 30 days
# ago. start_session should report stale=true; the SessionStart hook
# fast path should print the stale_warning copy.
node --input-type=module -e "
  process.chdir('$WORK');
  import { ServerContext } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/context.js';
  import { startSession, endSession } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/tools/session.js';
  const ctx = ServerContext.initialize();
  startSession(ctx, { module: 'ACME' });
  endSession(ctx, { summary: 'first session', next_session: 'Mañana seguir con ACME-1' });
  // Backdate ended_at on the most recent closed session of ACME.
  const mod = ctx.db.modules.findByName(ctx.project.id, 'ACME');
  ctx.db.db.prepare(
    \"UPDATE sessions SET ended_at = datetime('now', '-30 days') WHERE id = (SELECT id FROM sessions WHERE module_id = ? ORDER BY started_at DESC LIMIT 1)\"
  ).run(mod.id);
  ctx.close();
"

# Now start_session again and inspect the JSON.
STALE_JSON=$(node --input-type=module -e "
  process.chdir('$WORK');
  import { ServerContext } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/context.js';
  import { startSession } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/tools/session.js';
  const ctx = ServerContext.initialize();
  const r = startSession(ctx, { module: 'ACME' });
  console.log(JSON.stringify({
    stale: r.previousSession?.stale,
    days: r.previousSession?.daysSinceClose,
    threshold: r.previousSession?.staleAfterDays,
    hint: r.hint
  }));
  ctx.close();
")
echo "  start_session returned: $STALE_JSON"

echo "$STALE_JSON" | grep -q '"stale":true' \
  || { echo "✗ stale flag should be true"; exit 1; }
echo "$STALE_JSON" | grep -q '"days":30' \
  || { echo "✗ daysSinceClose should be 30"; exit 1; }
echo "$STALE_JSON" | grep -q 'STALE RESUME' \
  || { echo "✗ hint should mention STALE RESUME"; exit 1; }
echo "  ✓ start_session surfaces stale=true with day count + warning hint"

# Hook fast path: should include the localized stale_warning copy.
HOOK_OUT=$(node "$CLI" hook session-start)
echo "$HOOK_OUT" | grep -q "más de 7 día" \
  || echo "$HOOK_OUT" | grep -q "more than 7 day" \
  || { echo "✗ hook should print stale_warning"; echo "$HOOK_OUT"; exit 1; }
echo "  ✓ SessionStart hook prints localized stale_warning"

# ──────────────────────────────────────────────────────────────────────
# Feature 2: myjarbis timeline
# ──────────────────────────────────────────────────────────────────────
echo "→ [2] timeline command"

# Add a couple of observations against a fresh session for ACME so the
# timeline has events besides the session lifecycle ones.
node --input-type=module -e "
  process.chdir('$WORK');
  import { ServerContext } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/context.js';
  import { startSession, endSession } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/tools/session.js';
  import { saveObservation } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/tools/observations.js';
  const ctx = ServerContext.initialize();
  startSession(ctx, { module: 'ACME' });
  saveObservation(ctx, { kind: 'decision', title: 'Decisión inicial', content: 'WHY · WHAT · HOW' });
  saveObservation(ctx, { kind: 'gotcha',   title: 'Cuidado con X',   content: 'no romper Y' });
  endSession(ctx, { summary: 'tested obs', next_session: 'continuar mañana' });
  ctx.close();
"

# JSON output: count + ordering.
TL_JSON=$("$MJ" timeline ACME --json)
echo "$TL_JSON" | head -3
echo "$TL_JSON" | grep -q '"module": "ACME"' \
  || { echo "✗ timeline --json should include module name"; exit 1; }
echo "$TL_JSON" | grep -q '"type": "observation"' \
  || { echo "✗ timeline --json should include observation events"; exit 1; }
echo "$TL_JSON" | grep -q '"type": "session_start"' \
  || { echo "✗ timeline --json should include session_start events"; exit 1; }
echo "  ✓ timeline --json shape OK"

# Pretty output: should mention the active module and at least one obs.
TL_PRETTY=$("$MJ" timeline ACME 2>&1)
echo "$TL_PRETTY" | grep -q "timeline of" \
  || { echo "✗ timeline pretty header missing"; echo "$TL_PRETTY"; exit 1; }
echo "$TL_PRETTY" | grep -qi "decision" \
  || { echo "✗ timeline should include the decision row"; echo "$TL_PRETTY"; exit 1; }
echo "  ✓ timeline pretty render OK"

# --limit honored.
LIM=$("$MJ" timeline ACME --json --limit=1 | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    const j=JSON.parse(d); console.log(j.count + '/' + j.limit);
  })")
[ "$LIM" = "1/1" ] || { echo "✗ --limit=1 should yield exactly 1 event, got $LIM"; exit 1; }
echo "  ✓ --limit honored"

# ──────────────────────────────────────────────────────────────────────
# Feature 1: post-commit hook installer + auto-observation
# ──────────────────────────────────────────────────────────────────────
echo "→ [1] post-commit hook installer + auto-observation"

# Install the hook.
INSTALL_OUT=$("$MJ" hook install git-post-commit 2>&1)
echo "$INSTALL_OUT" | grep -q "installed" \
  || { echo "✗ installer output should confirm install"; echo "$INSTALL_OUT"; exit 1; }
[ -x .git/hooks/post-commit ] \
  || { echo "✗ post-commit hook missing or not executable"; exit 1; }
grep -q "MyJarbis git-post-commit hook" .git/hooks/post-commit \
  || { echo "✗ post-commit hook content missing marker"; exit 1; }
echo "  ✓ hook installed at .git/hooks/post-commit"

# Idempotent re-install.
RERUN=$("$MJ" hook install git-post-commit 2>&1)
echo "$RERUN" | grep -q "already installed" \
  || { echo "✗ re-install should be a no-op"; echo "$RERUN"; exit 1; }
echo "  ✓ re-install is idempotent"

# Set a story_pattern in settings so the hook detects ACME-1 from the
# commit message.
node -e "
  const fs=require('fs'),p='.myjarbis/config/settings.json';
  const s=JSON.parse(fs.readFileSync(p,'utf-8'));
  s.story_pattern='ACME-\\\\d+';
  fs.writeFileSync(p, JSON.stringify(s,null,2));
"

# Reopen a session so the hook has somewhere to write to (the prior
# session was closed in step 3).
node --input-type=module -e "
  process.chdir('$WORK');
  import { ServerContext } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/context.js';
  import { startSession } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/tools/session.js';
  const ctx = ServerContext.initialize();
  startSession(ctx, { module: 'ACME' });
  ctx.close();
"

# Real commit with a story id in the message — must trigger the hook.
echo "world" > seed.txt
git add seed.txt
git commit -q -m "feat(acme): tweak seed for ACME-1 demo" 2> /tmp/dx-hook-stderr || true
HEAD_HASH=$(git rev-parse HEAD)
SHORT=${HEAD_HASH:0:8}
echo "  commit ${SHORT} created"

# Verify the observation landed.
OBS=$(node --input-type=module -e "
  process.chdir('$WORK');
  import { ServerContext } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/context.js';
  const ctx = ServerContext.initialize();
  const mod = ctx.db.modules.findByName(ctx.project.id, 'ACME');
  const rows = ctx.db.db.prepare(
    \"SELECT title, kind, story_local_id, tags FROM observations o JOIN sessions s ON s.id=o.session_id WHERE s.module_id=? AND tags LIKE '%git-post-commit%' ORDER BY o.id DESC LIMIT 1\"
  ).all(mod.id);
  console.log(JSON.stringify(rows[0] || null));
  ctx.close();
")
echo "  latest auto-observation: $OBS"

echo "$OBS" | grep -q "\"kind\":\"progress\"" \
  || { echo "✗ auto observation should be kind=progress"; exit 1; }
echo "$OBS" | grep -q "$SHORT" \
  || { echo "✗ title should mention short hash $SHORT"; exit 1; }
echo "$OBS" | grep -q "\"story_local_id\":\"ACME-1\"" \
  || { echo "✗ story_local_id should be detected from commit message"; exit 1; }
echo "  ✓ auto observation persisted with correct kind/title/story_id/tags"

# Idempotency: re-firing the same hook on the same HEAD must not create
# a duplicate observation.
COUNT_BEFORE=$(node --input-type=module -e "
  process.chdir('$WORK');
  import { ServerContext } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/context.js';
  const ctx = ServerContext.initialize();
  const mod = ctx.db.modules.findByName(ctx.project.id, 'ACME');
  const r = ctx.db.db.prepare(\"SELECT COUNT(*) AS n FROM observations o JOIN sessions s ON s.id=o.session_id WHERE s.module_id=? AND tags LIKE '%git-post-commit%'\").get(mod.id);
  console.log(r.n);
  ctx.close();
")
node "$CLI" hook git-post-commit >/dev/null 2>&1 || true
COUNT_AFTER=$(node --input-type=module -e "
  process.chdir('$WORK');
  import { ServerContext } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/context.js';
  const ctx = ServerContext.initialize();
  const mod = ctx.db.modules.findByName(ctx.project.id, 'ACME');
  const r = ctx.db.db.prepare(\"SELECT COUNT(*) AS n FROM observations o JOIN sessions s ON s.id=o.session_id WHERE s.module_id=? AND tags LIKE '%git-post-commit%'\").get(mod.id);
  console.log(r.n);
  ctx.close();
")
[ "$COUNT_BEFORE" = "$COUNT_AFTER" ] \
  || { echo "✗ re-running hook should be idempotent (was $COUNT_BEFORE, now $COUNT_AFTER)"; exit 1; }
echo "  ✓ re-running the hook on the same HEAD is idempotent"

echo ""
echo "✓ dx-batch-1 E2E PASSED (features 1-2-3)"
