#!/bin/bash
#
# E2E test: the `files` column of an observation must be correctable.
#
# `save_observation` has always accepted `files`, and `update_observation` has
# always been the tool for fixing a note in place — but `files` was not among
# the fields it could set. The consequence is recorded in this project's own
# brain: a note was saved with the wrong paths, could not be corrected, and the
# right paths had to be written into the prose while the column kept claiming
# something false. A column that cannot be corrected is worse than no column,
# because it still reads as authoritative.
#
# What it pins:
#
#   · `files` can be replaced on its own, with no other field passed — so the
#     "nothing to update" guard accepts it as a real change
#   · the new value lands in the column, not just in the tool's return value
#   · the result echoes the stored `files`, so a caller can see the correction
#     took without reading the row
#   · updating a DIFFERENT field without passing `files` PRESERVES the paths.
#     This is the data-loss half: if absence meant "clear", every title typo
#     fixed from then on would quietly drop the paths of the note it fixed
#   · an explicit empty string CLEARS the column to NULL — the same NULL
#     `save_observation` writes when no paths are given, so "no paths" stays
#     one value instead of becoming NULL-or-empty-string
#   · the topic_key route gets the same behaviour as the by-id route
#
# Exits 0 on success, non-zero on the first failed assertion.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"

if [ ! -f "$B/context.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-obsfiles-XXXXXX)"
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
"$MJ" module add checkout --description="Checkout flow" >/dev/null
"$MJ" module use checkout >/dev/null

# Reads one column of one observation straight out of the brain, so every
# assertion below is about the stored row and not about what a tool claimed.
read_col() {
  node --input-type=module -e "
    process.chdir('$WORK/proj');
    import { ServerContext } from '$B/context.js';
    const ctx = ServerContext.initialize();
    const row = ctx.db.db.prepare('SELECT $2 AS v FROM observations WHERE id = ?').get($1);
    ctx.close();
    console.log(!row ? '<no row>' : row.v === null ? 'NULL' : row.v);
  " 2>/dev/null || echo '<read failed>'
}

# ── [0] a note saved with the wrong paths ─────────────────────────
echo "[0] save_observation stores the (wrong) paths"
OBS_ID=$(node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { startSession } from '$B/tools/session.js';
  import { saveObservation } from '$B/tools/observations.js';
  const ctx = ServerContext.initialize();
  startSession(ctx, { module: 'checkout' });
  const r = saveObservation(ctx, {
    kind: 'discovery',
    title: 'The files column was not correctable',
    content: 'WHY: update_observation had no files parameter. WHAT: wrong paths stuck. HOW: add it.',
    files: 'src/wrong-one.ts,src/wrong-two.ts',
  });
  ctx.close();
  console.log(r.observationId);
")
STORED=$(read_col "$OBS_ID" files)
if [ "$STORED" = "src/wrong-one.ts,src/wrong-two.ts" ]; then
  pass "observation #$OBS_ID saved with files='$STORED'"
else
  oops "save_observation did not store the paths, got: $STORED"
fi

# ── [1] files replaced on its own ─────────────────────────────────
echo "[1] update_observation sets files"
# Passing files and nothing else also proves the "nothing to update" refine
# counts it as a change — otherwise correcting only the paths would be refused.
ECHOED=$(node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { updateObservation } from '$B/tools/refs.js';
  const ctx = ServerContext.initialize();
  const r = updateObservation(ctx, {
    observation_id: $OBS_ID,
    files: 'global/mcp-server/src/tools/refs.ts,global/mcp-server/src/db/index.ts',
  });
  ctx.close();
  console.log(r.files === null ? 'NULL' : r.files);
" 2>/dev/null || echo '<the call was rejected>')
STORED=$(read_col "$OBS_ID" files)
WANT='global/mcp-server/src/tools/refs.ts,global/mcp-server/src/db/index.ts'
if [ "$STORED" = "$WANT" ]; then
  pass "the column now reads the corrected paths"
else
  oops "files did not land in the column: '$STORED'"
fi
if [ "$ECHOED" = "$STORED" ]; then
  pass "the result echoes the stored value"
else
  oops "the result echoed '$ECHOED' but the row holds '$STORED'"
fi

# ── [2] another field, without files → paths preserved ────────────
echo "[2] updating the title leaves files untouched"
# The data-loss case. Omission must mean "leave it alone", like every other
# field of this tool; if it meant "clear", fixing a typo would silently strip
# the paths of the note being fixed.
node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { updateObservation } from '$B/tools/refs.js';
  const ctx = ServerContext.initialize();
  updateObservation(ctx, {
    observation_id: $OBS_ID,
    title: 'update_observation can now correct the files column',
  });
  ctx.close();
" >/dev/null 2>&1 || true
STORED=$(read_col "$OBS_ID" files)
if [ "$STORED" = "$WANT" ]; then
  pass "files survived an unrelated update"
else
  oops "an update without files changed the column to '$STORED'"
fi
TITLE=$(read_col "$OBS_ID" title)
if [ "$TITLE" = "update_observation can now correct the files column" ]; then
  pass "and the title really was updated (the step was not a no-op)"
else
  oops "the title did not change, so step [2] proved nothing: '$TITLE'"
fi

# ── [3] the empty string clears ───────────────────────────────────
echo "[3] an explicit empty string clears the column"
node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { updateObservation } from '$B/tools/refs.js';
  const ctx = ServerContext.initialize();
  updateObservation(ctx, { observation_id: $OBS_ID, files: '' });
  ctx.close();
" >/dev/null 2>&1 || true
STORED=$(read_col "$OBS_ID" files)
if [ "$STORED" = "NULL" ]; then
  pass "cleared to NULL, the same empty that save_observation writes"
else
  oops "clearing left '$STORED' instead of NULL"
fi

# ── [4] the topic_key route behaves the same ──────────────────────
echo "[4] resolving by topic_key, not id"
TOPIC_ID=$(node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { saveObservation } from '$B/tools/observations.js';
  import { updateObservation } from '$B/tools/refs.js';
  const ctx = ServerContext.initialize();
  const saved = saveObservation(ctx, {
    kind: 'decision',
    title: 'Where the observation tools live',
    content: 'WHY: discoverability. WHAT: refs.ts holds update_observation. HOW: read it.',
    files: 'src/old.ts',
    topic_key: 'observations/files-column',
  });
  const r = updateObservation(ctx, {
    topic_key: 'observations/files-column',
    files: 'src/new.ts',
  });
  ctx.close();
  if (r.observationId !== saved.observationId) {
    console.error('topic_key resolved to a different note');
    process.exit(1);
  }
  console.log(r.observationId);
" 2>/dev/null || echo 0)
STORED=$(read_col "$TOPIC_ID" files)
if [ "$STORED" = "src/new.ts" ]; then
  pass "the topic_key route sets files too"
else
  oops "files via topic_key did not land: '$STORED'"
fi

# ── [5] an empty patch is still refused ───────────────────────────
echo "[5] a patch with no fields at all"
# Adding files to the guard must not weaken it into accepting nothing.
if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { updateObservation } from '$B/tools/refs.js';
  const ctx = ServerContext.initialize();
  try {
    updateObservation(ctx, { observation_id: $OBS_ID });
    console.error('an empty patch was accepted');
    ctx.close();
    process.exit(1);
  } catch (e) {
    ctx.close();
    if (!String(e.message).includes('nothing to update')) {
      console.error('wrong error:', e.message);
      process.exit(1);
    }
  }
" 2>/dev/null; then
  pass "refused with 'nothing to update'"
else
  oops "an empty patch was not refused as before"
fi

# ── [6] story_local_id, the same gap one column over ────────────────────
#
# A note filed against the wrong story was uncorrectable for exactly the same
# reason `files` was, and is just as invisible: nothing shows it until
# something queries by story.
echo "[6] story_local_id can be corrected and is preserved when omitted"
if node --input-type=module -e "
  process.chdir('$WORK/proj');
  import { ServerContext } from '$B/context.js';
  import { updateObservation } from '$B/tools/refs.js';
  const ctx = ServerContext.initialize();
  const a = updateObservation(ctx, { observation_id: $OBS_ID, story_local_id: 'SHOP-S9.9' });
  if (a.storyLocalId !== 'SHOP-S9.9') throw new Error('not set, got ' + a.storyLocalId);
  const b = updateObservation(ctx, { observation_id: $OBS_ID, title: 'refiled note' });
  if (b.storyLocalId !== 'SHOP-S9.9') throw new Error('not preserved, got ' + b.storyLocalId);
  const c = updateObservation(ctx, { observation_id: $OBS_ID, story_local_id: '' });
  if (c.storyLocalId !== null) throw new Error('empty string did not clear, got ' + c.storyLocalId);
  ctx.close();
" 2>/dev/null; then
  pass "set, preserved across an unrelated patch, and cleared by an empty string"
else
  oops "story_local_id does not behave like files"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ v045-update-observation-files: all assertions passed"
  exit 0
fi
echo "✗ v045-update-observation-files: $FAILED assertion(s) failed" >&2
exit 1
