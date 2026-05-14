#!/bin/bash
#
# Dogfood script: set up MyJarbis v0.2 on the prolicht project.
#
# Idempotent — re-running yields all-unchanged for content that
# hasn't moved. Running this in another machine after cloning
# prolicht reproduces the same module/context layout.
#
# Inputs:
#   $1                : path to prolicht checkout (default
#                       /home/braianaxeltroncosodeveloper/dev/prolicht)
#   $MYJARBIS_INSTALL_DIR : optional override of the MyJarbis install
#                           location (defaults to $HOME/.myjarbis-global,
#                           used by `myjarbis` itself).
#
# What it does:
#   1. myjarbis init in the prolicht repo (creates memory.db + 6
#      baseline skills + .claude-plugin/).
#   2. Creates 3 modules: MM (Media Manager), PageBuilder, Translations.
#   3. Imports the project-level agents/*.md (WORKFLOW, PLAN, ERRORS,
#      REPORT-JIRA, DEFINICION_FUNCIONAL_APP, CURRENT) into project_context.
#   4. Imports MM/* docs into module:MM as the appropriate kinds.
#   5. Imports MM_Jira_Bulk.json (152 stories) as kind=story.
#   6. Adds a project-level skill 'mm-pixel-perfect' built from
#      MM/WORKFLOW.md section 6b.
#
# Safety:
#   - Won't overwrite any user-authored skill (uses the myjarbis- prefix).
#   - .gitignore edits append a tagged block; running twice is a no-op.
#   - memory.db is gitignored by default; the user owns it.

set -euo pipefail

PROLICHT="${1:-/home/braianaxeltroncosodeveloper/dev/prolicht}"
if [ ! -d "$PROLICHT" ]; then
  echo "✗ prolicht not found at $PROLICHT"
  exit 1
fi

MJ="$(command -v myjarbis || true)"
if [ -z "$MJ" ]; then
  # Fall back to local repo binary if myjarbis isn't in PATH
  HERE="$(cd "$(dirname "$0")/.." && pwd)"
  MJ="$HERE/bin/myjarbis"
  export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$HERE/global}"
fi

cd "$PROLICHT"

echo "→ [1/5] init"
"$MJ" init <<< 'y' >/dev/null
echo "  ✓ memory.db + plugin + 6 baseline skills"

echo "→ [2/5] modules"
for m in MM PageBuilder Translations; do
  "$MJ" module add "$m" --description="$m vertical" >/dev/null 2>&1 || true
done
"$MJ" module list 2>&1 | grep -c '"name"' | xargs -I{} echo "  ✓ {} modules registered"

echo "→ [3/5] project-level imports"
import_md_safe() {
  local path="$1" kind="$2"
  if [ -f "$path" ]; then
    "$MJ" import "$path" --target=project --kind="$kind" >/dev/null
    echo "    ✓ $path → project ($kind)"
  fi
}
import_md_safe agents/backend/prolicht/WORKFLOW.md             workflow
import_md_safe agents/backend/prolicht/PLAN.md                 plan
import_md_safe agents/backend/prolicht/REPORT-JIRA.md          jira_rules
import_md_safe agents/backend/prolicht/ERRORS.md               error_log
import_md_safe agents/backend/prolicht/DEFINICION_FUNCIONAL_APP.md functional_spec
import_md_safe agents/backend/prolicht/CURRENT.md              other

echo "→ [4/5] MM module imports"
import_md_mm() {
  local path="$1" kind="$2"
  if [ -f "$path" ]; then
    "$MJ" import "$path" --target=module:MM --kind="$kind" >/dev/null
    echo "    ✓ $path → module:MM ($kind)"
  fi
}
import_md_mm agents/backend/prolicht/MM/WORKFLOW.md             workflow
import_md_mm agents/backend/prolicht/MM/PLAN.md                 plan
import_md_mm agents/backend/prolicht/MM/PROGRESS.md             workflow
import_md_mm agents/backend/prolicht/MM/MM_Functional_Document.md functional_doc
import_md_mm agents/backend/prolicht/MM/MM_Use_Cases.md         use_cases

if [ -f agents/backend/prolicht/MM/MM_Jira_Bulk.json ]; then
  echo "    importing 152 stories from MM_Jira_Bulk.json..."
  "$MJ" import agents/backend/prolicht/MM/MM_Jira_Bulk.json \
    --target=module:MM --kind=story --mapping='stories[]' >/dev/null
  echo "    ✓ MM_Jira_Bulk.json → module:MM (story × 152)"
fi

echo "→ [5/5] MM-specific skill (mm-pixel-perfect)"
SKILL_TMP="$(mktemp)"
cat > "$SKILL_TMP" << 'SKILL'
---
name: mm-pixel-perfect
description: When implementing UX in MM, copy HTML from the design package and build with Filament Pages + custom Blades (NOT Filament Resources)
---

# MM pixel-perfect Blade workflow

For MM screens (P1..P8 + M1..M17 modals + E1..E8 empty states),
follow the redesign convention from `MM/WORKFLOW.md` section 6b:

1. **Copy** the HTML straight from the design package — do not
   reinterpret. The design is authoritative.
2. **Build** with `Filament\\Pages\\Page` subclasses + Livewire +
   custom Blade templates. **Do not** use Filament Resource
   (the legacy strategy). The Resource path is deprecated for MM.
3. **Validate** against the matching `MM_Use_Cases.md` entry
   (e.g., P4.CU1 for Tags). Each UC documents the expected flow.
4. **Test**: `Livewire::test(<Page>::class)` for state transitions
   + `sail artisan test --filter=MediaManager` end-to-end.
5. **Visual review** by user before commit. Commits do NOT carry
   a Claude footer.

Branch: `feature/mm-e<N>-s<M.N>-<slug>`.
Commit format: `feat(mm-e<N>): <desc> (MM-S<M.N>)`.
SKILL
"$MJ" skill add mm-pixel-perfect --module=MM \
  --content-from="$SKILL_TMP" \
  --description="MM pixel-perfect Blade workflow against design package" \
  --trigger="working on MM UX (P1..P8, M-modals, E-empty-states)" >/dev/null
rm -f "$SKILL_TMP"
echo "  ✓ mm-pixel-perfect skill added to module:MM"

echo
echo "→ stats"
"$MJ" stats | head -50

echo
echo "✓ prolicht dogfood complete. Open Claude in $PROLICHT to test."
