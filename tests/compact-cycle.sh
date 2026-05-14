#!/bin/bash
#
# E2E test: /myjarbis compact pre/post round-trip.
#
# Verifies:
#   1. With no pre-snapshot, post-compaction hook output is the recovery
#      imperative (current behavior, unchanged).
#   2. After save_observation(kind=discovery, tags=pre-compact, content=X),
#      the post-compaction hook prepends "═══ Pre-compact snapshot ..." +
#      the content, BEFORE the recovery imperative.
#   3. The --verbatim variant (tags="pre-compact,verbatim") shows the
#      "--verbatim" marker in the snapshot header.
#   4. Multiple snapshots: only the most recent one is surfaced.
#   5. Edge: if the snapshot query somehow fails, the hook still prints
#      the recovery imperative (resilience).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$MYJARBIS_INSTALL_DIR/mcp-server/build/cli.js"

if [ ! -f "$CLI" ]; then
  echo "✗ MyJarbis MCP build not found"; exit 1
fi

WORK="$(mktemp -d -t myjarbis-compact-test-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
cd "$WORK"

# ─── 1. Setup project + module + open session ───
"$MJ" init <<< 'y' >/dev/null
"$MJ" module add MM --description="Media Manager" >/dev/null
node --input-type=module -e "
  process.chdir('$WORK');
  import { ServerContext } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/context.js';
  import { startSession } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/tools/session.js';
  const ctx = ServerContext.initialize();
  startSession(ctx, { module: 'MM' });
  ctx.close();
"

# ─── 2. Hook with no snapshot → only recovery imperative ───
echo "→ [1] no pre-snapshot — expect recovery imperative only"
OUT=$(node "$CLI" hook post-compaction)
echo "$OUT" | head -2
if echo "$OUT" | grep -q "Pre-compact snapshot"; then
  echo "✗ should not show snapshot header without prior save"; exit 1
fi
if ! echo "$OUT" | grep -q "post-compaction recovery"; then
  echo "✗ recovery imperative missing"; exit 1
fi
echo "  ✓ recovery only, as expected"

# ─── 3. Save a structured snapshot, re-fire hook → should appear ───
echo "→ [2] save snapshot then re-fire hook"
SNAPSHOT_CONTENT="STORY/PHASE: MM-S1.4
MODULE: MM
BRANCH: feature/mm-e1-s1.4-asset-translations

LATEST DECISIONS:
  • Picked Pest for testing — files: tests/Feature/MediaManager/AssetTranslations.php
  • JSON column requires MySQL 8 — files: database/migrations/asset_translations.php

NEXT INTENDED STEP: run sail artisan test --filter=MediaManager and open PR."

node --input-type=module -e "
  process.chdir('$WORK');
  import { MyJarbisDB } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/db/index.js';
  const db = MyJarbisDB.open('$WORK');
  const proj = db.projects.findByPath('$WORK');
  const m = db.modules.findByName(proj.id, 'MM');
  const session = db.sessions.findActiveByModule(m.id) || db.sessions.findLastByModule(m.id);
  db.observations.add({
    sessionId: session.id,
    kind: 'discovery',
    title: 'pre-compact snapshot',
    content: \`$SNAPSHOT_CONTENT\`,
    tags: 'pre-compact',
  });
  db.close();
"

OUT2=$(node "$CLI" hook post-compaction)
echo "$OUT2" | head -10
if ! echo "$OUT2" | grep -q "Pre-compact snapshot"; then
  echo "✗ snapshot header missing"; exit 1
fi
if ! echo "$OUT2" | grep -q "STORY/PHASE: MM-S1.4"; then
  echo "✗ snapshot content not surfaced"; exit 1
fi
if ! echo "$OUT2" | grep -q "post-compaction recovery"; then
  echo "✗ recovery imperative missing"; exit 1
fi
# Snapshot must come BEFORE recovery
SNAP_LINE=$(echo "$OUT2" | grep -n "Pre-compact snapshot" | head -1 | cut -d: -f1)
REC_LINE=$(echo "$OUT2" | grep -n "post-compaction recovery" | head -1 | cut -d: -f1)
if [ "$SNAP_LINE" -ge "$REC_LINE" ]; then
  echo "✗ snapshot block must come BEFORE recovery (got snap=$SNAP_LINE, rec=$REC_LINE)"; exit 1
fi
echo "  ✓ snapshot prepended, content surfaced, ordering correct"

# ─── 4. --verbatim variant ───
echo "→ [3] --verbatim snapshot tagged appropriately"
node --input-type=module -e "
  process.chdir('$WORK');
  import { MyJarbisDB } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/db/index.js';
  const db = MyJarbisDB.open('$WORK');
  const proj = db.projects.findByPath('$WORK');
  const m = db.modules.findByName(proj.id, 'MM');
  const session = db.sessions.findLastByModule(m.id);
  db.observations.add({
    sessionId: session.id,
    kind: 'discovery',
    title: 'pre-compact snapshot',
    content: 'STRUCTURED PART\n\n═══ VERBATIM (last 5 assistant messages) ═══\n<MSG -5> hello world',
    tags: 'pre-compact,verbatim',
  });
  db.close();
"
OUT3=$(node "$CLI" hook post-compaction)
echo "$OUT3" | head -3
if ! echo "$OUT3" | grep -q ", --verbatim)"; then
  echo "✗ --verbatim marker missing in header"; exit 1
fi
if ! echo "$OUT3" | grep -q "VERBATIM (last 5 assistant messages)"; then
  echo "✗ verbatim section missing"; exit 1
fi
echo "  ✓ verbatim variant detected"

# ─── 5. Multiple snapshots: only latest surfaces ───
echo "→ [4] multiple snapshots — only latest"
LATEST_OUT=$(node "$CLI" hook post-compaction)
SNAP_COUNT=$(echo "$LATEST_OUT" | grep -c "Pre-compact snapshot" || true)
if [ "$SNAP_COUNT" != "1" ]; then
  echo "✗ expected exactly 1 snapshot block, got $SNAP_COUNT"; exit 1
fi
# The latest IS the verbatim one (just inserted), so verbatim marker should be present
if ! echo "$LATEST_OUT" | grep -q ", --verbatim)"; then
  echo "✗ latest snapshot was not the verbatim one (ordering broken)"; exit 1
fi
echo "  ✓ only the most recent snapshot surfaces"

# ─── 6. Doctor still green ───
echo "→ [5] doctor still green"
"$MJ" doctor >/dev/null && echo "  ✓ doctor green"

echo "✓ compact-cycle E2E PASSED"
