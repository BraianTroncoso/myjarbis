#!/bin/bash
#
# E2E test: bootstrapping a project from a tree of markdown + JSON docs.
#
# Verifies that `myjarbis import` correctly populates project_context,
# module_context, and module_context-as-stories. Asserts:
#   1. All imports succeed on the first run.
#   2. Stats show the expected counts (project_context, module_context,
#      and one story per entry in the JSON bulk file).
#   3. Re-importing the same files yields status=unchanged (hash idempotency).
#
# The fixture is generated here rather than read from a checkout on disk.
# It used to point at a private project on one specific machine, which made
# the test unrunnable anywhere else and leaked client names into the repo.
#
# Inputs:
#   $MYJARBIS_INSTALL_DIR  MyJarbis install to test (default: ../global).
#
# Exits 0 on success, non-zero on any assertion failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$MYJARBIS_INSTALL_DIR/mcp-server/build/cli.js"
SEED_HELPER="$MYJARBIS_INSTALL_DIR/mcp-server/build/db/migrate.js"

STORY_COUNT=40

# ─── preflight ───
if [ ! -f "$CLI" ]; then
  echo "✗ MyJarbis MCP build not found at $CLI — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

# ─── setup tmp project ───
WORK="$(mktemp -d -t myjarbis-import-test-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"

# ─── hermetic HOME ────────────────────────────────────────────────
#
# Without this the suite writes into the developer's real home: `myjarbis
# init` registers the project in $HOME/.claude.json and drops a memory
# pointer under $HOME/.claude/projects/<slug>/, and an un-pinned
# MYJARBIS_HOME resolves to $HOME/.myjarbis — the real shared brain. A
# year of runs left 469 dead registrations in the file Claude Code itself
# reads. Everything now lands under $WORK, which the EXIT trap removes.
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

DOCS="$WORK/agents/example-project"
mkdir -p "$DOCS/Catalog"

# ─── generate the fixture ───
# Six project-level docs and five module-level ones, sized like real docs so
# the import path is exercised with multi-KB content rather than one-liners.
write_doc() {
  local path="$1" title="$2" body="$3"
  {
    echo "# $title"
    echo
    echo "$body"
    echo
    for i in $(seq 1 30); do
      echo "## Section $i"
      echo
      echo "Paragraph $i of $title. It describes a rule the agent has to honour"
      echo "when working on this area, with enough prose to be worth indexing."
      echo
    done
  } > "$path"
}

write_doc "$DOCS/WORKFLOW.md"    "Workflow"              "How work flows through this project."
write_doc "$DOCS/PLAN.md"        "Plan"                  "The current roadmap."
write_doc "$DOCS/TRACKING.md"    "Tracking rules"        "How issues are tracked and reported."
write_doc "$DOCS/ERRORS.md"      "Error log"             "Known failures and their resolutions."
write_doc "$DOCS/SPEC.md"        "Functional spec"       "What the product is supposed to do."
write_doc "$DOCS/CURRENT.md"     "Current state"         "Where the work stands today."

write_doc "$DOCS/Catalog/WORKFLOW.md" "Catalog workflow" "Workflow specific to the Catalog module."
write_doc "$DOCS/Catalog/PLAN.md"     "Catalog plan"     "Roadmap for the Catalog module."
write_doc "$DOCS/Catalog/PROGRESS.md" "Catalog progress" "Story-by-story status for Catalog."
write_doc "$DOCS/Catalog/FUNCTIONAL.md" "Catalog functional document" "Catalog behaviour in detail."
write_doc "$DOCS/Catalog/USE_CASES.md"  "Catalog use cases"           "Catalog use cases, one per screen."

# A bulk story export, shaped like what a tracker emits.
node --input-type=module -e "
  import { writeFileSync } from 'fs';
  const stories = [];
  for (let i = 1; i <= $STORY_COUNT; i++) {
    stories.push({
      id: 'CAT-' + i,
      title: 'Story ' + i + ': catalog behaviour',
      description: 'As a user I want behaviour ' + i + ' so that the catalog is usable.\n\nAcceptance criteria:\n- Given state A\n- When action ' + i + '\n- Then result ' + i,
      status: i % 3 === 0 ? 'done' : 'todo',
    });
  }
  writeFileSync('$DOCS/Catalog/stories.json', JSON.stringify({ stories }, null, 2));
"
echo "  ✓ fixture generated: 11 docs + $STORY_COUNT stories"

