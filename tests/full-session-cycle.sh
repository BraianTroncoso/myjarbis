#!/bin/bash
#
# E2E test: full session lifecycle in v0.2.
#
# Simulates a real Claude Code session round trip:
#   1. Init a fresh project (memory.db + 10 baseline skills materialized).
#   2. Create a module.
#   3. Run the SessionStart hook (no module preselected → menu).
#   4. start_session for the module → assert context loaded.
#   5. save_observation × 2 (decision + gotcha).
#   6. end_session(summary, next_session).
#   7. "Re-open Claude": run SessionStart hook again → assert it
#      surfaces the next_session text from step 6.
#   8. start_session again → assert previousSession.nextSession is set.
#   9. Skills materialization: assert .claude/skills/myjarbis-* present
#      on every transition; module-level skill appears when active,
#      disappears when switching to another module.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$MYJARBIS_INSTALL_DIR/mcp-server/build/cli.js"

if [ ! -f "$CLI" ]; then
  echo "✗ MyJarbis MCP build not found"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-cycle-test-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"

# ─── hermetic HOME ────────────────────────────────────────────────
#
# This suite runs `myjarbis init` for real, which registers the project in
# $HOME/.claude.json and writes $HOME/.claude/projects/<slug>/memory/; and
# an un-pinned MYJARBIS_HOME resolves to $HOME/.myjarbis, the developer's
# real shared brain. Unisolated runs accumulated there and in the registry
# next to the install. Keep all three inside $WORK.
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

cd "$WORK"

# 1. Init
echo "→ [1] init"
"$MJ" init >/dev/null <<< 'y'
[ -f .myjarbis/memory.db ] || { echo "✗ memory.db missing after init"; exit 1; }
[ -d .claude/skills ] || { echo "✗ .claude/skills missing"; exit 1; }
SKILL_COUNT=$(find .claude/skills -mindepth 1 -maxdepth 1 -type d -name 'myjarbis-*' | wc -l)
[ "$SKILL_COUNT" = "10" ] || { echo "✗ expected 10 baseline skills, got $SKILL_COUNT"; exit 1; }
echo "  ✓ memory.db + 10 baseline skills materialized"

# 2. Add module
echo "→ [2] module add checkout"
"$MJ" module add checkout --description="Checkout flow" >/dev/null
"$MJ" skill add checkout-conventions --module=checkout \
  --content-from=<(printf '%s\n' '---' 'name: checkout-conventions' 'description: checkout conventions' '---' '# checkout conventions') >/dev/null

