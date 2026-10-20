#!/bin/bash
#
# E2E test: org packs, taxonomy and workflows.
#
# Covers the three changes that make "how this organization works" data
# instead of prose, and the specific ways an earlier loader got it wrong:
#
#   1. a pack applies: skills, taxonomy, workflows, provider templates
#   2. overrides/ REPLACES a baseline skill, and reaches .claude/skills/ —
#      not just the database. Two real projects had 20 and 18 skills in the
#      DB and only 10 on disk, and the overrides directory was never read,
#      so they ran a generic baseline that contradicted the org's own rule
#   3. re-applying is idempotent: everything reports unchanged, and the
#      on-disk count stays put rather than dropping to zero
#   4. a malformed pack is rejected with a reason, not half-applied
#   5. a pack carrying a credential is rejected before anything is written
#   6. the taxonomy rejects an unknown kind and suggests the nearest, folds
#      known aliases, and parks unmappable labels in misc (never gotchas)
#   7. workflows resolve org → project → user into one list, overriding a
#      step keeps its POSITION, and disabling removes an inherited step
#   8. abstract capabilities resolve through the project's providers
#   9. org sync re-applies to every project of the org in one action
#
# Exits 0 on success, non-zero if any assertion fails.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"
EXAMPLE_PACK="$REPO_ROOT/examples/pack"

if [ ! -f "$B/org/pack.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-pack-test-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
# Hermetic HOME: `myjarbis init` registers the project in $HOME/.claude.json
# and writes $HOME/.claude/projects/<slug>/memory/. Unisolated, that lands in
# the developer's real home and stays there.
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/home"
# Own registry, so `org sync` sees only the projects this run created and not
# leftovers from previous runs.
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

# Assertions produced by a node block are read back through a FILE, not a pipe.
#
# `cmd | while read ... oops` puts the loop in a subshell, so every
# FAILED=$((FAILED+1)) inside it is discarded when the subshell exits. The
# suite printed the ✗ lines and then exited 0 anyway, which means none of the
# assertions made this way could ever turn the suite red. Found by reverting a
# real fix and watching six ✗ lines still report "all assertions passed".
ASSERTS="$WORK/asserts.out"
read_asserts() {
  while IFS='|' read -r st msg; do
    [ "$st" = "PASS" ] && pass "$msg" || oops "$msg"
  done < "$ASSERTS"
}


# ─── a project to apply packs to ───
mkdir -p "$WORK/alpha"
cd "$WORK/alpha"
git init -q .
git remote add origin git@github.com:example-co/alpha.git
"$MJ" init --yes --skip-memory >/dev/null 2>&1

echo "→ [1] applying the example pack"
APPLY="$WORK/apply.json"
"$MJ" org add example-co "$EXAMPLE_PACK" > "$APPLY" 2>&1 || { cat "$APPLY"; exit 1; }

node --input-type=module -e "
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('$APPLY', 'utf-8'));
const out = [];
const t = (cond, msg) => out.push((cond ? 'PASS|' : 'FAIL|') + msg);

t(r.org.slug === 'example-co', 'org registered as example-co');
t(typeof r.org.rev === 'string' && r.org.rev.length > 0, 'pack_rev recorded (' + r.org.rev + ')');

const byName = Object.fromEntries(r.skills.map((s) => [s.name, s]));
t(byName['release-checklist']?.status === 'created', 'skills/release-checklist created');
t(byName['incident-notes']?.status === 'created', 'skills/incident-notes created');
t(byName['commit-hygiene']?.from.startsWith('overrides/'),
  'commit-hygiene came from overrides/, not skills/');
t(byName['commit-hygiene']?.status === 'updated',
  'commit-hygiene REPLACED the baseline (status=updated)');

// Order matters: overrides must be applied after the baselines they replace.
const names = r.skills.map((s) => s.from);
const lastPlain = names.reduce((acc, f, i) => (f.startsWith('skills/') ? i : acc), -1);
const firstOverride = names.findIndex((f) => f.startsWith('overrides/'));
t(firstOverride > lastPlain, 'overrides/ applied AFTER skills/');

t(r.contextKinds.length === 2, 'two taxonomy labels added');
t(r.workflows.length === 1 && r.workflows[0].steps === 5, 'one workflow with 5 steps');
t(r.providers.length === 2, 'two provider templates');
t(r.materialized.count >= 12, r.materialized.count + ' skills materialised to disk');
console.log(out.join('\n'));
" > "$ASSERTS"
read_asserts

echo "→ [2] the override reached .claude/skills/, not just the DB"
if grep -q "Example Co commit format" .claude/skills/myjarbis-commit-hygiene/SKILL.md 2>/dev/null; then
  pass "myjarbis-commit-hygiene/SKILL.md holds the pack's version"
else
  oops "the override did not reach disk — the agent would read the generic baseline"
