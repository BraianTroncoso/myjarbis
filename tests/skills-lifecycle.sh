#!/bin/bash
#
# E2E test: skills baseline + materialization + cleanup on module switch.
#
# Verifies:
#   1. seedNewProject seeds 10 baseline skills as project-level rows.
#   2. `myjarbis skill add` creates module-level skills.
#   3. `myjarbis skill materialize` writes <project>/.claude/skills/
#      myjarbis-<name>/SKILL.md only for the active module's set.
#   4. Switching modules removes the previous module's skills from FS
#      (cleanup_stale).
#   5. Re-materialize is idempotent (written=[], unchanged=N, removed=[]).
#   6. Editing a skill content + re-materialize updates only that file.
#
# Exits 0 on success.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$MYJARBIS_INSTALL_DIR/mcp-server/build/cli.js"
SEED_HELPER="$MYJARBIS_INSTALL_DIR/mcp-server/build/db/migrate.js"

if [ ! -f "$CLI" ]; then
  echo "✗ MyJarbis MCP build not found at $CLI"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-skills-test-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"

# ─── seed project + 2 modules ───
node --input-type=module -e "
import { seedNewProject } from '$SEED_HELPER';
import { MyJarbisDB } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/db/index.js';
const r = seedNewProject('$WORK', { name: 'skills-test', framework: 'generic' });
const db = MyJarbisDB.open('$WORK');
db.modules.create(r.projectId, 'MM', 'Media Manager');
db.modules.create(r.projectId, 'PageBuilder', 'Page Builder');
db.close();
console.log('seeded:', JSON.stringify(r));
"

cd "$WORK"

# ─── 1. baseline skills count ───
echo "→ verifying 10 baseline skills (project-level)"
"$MJ" skill list --scope=project > "$WORK/proj-skills.json"
node --input-type=module -e "
  import { readFileSync } from 'fs';
  const r = JSON.parse(readFileSync('$WORK/proj-skills.json', 'utf-8'));
  const names = r.skills.map(s => s.name).sort();
  console.log('  baseline:', names.join(', '));
  const expected = ['bitacora-progress', 'commit-hygiene', 'compact-protocol',
                    'framework-detect', 'interaction-style', 'module-orchestration',
                    'observation-protocol', 'session-protocol', 'story-driven',
                    'subagent-delegation'];
  for (const e of expected) {
    if (!names.includes(e)) {
      console.error('✗ missing baseline skill:', e);
      process.exit(1);
    }
  }
  if (r.count !== 10) { console.error('✗ expected 10 baseline, got', r.count); process.exit(1); }
"

# ─── 2. add module-level skills ───
echo "→ adding module-level skills"
cat > "$WORK/sk-mm.md" << 'EOF'
---
name: mm-pixel-perfect
description: Pixel-perfect Blade against design package
---
# MM pixel-perfect
Use exact HTML from design package.
EOF
cat > "$WORK/sk-pb.md" << 'EOF'
---
name: pb-elements
description: Page Builder element catalog
---
# PB elements
Catalog of available block elements.
EOF
"$MJ" skill add mm-pixel-perfect --content-from="$WORK/sk-mm.md" --module=MM --description="MM-only" >/dev/null
"$MJ" skill add pb-elements --content-from="$WORK/sk-pb.md" --module=PageBuilder --description="PB-only" >/dev/null

# ─── 3. materialize for MM ───
echo "→ materialize for MM"
"$MJ" skill materialize --module=MM > "$WORK/mat1.json"
node --input-type=module -e "
  import { readFileSync, readdirSync } from 'fs';
  const m = JSON.parse(readFileSync('$WORK/mat1.json', 'utf-8'));
  const dir = readdirSync('$WORK/.claude/skills').sort();
  console.log('  written:', m.written.sort().join(', '));
  console.log('  fs:     ', dir.join(', '));
  // Should have 10 baselines + mm-pixel-perfect (NO pb-elements)
  const expectedFolders = [
    'myjarbis-bitacora-progress', 'myjarbis-commit-hygiene',
    'myjarbis-compact-protocol', 'myjarbis-framework-detect',
    'myjarbis-interaction-style', 'myjarbis-mm-pixel-perfect',
    'myjarbis-module-orchestration', 'myjarbis-observation-protocol',
    'myjarbis-session-protocol', 'myjarbis-story-driven',
    'myjarbis-subagent-delegation',
  ].sort();
  if (JSON.stringify(dir) !== JSON.stringify(expectedFolders)) {
    console.error('✗ mismatch. expected:', expectedFolders);
    process.exit(1);
  }
