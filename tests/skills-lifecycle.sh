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

# ─── hermetic HOME ────────────────────────────────────────────────
#
# An un-pinned MYJARBIS_HOME resolves to $HOME/.myjarbis (the developer's
# real shared brain) and the default registry to $MYJARBIS_INSTALL_DIR —
# i.e. into the checkout. Insurance even where this suite seeds its own db
# at an explicit path: nothing it does should be able to reach the real home.
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

# ─── seed project + 2 modules ───
node --input-type=module -e "
import { seedNewProject } from '$SEED_HELPER';
import { MyJarbisDB } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/db/index.js';
const r = seedNewProject('$WORK', { name: 'skills-test', framework: 'generic' });
const db = MyJarbisDB.open('$WORK');
// Writes need a bound tenant scope; there is no implicit 'current project'.
db.bindScope({ kind: 'project', id: r.projectId });
db.modules.create(r.projectId, 'checkout', 'Checkout flow');
db.modules.create(r.projectId, 'catalog', 'Catalog');
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
cat > "$WORK/sk-checkout.md" << 'EOF'
---
name: checkout-conventions
description: Checkout conventions against the design package
---
# checkout conventions
Use exact HTML from design package.
EOF
cat > "$WORK/sk-catalog.md" << 'EOF'
---
name: catalog-blocks
description: Catalog block library
---
# PB elements
Catalog of available block elements.
EOF
"$MJ" skill add checkout-conventions --content-from="$WORK/sk-checkout.md" --module=checkout --description="checkout-only" >/dev/null
"$MJ" skill add catalog-blocks --content-from="$WORK/sk-catalog.md" --module=catalog --description="catalog-only" >/dev/null

# ─── 3. materialize for checkout ───
echo "→ materialize for checkout"
"$MJ" skill materialize --module=checkout > "$WORK/mat1.json"
node --input-type=module -e "
  import { readFileSync, readdirSync } from 'fs';
  const m = JSON.parse(readFileSync('$WORK/mat1.json', 'utf-8'));
  const dir = readdirSync('$WORK/.claude/skills').sort();
  console.log('  written:', m.written.sort().join(', '));
  console.log('  fs:     ', dir.join(', '));
  // Should have 10 baselines + checkout-conventions (NO catalog-blocks)
  const expectedFolders = [
    'myjarbis-bitacora-progress', 'myjarbis-commit-hygiene',
    'myjarbis-compact-protocol', 'myjarbis-framework-detect',
    'myjarbis-interaction-style', 'myjarbis-checkout-conventions',
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
echo "→ re-materialize for checkout (expect all unchanged)"
"$MJ" skill materialize --module=checkout > "$WORK/mat2.json"
node --input-type=module -e "
  import { readFileSync } from 'fs';
  const m = JSON.parse(readFileSync('$WORK/mat2.json', 'utf-8'));
  if (m.written.length !== 0) { console.error('✗ written should be empty:', m.written); process.exit(1); }
  if (m.unchanged.length !== 11) { console.error('✗ unchanged should be 11 (10 baselines + checkout-conventions):', m.unchanged); process.exit(1); }
  if (m.removed.length !== 0) { console.error('✗ removed should be empty:', m.removed); process.exit(1); }
"

# ─── 5. switch to catalog, checkout-conventions should disappear ───
echo "→ switch to catalog"
"$MJ" skill materialize --module=catalog > "$WORK/mat3.json"
node --input-type=module -e "
  import { readFileSync, readdirSync } from 'fs';
  const m = JSON.parse(readFileSync('$WORK/mat3.json', 'utf-8'));
  const dir = readdirSync('$WORK/.claude/skills').sort();
  console.log('  written:', m.written.join(', '));
  console.log('  removed:', m.removed.join(', '));
  if (!m.removed.includes('checkout-conventions')) {
    console.error('✗ checkout-conventions should have been removed'); process.exit(1);
  }
  if (!m.written.includes('catalog-blocks')) {
    console.error('✗ catalog-blocks should have been written'); process.exit(1);
  }
  if (dir.includes('myjarbis-checkout-conventions')) {
    console.error('✗ checkout-conventions folder still exists in FS'); process.exit(1);
  }
  if (!dir.includes('myjarbis-catalog-blocks')) {
    console.error('✗ catalog-blocks folder missing'); process.exit(1);
  }
"

# ─── 6. edit content via add_skill (idempotent UPSERT) ───
echo "→ edit catalog-blocks content + re-materialize"
cat > "$WORK/sk-catalog-v2.md" << 'EOF'
---
name: catalog-blocks
description: Catalog block library (v2)
---
# PB elements
Updated content with extra notes.
EOF
"$MJ" skill add catalog-blocks --content-from="$WORK/sk-catalog-v2.md" --module=catalog --description="catalog v2" > "$WORK/edit.json"
node --input-type=module -e "
  import { readFileSync } from 'fs';
  const r = JSON.parse(readFileSync('$WORK/edit.json', 'utf-8'));
  if (r.status !== 'updated') { console.error('✗ expected status=updated, got', r.status); process.exit(1); }
"
"$MJ" skill materialize --module=catalog > "$WORK/mat4.json"
node --input-type=module -e "
  import { readFileSync } from 'fs';
  const m = JSON.parse(readFileSync('$WORK/mat4.json', 'utf-8'));
  if (!m.written.includes('catalog-blocks')) { console.error('✗ catalog-blocks should be re-written'); process.exit(1); }
  const skillFile = readFileSync('$WORK/.claude/skills/myjarbis-catalog-blocks/SKILL.md', 'utf-8');
  if (!skillFile.includes('Updated content with extra notes')) { console.error('✗ FS not updated'); process.exit(1); }
"

# ─── 7. delete skill cleans FS on materialize ───
echo "→ delete catalog-blocks + re-materialize (cleanup)"
"$MJ" skill delete catalog-blocks --module=catalog >/dev/null
"$MJ" skill materialize --module=catalog > "$WORK/mat5.json"
node --input-type=module -e "
  import { readFileSync, existsSync } from 'fs';
  const m = JSON.parse(readFileSync('$WORK/mat5.json', 'utf-8'));
  if (!m.removed.includes('catalog-blocks')) { console.error('✗ catalog-blocks should be removed'); process.exit(1); }
  if (existsSync('$WORK/.claude/skills/myjarbis-catalog-blocks')) {
    console.error('✗ catalog-blocks folder still exists'); process.exit(1);
  }
"

echo "✓ skills-lifecycle E2E PASSED"