# 3. SessionStart hook (no module preselected if there's >1; we have only checkout
#    + _general from migration, so 2; expect menu)
echo "→ [3] SessionStart hook output"
HOOK_OUT=$(node "$CLI" hook session-start)
echo "$HOOK_OUT" | head -3
# With no active module the hook prints a POINTER, not the menu: opening
# Claude in a directory is not a request to use MyJarbis. The menu itself is
# one `list_modules` away, which is what /jarbis does.
echo "$HOOK_OUT" | grep -q "none active" || { echo "✗ hook should report that no module is active"; exit 1; }
node --input-type=module -e "
import { ServerContext } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/context.js';
import { listModules } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/tools/discovery.js';
const ctx = ServerContext.initialize();
try {
  const d = listModules(ctx, {}).display || '';
  if (!/Modules \(/.test(d)) { console.error('display did not render the menu'); process.exit(1); }
} finally { ctx.close(); }
" || { echo "✗ list_modules should hand back the rendered menu"; exit 1; }

# 4. start_session for checkout (manually via DB; the agent would do this)
echo "→ [4] start_session via direct call → assert context payload"
node --input-type=module -e "
  process.chdir('$WORK');
  import { ServerContext } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/context.js';
  import { startSession, endSession } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/tools/session.js';
  import { saveObservation } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/tools/observations.js';
  import { materializeSkills } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/tools/skills.js';
  const ctx = ServerContext.initialize();
  const s = startSession(ctx, { module: 'checkout' });
  if (s.previousSession !== null) { console.error('✗ previousSession should be null on first start'); process.exit(1); }
  const mat = materializeSkills(ctx, { module: 'checkout' });
  if (!mat.written.includes('checkout-conventions')) { console.error('✗ checkout-conventions should be materialized'); process.exit(1); }
  saveObservation(ctx, { kind: 'decision', title: 'Picked Pest', content: 'WHY: faster than vanilla. WHAT: replaced PHPUnit. HOW: composer require pestphp.' });
  saveObservation(ctx, { kind: 'gotcha',   title: 'JSON column needs MySQL 8', content: 'order_items.metadata is JSON.' });
  endSession(ctx, { summary: 'Pest installed and verified', next_session: 'Continuar con SHOP-S1.4 mañana: migración order_items.' });
  ctx.close();
  console.log('  ✓ session #' + s.sessionId + ' opened, 2 observations, closed with next_session');
"

# 5. Verify checkout-conventions is on disk
[ -d .claude/skills/myjarbis-checkout-conventions ] || { echo "✗ checkout-conventions folder missing"; exit 1; }

# 6. Re-fire SessionStart hook → should show checkout's next_session
echo "→ [6] re-fire SessionStart hook (simulating reopening Claude)"
# Pick the module first, which is what "reopening Claude to carry on" means.
# The hook only loads a module's context — and its handoff — when one is
# active; with none it prints a pointer and stays out of the way.
"$MJ" module use checkout >/dev/null 2>&1
HOOK_OUT2=$(node "$CLI" hook session-start)
echo "$HOOK_OUT2" | tail -5
if ! echo "$HOOK_OUT2" | grep -q "Continuar con SHOP-S1.4 mañana"; then
  echo "✗ hook output should include the next_session text"
  echo "--- HOOK_OUT2 ---"
  echo "$HOOK_OUT2"
  exit 1
fi
echo "  ✓ next_session surfaced by hook"

# Undo the two side effects of picking the module above: `module use` makes
# every later hook auto-start, and the hook just opened a session. Step 7
# asserts on previousSession, which would otherwise be that auto-started one
# instead of the session closed in step 4.
"$MJ" module unset >/dev/null 2>&1
node --input-type=module -e "
  process.chdir('$WORK');
  import { ServerContext } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/context.js';
  const ctx = ServerContext.initialize();
  ctx.db.db.prepare('DELETE FROM sessions WHERE ended_at IS NULL').run();
  ctx.close();
" >/dev/null 2>&1 || true

# 7. start_session again → previousSession should be populated
echo "→ [7] start_session again → previousSession populated"
node --input-type=module -e "
  process.chdir('$WORK');
  import { ServerContext } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/context.js';
  import { startSession } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/tools/session.js';
  const ctx = ServerContext.initialize();
  const s = startSession(ctx, { module: 'checkout' });
  if (!s.previousSession) { console.error('✗ previousSession should NOT be null'); process.exit(1); }
  if (!s.previousSession.nextSession || !s.previousSession.nextSession.includes('SHOP-S1.4')) {
    console.error('✗ previousSession.nextSession missing/incorrect:', s.previousSession);
    process.exit(1);
  }
  console.log('  ✓ previousSession.nextSession =', s.previousSession.nextSession.slice(0, 60) + '...');
  ctx.close();
"

# 8. Switch to _general (module already exists) → checkout-conventions should disappear
echo "→ [8] switch module → skills cleanup"
node --input-type=module -e "
  process.chdir('$WORK');
  import { ServerContext } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/context.js';
  import { materializeSkills } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/tools/skills.js';
  const ctx = ServerContext.initialize();
  const r = materializeSkills(ctx, { module: '_general' });
  if (!r.removed.includes('checkout-conventions')) {
    console.error('✗ checkout-conventions should be removed when switching away'); process.exit(1);
  }
  console.log('  ✓ checkout-conventions cleaned up (removed:', r.removed.join(','), ')');
  ctx.close();
"
[ ! -d .claude/skills/myjarbis-checkout-conventions ] || { echo "✗ folder still on disk"; exit 1; }

# 9. doctor must still pass
echo "→ [9] doctor"
"$MJ" doctor >/dev/null && echo "  ✓ doctor green" || { echo "✗ doctor failed"; exit 1; }

echo "✓ full-session-cycle E2E PASSED"