fi
DISK_COUNT=$(ls -1 .claude/skills/ | wc -l)
if [ "$DISK_COUNT" -ge 12 ]; then
  pass "$DISK_COUNT skill directories on disk"
else
  oops "only $DISK_COUNT skills on disk"
fi

echo "→ [3] re-applying the same pack changes nothing"
"$MJ" org add example-co "$EXAMPLE_PACK" > "$WORK/reapply.json" 2>&1
node --input-type=module -e "
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('$WORK/reapply.json', 'utf-8'));
const allUnchanged = r.skills.every((s) => s.status === 'unchanged');
const out = [];
out.push((allUnchanged ? 'PASS|' : 'FAIL|') + 'every skill reports unchanged');
out.push((r.contextKinds.every((k) => k.status === 'unchanged') ? 'PASS|' : 'FAIL|') +
  'every taxonomy label reports unchanged');
out.push((r.materialized.count >= 12 ? 'PASS|' : 'FAIL|') +
  'on-disk count stays at ' + r.materialized.count + ' (counting only changes would read as 0)');
console.log(out.join('\n'));
" > "$ASSERTS"
read_asserts

echo "→ [4] a malformed pack is rejected with a reason"
BADPACK="$WORK/badpack"
mkdir -p "$BADPACK/workflows"
cat > "$BADPACK/pack.yml" <<'YML'
slug: broken-co
name: Broken Co
YML
cat > "$BADPACK/workflows/bad.yml" <<'YML'
slug: bad
name: Bad workflow
steps:
  - name: impossible
    actor: agent
    gate: maybe
YML
if OUT=$("$MJ" org add broken-co "$BADPACK" 2>&1); then
  oops "a pack with gate=maybe was accepted"
else
  if echo "$OUT" | grep -q "expected none | approve | on-request"; then
    pass "rejected: an invalid gate names the allowed values"
  else
    oops "rejected, but unhelpfully: $(echo "$OUT" | head -1)"
  fi
fi

cat > "$BADPACK/workflows/bad.yml" <<'YML'
slug: bad
name: Bad workflow
steps:
  - name: impossible
    actor: agent
    gate: approve
    condition: phase_of_moon == full
YML
if OUT=$("$MJ" org add broken-co "$BADPACK" 2>&1); then
  oops "a pack with an unknown condition field was accepted"
else
  if echo "$OUT" | grep -q "unknown condition field"; then
    pass "rejected: an undecidable condition is a pack error, not a runtime surprise"
  else
    oops "rejected, but unhelpfully: $(echo "$OUT" | head -1)"
  fi
fi

echo "→ [5] a pack carrying a credential is rejected before anything is written"
LEAKPACK="$WORK/leakpack"
mkdir -p "$LEAKPACK"
cat > "$LEAKPACK/pack.yml" <<'YML'
slug: leaky-co
name: Leaky Co
YML
cat > "$LEAKPACK/providers.yml" <<'YML'
providers:
  - role: tracker
    kind: generic-tracker
    config:
      base_url: https://tracker.example.com
      token: ghp_abcdefghij0123456789
YML
if OUT=$("$MJ" org add leaky-co "$LEAKPACK" 2>&1); then
  oops "a pack with a token in providers.config was accepted"
else
  if echo "$OUT" | grep -q "SECRET_IN_CONFIG"; then
    pass "rejected: SECRET_IN_CONFIG before any write"
  else
    oops "rejected for the wrong reason: $(echo "$OUT" | head -1)"
  fi
fi
# And nothing was registered.
if "$MJ" org list 2>/dev/null | grep -q "leaky-co"; then
  oops "leaky-co was registered despite the rejection"
else
  pass "nothing was written for the rejected pack"
fi

echo "→ [6] taxonomy: unknown rejected, aliases folded, misc as the fallback"
echo "# a doc" > "$WORK/alpha/doc.md"
if OUT=$("$MJ" import doc.md --target=project --kind=gotchass 2>&1); then
  oops "an unknown context kind was accepted"
else
  echo "$OUT" | grep -q 'Did you mean "gotchas"' \
    && pass 'typo rejected with "Did you mean \"gotchas\"?"' \
    || oops "rejected without a suggestion"
fi
KIND=$("$MJ" import doc.md --target=project --kind=bitacora 2>/dev/null | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).kind))")
[ "$KIND" = "logbook" ] \
  && pass "alias bitacora folded to logbook" \
  || oops "alias not folded (got '$KIND')"

# The pack's own extra kind must be accepted.
if "$MJ" import doc.md --target=project --kind=incident >/dev/null 2>&1; then
  pass "the pack's own kind 'incident' is accepted"
else
  oops "the pack's kind was not accepted"
fi