# ─── seed project + module ───
node --input-type=module -e "
import { seedNewProject } from '$SEED_HELPER';
import { MyJarbisDB } from '$MYJARBIS_INSTALL_DIR/mcp-server/build/db/index.js';
const r = seedNewProject('$WORK', { name: 'import-test', framework: 'generic' });
const db = MyJarbisDB.open('$WORK');
// Writes need a bound tenant scope; there is no implicit 'current project'.
db.bindScope({ kind: 'project', id: r.projectId });
db.modules.create(r.projectId, 'Catalog', 'Catalog vertical');
db.close();
console.log('seeded:', JSON.stringify(r));
"

# ─── imports ───
cd "$WORK"
import_md() {
  local path="$1" target="$2" kind="$3"
  echo "  import_md $path → $target [$kind]"
  "$MJ" import "$path" --target="$target" --kind="$kind" >/dev/null
}
import_json() {
  local path="$1" target="$2" kind="$3" mapping="$4"
  echo "  import_json $path → $target [$kind] mapping=$mapping"
  "$MJ" import "$path" --target="$target" --kind="$kind" --mapping="$mapping" >/dev/null
}

echo "→ first-pass imports"
import_md  agents/example-project/WORKFLOW.md            project    workflow
import_md  agents/example-project/PLAN.md                project    plan
import_md  agents/example-project/TRACKING.md            project    tracker_rules
import_md  agents/example-project/ERRORS.md              project    error_log
import_md  agents/example-project/SPEC.md                project    functional_spec
import_md  agents/example-project/CURRENT.md             project    other
import_md  agents/example-project/Catalog/WORKFLOW.md    module:Catalog  workflow
import_md  agents/example-project/Catalog/PLAN.md        module:Catalog  plan
import_md  agents/example-project/Catalog/PROGRESS.md    module:Catalog  workflow
import_md  agents/example-project/Catalog/FUNCTIONAL.md  module:Catalog  functional_doc
import_md  agents/example-project/Catalog/USE_CASES.md   module:Catalog  use_cases
import_json agents/example-project/Catalog/stories.json  module:Catalog  story  'stories[]'

# ─── stats assertions ───
# Use node for JSON parsing (jq is not guaranteed to be available).
echo "→ stats after first pass"
STATS_FILE="$WORK/stats.json"
"$MJ" stats > "$STATS_FILE"

node --input-type=module -e "
  import { readFileSync } from 'fs';
  const s = JSON.parse(readFileSync('$STATS_FILE', 'utf-8'));
  const stories = s.module_context.by_kind.story ?? 0;
  const projectCtxTotal = s.project_context.total ?? 0;
  const modCount = s.module_context.by_module.Catalog ?? 0;
  console.log(JSON.stringify({
    project: s.project.name,
    modules: s.modules.total,
    project_context: projectCtxTotal,
    module_context: s.module_context.total,
    by_module: s.module_context.by_module,
    stories,
  }, null, 2));
  if (stories !== $STORY_COUNT) {
    console.error('✗ Expected $STORY_COUNT stories from stories.json, got ' + stories);
    process.exit(1);
  }
  if (projectCtxTotal < 6) {
    console.error('✗ Expected ≥6 project_context entries, got ' + projectCtxTotal);
    process.exit(1);
  }
  if (modCount < 5) {
    console.error('✗ Expected ≥5 module_context entries on Catalog, got ' + modCount);
    process.exit(1);
  }
"

# ─── re-import idempotency ───
echo "→ re-importing files (expect status=unchanged)"
RE_OUT="$("$MJ" import agents/example-project/WORKFLOW.md --target=project --kind=workflow)"
if ! echo "$RE_OUT" | grep -q '"unchanged"'; then
  echo "✗ Re-import did not return unchanged. Output:"
  echo "$RE_OUT"
  exit 1
fi

# Re-importing the bulk file should yield 0 inserted, 0 updated, all unchanged.
RE_JSON_FILE="$WORK/reimport.json"
"$MJ" import agents/example-project/Catalog/stories.json --target=module:Catalog --kind=story --mapping='stories[]' > "$RE_JSON_FILE"

node --input-type=module -e "
  import { readFileSync } from 'fs';
  const r = JSON.parse(readFileSync('$RE_JSON_FILE', 'utf-8'));
  console.log('  re-import JSON: inserted=' + r.inserted + ' updated=' + r.updated + ' unchanged=' + r.unchanged);
  if (r.inserted !== 0 || r.updated !== 0 || r.unchanged !== $STORY_COUNT) {
    console.error('✗ Expected re-import: 0/0/$STORY_COUNT, got ' + r.inserted + '/' + r.updated + '/' + r.unchanged);
    process.exit(1);
  }
"

echo "✓ bootstrap-import E2E PASSED"