"

# ─── 4. re-materialize idempotent ───
echo "→ re-materialize for MM (expect all unchanged)"
"$MJ" skill materialize --module=MM > "$WORK/mat2.json"
node --input-type=module -e "
  import { readFileSync } from 'fs';
  const m = JSON.parse(readFileSync('$WORK/mat2.json', 'utf-8'));
  if (m.written.length !== 0) { console.error('✗ written should be empty:', m.written); process.exit(1); }
  if (m.unchanged.length !== 11) { console.error('✗ unchanged should be 11 (10 baselines + mm-pixel-perfect):', m.unchanged); process.exit(1); }
  if (m.removed.length !== 0) { console.error('✗ removed should be empty:', m.removed); process.exit(1); }
"

# ─── 5. switch to PageBuilder, mm-pixel-perfect should disappear ───
echo "→ switch to PageBuilder"
"$MJ" skill materialize --module=PageBuilder > "$WORK/mat3.json"
node --input-type=module -e "
  import { readFileSync, readdirSync } from 'fs';
  const m = JSON.parse(readFileSync('$WORK/mat3.json', 'utf-8'));
  const dir = readdirSync('$WORK/.claude/skills').sort();
  console.log('  written:', m.written.join(', '));
  console.log('  removed:', m.removed.join(', '));
  if (!m.removed.includes('mm-pixel-perfect')) {
    console.error('✗ mm-pixel-perfect should have been removed'); process.exit(1);
  }
  if (!m.written.includes('pb-elements')) {
    console.error('✗ pb-elements should have been written'); process.exit(1);
  }
  if (dir.includes('myjarbis-mm-pixel-perfect')) {
    console.error('✗ mm-pixel-perfect folder still exists in FS'); process.exit(1);
  }
  if (!dir.includes('myjarbis-pb-elements')) {
    console.error('✗ pb-elements folder missing'); process.exit(1);
  }
"

# ─── 6. edit content via add_skill (idempotent UPSERT) ───
echo "→ edit pb-elements content + re-materialize"
cat > "$WORK/sk-pb-v2.md" << 'EOF'
---
name: pb-elements
description: Page Builder element catalog (v2)
---
# PB elements
Updated content with extra notes.
EOF
"$MJ" skill add pb-elements --content-from="$WORK/sk-pb-v2.md" --module=PageBuilder --description="PB v2" > "$WORK/edit.json"
node --input-type=module -e "
  import { readFileSync } from 'fs';
  const r = JSON.parse(readFileSync('$WORK/edit.json', 'utf-8'));
  if (r.status !== 'updated') { console.error('✗ expected status=updated, got', r.status); process.exit(1); }
"
"$MJ" skill materialize --module=PageBuilder > "$WORK/mat4.json"
node --input-type=module -e "
  import { readFileSync } from 'fs';
  const m = JSON.parse(readFileSync('$WORK/mat4.json', 'utf-8'));
  if (!m.written.includes('pb-elements')) { console.error('✗ pb-elements should be re-written'); process.exit(1); }
  const skillFile = readFileSync('$WORK/.claude/skills/myjarbis-pb-elements/SKILL.md', 'utf-8');
  if (!skillFile.includes('Updated content with extra notes')) { console.error('✗ FS not updated'); process.exit(1); }
"

# ─── 7. delete skill cleans FS on materialize ───
echo "→ delete pb-elements + re-materialize (cleanup)"
"$MJ" skill delete pb-elements --module=PageBuilder >/dev/null
"$MJ" skill materialize --module=PageBuilder > "$WORK/mat5.json"
node --input-type=module -e "
  import { readFileSync, existsSync } from 'fs';
  const m = JSON.parse(readFileSync('$WORK/mat5.json', 'utf-8'));
  if (!m.removed.includes('pb-elements')) { console.error('✗ pb-elements should be removed'); process.exit(1); }
  if (existsSync('$WORK/.claude/skills/myjarbis-pb-elements')) {
    console.error('✗ pb-elements folder still exists'); process.exit(1);
  }
"

echo "✓ skills-lifecycle E2E PASSED"