node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { migrateKinds } from '$B/tools/kinds.js';
const ctx = ServerContext.initialize();
const p = ctx.requireProject();
// A label no catalogue entry resembles.
ctx.db.db.prepare(\"INSERT INTO project_context (project_id, kind, title, content, content_hash) VALUES (?, 'qqzzxx', 'odd', 'body', 'h')\").run(p.id);
const r = migrateKinds(ctx, { dry_run: true });
const row = r.projectContext.find((x) => x.from === 'qqzzxx');
const out = [];
out.push((row?.to === 'misc' ? 'PASS|' : 'FAIL|') +
  'an unmappable label migrates to misc, not gotchas (got ' + row?.to + ')');
out.push((r.dryRun === true ? 'PASS|' : 'FAIL|') + 'migrate_kinds --dry-run reports without writing');
console.log(out.join('\n'));
ctx.close();
" > "$ASSERTS"
read_asserts

echo "→ [7,8] workflow inheritance, position, disable, and provider resolution"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { setWorkflowStep } from '$B/tools/workflows.js';
import { resolveWorkflow, gatherFacts } from '$B/workflows/resolve.js';
const ctx = ServerContext.initialize();
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);

const org = resolveWorkflow(ctx, 'ticket-close');
const orgApprovalPos = org.steps.find((s) => s.name === 'get-approval').position;
t(org.steps.length === 5 && org.steps.every((s) => s.from === 'org'),
  'the org layer alone resolves to 5 steps');

setWorkflowStep(ctx, { slug:'ticket-close', name:'get-approval', scope:'project',
  gate:'on-request', actor:'human' });
setWorkflowStep(ctx, { slug:'ticket-close', name:'hand-back-to-reporter', scope:'project',
  disabled:true });
setWorkflowStep(ctx, { slug:'ticket-close', name:'get-approval', scope:'user',
  gate:'approve', actor:'human' });
setWorkflowStep(ctx, { slug:'ticket-close', name:'brand-new', scope:'project', actor:'agent' });

const r = resolveWorkflow(ctx, 'ticket-close', { facts: gatherFacts(ctx, { branch:'release/2.1' }) });
const approval = r.steps.find((s) => s.name === 'get-approval');

t(approval.from === 'user' && approval.gate === 'approve',
  'user layer wins over project and org');
t(approval.position === orgApprovalPos,
  'an override KEEPS the position it inherited (' + approval.position +
  ') — renumbering once moved an approval gate ahead of the tests');
t(!r.steps.some((s) => s.name === 'hand-back-to-reporter'),
  'a disabled step is gone from the resolved list');
t(r.suppressed.some((s) => s.name === 'hand-back-to-reporter' && s.disabledBy === 'project'),
  'and the removal is reported, not silent');
const last = r.steps[r.steps.length - 1];
t(last.name === 'brand-new', 'a genuinely new step is appended at the end');

const names = r.steps.map((s) => s.name);
const sorted = [...r.steps].sort((a, b) => a.position - b.position).map((s) => s.name);
t(JSON.stringify(names) === JSON.stringify(sorted), 'the resolved list is in position order');

const comment = r.steps.find((s) => s.name === 'comment-on-ticket');
t(comment.capability === 'tracker.comment' && comment.provider?.kind === 'generic-tracker',
  'abstract capability tracker.comment resolved to the project provider');
const mr = r.steps.find((s) => s.name === 'open-merge-request');
t(mr.provider?.kind === 'generic-forge', 'forge.merge_request resolved to generic-forge');
const tests = r.steps.find((s) => s.name === 'run-tests');
t(tests.capability === 'ci.run' && tests.provider === null,
  'an unconfigured role resolves to provider=null, the signal to ask');

console.log(out.join('\n'));
ctx.close();
" > "$ASSERTS"
read_asserts

echo "→ [9] org sync re-applies to every project of the org"
mkdir -p "$WORK/beta"
cd "$WORK/beta"
git init -q .
git remote add origin git@github.com:example-co/beta.git
"$MJ" init --yes --skip-memory >/dev/null 2>&1
"$MJ" org add example-co "$EXAMPLE_PACK" >/dev/null 2>&1
cd "$WORK/alpha"

"$MJ" org sync example-co "$EXAMPLE_PACK" > "$WORK/sync.json" 2>&1
node --input-type=module -e "
import { readFileSync } from 'fs';
const r = JSON.parse(readFileSync('$WORK/sync.json', 'utf-8'));
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
t(r.projects.length === 2, 'sync visited exactly the 2 projects of this run');
t(r.summary.failed === 0, 'no project failed');
t(r.projects.every((p) => !p.ok || (p.materialized ?? 0) >= 12),
  'every synced project ended with its skills on disk');
console.log(out.join('\n'));
" > "$ASSERTS"
read_asserts

"$MJ" org diff example-co "$EXAMPLE_PACK" > "$WORK/diff.json" 2>&1
if node -e "
const r = require('fs').readFileSync('$WORK/diff.json','utf-8');
process.exit(JSON.parse(r).dryRun === true ? 0 : 1)"; then
  pass "org diff runs as a dry run"
else
  oops "org diff did not report dryRun"
fi

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
echo "✓ v03-org-pack E2E PASSED"
