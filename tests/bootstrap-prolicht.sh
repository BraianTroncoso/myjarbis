#!/bin/bash
#
# E2E test: bootstrap of the prolicht project (12 .md + 1 JSON).
#
# Verifies that `myjarbis import` correctly populates project_context,
# module_context, and module_context-as-stories from a real-world
# fixture (the user's actual prolicht/agents tree). Asserts:
#   1. All imports succeed with status=inserted on first run.
#   2. Stats show expected counts (152 stories from MM_Jira_Bulk.json,
#      N project_context, N module_context).
#   3. Re-importing the same files yields status=unchanged (hash idempotency).
#
# Sources:
#   - $PROLICHT_AGENTS (default /home/braianaxeltroncosodeveloper/dev/prolicht/agents)
#   - The MyJarbis MCP server build at $MYJARBIS_INSTALL_DIR (default
#     ../global from the repo root).
#
# Exits 0 on success, non-zero on any assertion failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROLICHT_AGENTS="${PROLICHT_AGENTS:-/home/braianaxeltroncosodeveloper/dev/prolicht/agents}"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$MYJARBIS_INSTALL_DIR/mcp-server/build/cli.js"
SEED_HELPER="$MYJARBIS_INSTALL_DIR/mcp-server/build/db/migrate.js"

# ─── preflight ───
if [ ! -d "$PROLICHT_AGENTS/backend/prolicht" ]; then
  echo "✗ Fixture not found at $PROLICHT_AGENTS/backend/prolicht"
  echo "  Set PROLICHT_AGENTS=<path> to override."
  exit 1
fi
if [ ! -f "$CLI" ]; then
  echo "✗ MyJarbis MCP build not found at $CLI — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

# ─── setup tmp project ───
WORK="$(mktemp -d -t myjarbis-prolicht-test-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"

# Copy the relevant fixtures into the tmp project, preserving the
# directory layout the user has in real life.
mkdir -p "$WORK/agents/backend/prolicht/MM"
SRC="$PROLICHT_AGENTS/backend/prolicht"

# Project-level docs
for f in WORKFLOW.md PLAN.md REPORT-JIRA.md ERRORS.md DEFINICION_FUNCIONAL_APP.md CURRENT.md; do
  if [ -f "$SRC/$f" ]; then
    cp "$SRC/$f" "$WORK/agents/backend/prolicht/$f"
  fi
done

# Module-level docs (MM)
for f in WORKFLOW.md PLAN.md PROGRESS.md MM_Functional_Document.md MM_Use_Cases.md MM_Jira_Bulk.json; do
  if [ -f "$SRC/MM/$f" ]; then
    cp "$SRC/MM/$f" "$WORK/agents/backend/prolicht/MM/$f"
  fi
done

# ─── seed project + module via seedNewProject (no init CLI yet in v0.2) ───
node --input-type=module -e "
import { seedNewProject } from '$SEED_HELPER';
import { MyJarbisDB } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/db/index.js';
const r = seedNewProject('$WORK', { name: 'prolicht-test', framework: 'laravel' });
const db = MyJarbisDB.open('$WORK');
db.modules.create(r.projectId, 'MM', 'Media Manager');
db.close();
console.log('seeded:', JSON.stringify(r));
"

# ─── imports ───
cd "$WORK"
import_md() {
  local path="$1" target="$2" kind="$3"
  if [ -f "$path" ]; then
    echo "  import_md $path → $target [$kind]"
    "$MJ" import "$path" --target="$target" --kind="$kind" >/dev/null
  fi
}
import_json() {
  local path="$1" target="$2" kind="$3" mapping="$4"
  if [ -f "$path" ]; then
    echo "  import_json $path → $target [$kind] mapping=$mapping"
    "$MJ" import "$path" --target="$target" --kind="$kind" --mapping="$mapping" >/dev/null
  fi
}

echo "→ first-pass imports"
import_md  agents/backend/prolicht/WORKFLOW.md             project        workflow
import_md  agents/backend/prolicht/PLAN.md                 project        plan
import_md  agents/backend/prolicht/REPORT-JIRA.md          project        jira_rules
import_md  agents/backend/prolicht/ERRORS.md               project        error_log
import_md  agents/backend/prolicht/DEFINICION_FUNCIONAL_APP.md project    functional_spec
import_md  agents/backend/prolicht/CURRENT.md              project        other
import_md  agents/backend/prolicht/MM/WORKFLOW.md          module:MM      workflow
import_md  agents/backend/prolicht/MM/PLAN.md              module:MM      plan
import_md  agents/backend/prolicht/MM/PROGRESS.md          module:MM      workflow
import_md  agents/backend/prolicht/MM/MM_Functional_Document.md module:MM functional_doc
import_md  agents/backend/prolicht/MM/MM_Use_Cases.md      module:MM      use_cases
import_json agents/backend/prolicht/MM/MM_Jira_Bulk.json   module:MM      story        'stories[]'

# ─── stats assertions ───
# Use node for JSON parsing (jq not guaranteed to be available).
echo "→ stats after first pass"
STATS_FILE="$WORK/stats.json"
"$MJ" stats > "$STATS_FILE"

assert_stats() {
  node --input-type=module -e "
    import { readFileSync } from 'fs';
    const s = JSON.parse(readFileSync('$STATS_FILE', 'utf-8'));
    const stories = s.module_context.by_kind.story ?? 0;
    const projectCtxTotal = s.project_context.total ?? 0;
    const mmCount = s.module_context.by_module.MM ?? 0;
    console.log(JSON.stringify({
      project: s.project.name,
      modules: s.modules.total,
      project_context: projectCtxTotal,
      module_context: s.module_context.total,
      by_module: s.module_context.by_module,
      stories,
    }, null, 2));
    if (stories !== 152) {
      console.error('✗ Expected 152 stories from MM_Jira_Bulk.json, got ' + stories);
      process.exit(1);
    }
    if (projectCtxTotal < 4) {
      console.error('✗ Expected ≥4 project_context entries, got ' + projectCtxTotal);
      process.exit(1);
    }
    if (mmCount < 5) {
      console.error('✗ Expected ≥5 module_context entries on MM, got ' + mmCount);
      process.exit(1);
    }
  "
}
assert_stats

# ─── re-import idempotency ───
echo "→ re-importing files (expect status=unchanged)"
RE_OUT="$("$MJ" import agents/backend/prolicht/WORKFLOW.md --target=project --kind=workflow)"
if ! echo "$RE_OUT" | grep -q '"unchanged"'; then
  echo "✗ Re-import did not return unchanged. Output:"
  echo "$RE_OUT"
  exit 1
fi

# Re-import JSON should yield 0 inserted, 0 updated, 152 unchanged.
RE_JSON_FILE="$WORK/reimport.json"
"$MJ" import agents/backend/prolicht/MM/MM_Jira_Bulk.json --target=module:MM --kind=story --mapping='stories[]' > "$RE_JSON_FILE"

node --input-type=module -e "
  import { readFileSync } from 'fs';
  const r = JSON.parse(readFileSync('$RE_JSON_FILE', 'utf-8'));
  console.log('  re-import JSON: inserted=' + r.inserted + ' updated=' + r.updated + ' unchanged=' + r.unchanged);
  if (r.inserted !== 0 || r.updated !== 0 || r.unchanged !== 152) {
    console.error('✗ Expected re-import: 0/0/152, got ' + r.inserted + '/' + r.updated + '/' + r.unchanged);
    process.exit(1);
  }
"

echo "✓ bootstrap-prolicht E2E PASSED"
