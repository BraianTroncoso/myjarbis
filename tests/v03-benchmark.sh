#!/bin/bash
#
# Benchmark: reading the brain vs. searching it.
#
# The question this answers is "what does the structure actually buy?", and
# it is measured rather than asserted, because the honest answer depends on
# how big the brain is.
#
# Four things are timed, over a synthetic brain of realistic size:
#
#   A. READ EVERYTHING — load every context row and note, which is what an
#      agent does when it has no index: the cost of rebuilding your own
#      picture of the project from the raw material.
#   B. FTS SEARCH — the scoped full-text query that replaces it.
#   C. STRUCTURED LOOKUPS — the v0.3 additions that replace a read with a
#      row hit: project_state (vs. scanning notes for the newest "RESUME
#      HERE"), find_by_ref (vs. re-reading a paragraph of ids), topic_key
#      (vs. reading N competing versions of one note), get_workflow (vs.
#      reconciling three prose documents).
#   D. SCOPE OVERHEAD — what the tenant check costs, since it now runs on
#      every read and a safety mechanism nobody can afford is not one.
#
# Sizes are reported in both rows and characters, because the number that
# matters for an agent is characters: that is what becomes tokens.
#
# Prints a table. Always exits 0 — this measures, it does not gate.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"

if [ ! -f "$B/db/index.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-bench-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
# Hermetic HOME, as insurance: nothing here should resolve a path through
# $HOME, and if something starts to, it must not be the real one.
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/home"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

# Scale: roughly one busy project (the largest real brain measured held ~240
# notes), times three tenants, so the shared-DB case is exercised too.
NOTES_PER_PROJECT="${BENCH_NOTES:-240}"
PROJECTS="${BENCH_PROJECTS:-3}"
REPS="${BENCH_REPS:-200}"

node --input-type=module -e "
import * as fs from 'fs';
import { MyJarbisDB } from '$B/db/index.js';

const W = '$WORK';
const NOTES = $NOTES_PER_PROJECT;
const NPROJ = $PROJECTS;
const REPS  = $REPS;

const DB = W + '/shared.db';
fs.mkdirSync(W + '/home', { recursive: true });

// ─── fixture ───
// Prose sized like real notes: the WHY/WHAT/HOW shape the observation
// protocol asks for, which is several hundred characters, not a sentence.
function body(i, project, module) {
  return [
    'WHY: ' + project + ' needed a decision about ' + module + ' because the previous',
    'approach broke when the ' + module + ' table grew past a million rows and the',
    'nightly job started timing out at step ' + i + '.',
    '',
    'WHAT: we moved the aggregation into a materialised view refreshed on write,',
    'keeping the read path on a single index scan. Marker zarquon' + i + ' for search.',
    '',
    'HOW: see the migration and the two queries it replaces; the old ones are kept',
    'in the error log for reference. Rolling back means dropping the view and',
    'restoring the previous query plan, which is recorded in the commit body.',
  ].join('\n');
}

const projects = [];
{
  const db = MyJarbisDB.openAtPath(DB);
  db.bindScope({ kind: 'all', reason: 'building the benchmark fixture' });
  for (let p = 1; p <= NPROJ; p++) {
    const name = 'client-' + p;
    const row = db.projects.create({ name, path: W + '/' + name, isolation: 'shared' });
    projects.push(row);
  }
  db.bindScope({ kind: 'project', id: projects[0].id });
  db.close();
}

for (const proj of projects) {
  const db = MyJarbisDB.openAtPath(DB);
  db.bindScope({ kind: 'project', id: proj.id });
  const mods = ['api', 'web', 'infra'].map((n) => db.modules.create(proj.id, n));
  for (const m of mods) {
    const s = db.sessions.start(m.id);
    db.sessions.end(s.id, 'Worked on ' + m.name, 'Next: continue ' + m.name);
    const per = Math.ceil(NOTES / mods.length);
    for (let i = 0; i < per; i++) {
      db.observations.add({
        sessionId: s.id,
        kind: ['decision','gotcha','progress','error','discovery'][i % 5],
        title: proj.name + ' ' + m.name + ': decision ' + i + ' about aggregation',
        content: body(i, proj.name, m.name),
        tags: m.name + ',aggregation',
      });
    }
    for (let i = 0; i < 10; i++) {
      db.moduleContext.upsert({ moduleId: m.id, kind: 'story', title: m.name + '-S' + i,
        content: body(i, proj.name, m.name), sourcePath: m.name + '/stories.json#' + i });
    }
  }
  for (let i = 0; i < 12; i++) {
    db.projectContext.upsert({ projectId: proj.id, kind: 'gotchas',
      title: proj.name + ' gotcha ' + i, content: body(i, proj.name, 'platform'),
      sourcePath: 'GOTCHAS.md#' + i });
  }
  // The v0.3 structures the benchmark compares against.
  const STATE_TEXT = 'Current: ' + proj.name + ' is on release/2.1. Next action: run ' +
    'the suite, then open the merge request. Blocked on nothing.';
  db.projectState.set({ projectId: proj.id, content: STATE_TEXT, updatedBy: 'bench' });

  // The v0.2 habit this replaces: three notes that are all the same note,
  // each announcing that it supersedes the last. The scan below has to find
  // the newest of them, which is the work project_state removes. Without
  // these the scan would find nothing and the comparison would be measuring
  // a search for an answer that is not there.
  const sState = db.sessions.start(mods[0].id);
  for (const t of ['RESUME HERE: ' + proj.name + ' status',
                   'CORRECTS the above — RESUME HERE, current status',
                   'DEFINITIVE — RESUME HERE, supersedes the previous two']) {
    db.observations.add({ sessionId: sState.id, kind: 'progress', title: t,
      content: STATE_TEXT + ' (next action recorded here)' });
  }
  db.sessions.end(sState.id, 'status notes', 'see the notes');
  const last = db.observations.listByProject(proj.id, 1)[0];
  db.observations.update(last.id, { title: last.title });
  db.db.prepare('UPDATE observations SET topic_key = ? WHERE id = ?')
    .run('aggregation/materialised-view', last.id);
  db.refs.add({ observationId: last.id, kind: 'worklog', provider: 'generic-tracker',
    externalId: 'WI-167-59119' });
  const wf = db.workflows.upsert({ slug: 'ticket-close', name: 'Closing a ticket',
    scope: 'project', scopeId: proj.id });
  ['run-tests','open-mr','get-approval','comment','hand-back'].forEach((n, i) =>
    db.workflowSteps.upsert({ workflowId: wf.id, position: (i+1)*10, name: n,
      actor: i % 2 ? 'human' : 'agent', gate: n === 'get-approval' ? 'approve' : 'none' }));
  db.close();
}

// ─── measurement helpers ───
const time = (label, fn) => {
  fn(); // warm the statement cache and the page cache
  const t0 = process.hrtime.bigint();
  let out;
  for (let i = 0; i < REPS; i++) out = fn();
  const t1 = process.hrtime.bigint();
  return { label, ms: Number(t1 - t0) / 1e6 / REPS, out };
};
const chars = (v) => JSON.stringify(v ?? '').length;
const fmt = (n) => (n < 1 ? n.toFixed(3) : n < 100 ? n.toFixed(2) : Math.round(n).toString());

const scoped = MyJarbisDB.openAtPath(DB);
scoped.bindScope({ kind: 'project', id: projects[0].id });
const pid = projects[0].id;

const totalRows = scoped.db.prepare('SELECT COUNT(*) n FROM observations').get().n;
const myRows = scoped.db.prepare('SELECT COUNT(*) n FROM observations WHERE project_id = ?').get(pid).n;

// ─── A. read everything this project has ───
const readAll = time('read the whole brain', () => {
  const ctx = scoped.projectContext.listByProject(pid);
  const mods = scoped.modules.listByProject(pid);
  const mc = mods.flatMap((m) => scoped.moduleContext.listByModule(m.id));
  const obs = scoped.observations.listByProject(pid, 100000);
  return { ctx, mc, obs };
});
const readChars =
  chars(readAll.out.ctx) + chars(readAll.out.mc) + chars(readAll.out.obs);
const readRows =
  readAll.out.ctx.length + readAll.out.mc.length + readAll.out.obs.length;

// ─── B. find it instead ───
const search = time('FTS search (notes)', () =>
  scoped.search('zarquon7 aggregation', { scope: 'observations', limit: 10 }));
const searchWide = time('FTS search (context + modules)', () =>
  scoped.search('aggregation materialised', { scope: 'project', limit: 10 }));

// ─── C. structured lookups that replace a read ───
const state = time('get_project_state', () => scoped.projectState.get(pid));
const ref = time('find_by_ref', () =>
  scoped.refs.find({ provider: 'generic-tracker', externalId: 'WI-167-59119' }));
const topic = time('find by topic_key', () =>
  scoped.observations.findByTopic(pid, 'aggregation/materialised-view'));
const wfSteps = time('resolve workflow steps', () => {
  const w = scoped.workflows.find('ticket-close', 'project', pid);
  return scoped.workflowSteps.listByWorkflow(w.id);
});

// The pre-v0.3 way to answer 'where did I leave off': read the notes and
// pick the newest one that looks like a status update.
const scanForState = time('scan notes for the newest status', () => {
  const rows = scoped.observations.listByProject(pid, 100000);
  const candidates = rows.filter((r) => /resume here|current status|next action/i.test(r.title + r.content));
  // And this is the part that is not just slow: THREE notes match, each
  // claiming to supersede the others, and picking between them is a
  // judgement the agent has to make on every single session.
  return { picked: candidates[0], competing: candidates.length };
});

// ─── D. what the scope check costs ───
// Measured as the SAME SQL with and without the clause the scope adds, using
// pre-compiled statements for both. An earlier version of this benchmark
// compared raw SQL against the accessor and reported 32% — but the accessor
// also sorts, so that number was the cost of ORDER BY, not of the check.
// Comparing different queries is the easiest way to produce a confident
// wrong number.
const stmtNoFilter = scoped.db.prepare('SELECT * FROM observations LIMIT 50');
const stmtFiltered = scoped.db.prepare('SELECT * FROM observations WHERE project_id = ? LIMIT 50');
const unscopedLike = time('identical query, no tenant filter', () => stmtNoFilter.all());
const viaAccessor  = time('identical query + tenant filter', () => stmtFiltered.all(pid));
// And the in-process guard on its own.
const guard = time('assertInScope (the guard alone)', () => scoped.scopedProjectId);

scoped.close();

// ─── report ───
const line = (a, b, c, d) =>
  console.log('  ' + String(a).padEnd(42) + String(b).padStart(10) + String(c).padStart(12) + '  ' + d);

console.log();
console.log('  MyJarbis v0.3 — read vs. find');
console.log('  ' + '─'.repeat(86));
console.log('  fixture: ' + NPROJ + ' projects sharing one brain, ' + totalRows +
            ' notes total (' + myRows + ' in the measured project)');
console.log('  each timing is the mean of ' + REPS + ' runs, after a warm-up run');
console.log();
line('operation', 'ms', 'chars', 'what it replaces');
console.log('  ' + '─'.repeat(86));

line('A  read the whole brain', fmt(readAll.ms), readChars,
     readRows + ' rows — the no-index baseline');
console.log();
line('B  FTS search (notes)', fmt(search.ms), chars(search.out),
     'reading ' + readRows + ' rows to find one');
line('B  FTS search (context + modules)', fmt(searchWide.ms), chars(searchWide.out), '');
console.log();
line('C  get_project_state', fmt(state.ms), chars(state.out),
     'the scan below');
line('C  scan notes for newest status', fmt(scanForState.ms), chars(scanForState.out.picked),
     scanForState.out.competing + ' notes match — pick one');
line('C  find_by_ref', fmt(ref.ms), chars(ref.out),
     're-reading a paragraph of ids');
line('C  find by topic_key', fmt(topic.ms), chars(topic.out),
     'reading N competing versions');
line('C  resolve workflow steps', fmt(wfSteps.ms), chars(wfSteps.out),
     'reconciling 3 prose documents');
console.log();
line('D  identical query, no tenant filter', fmt(unscopedLike.ms), '-', 'baseline');
line('D  identical query + tenant filter', fmt(viaAccessor.ms), '-',
     'one extra AND in the SQL');
line('D  the in-process guard alone', fmt(guard.ms), '-',
     'one integer comparison');

console.log('  ' + '─'.repeat(86));
const speedup = readAll.ms / search.ms;
const shrink  = readChars / Math.max(1, chars(search.out));
const overhead = ((viaAccessor.ms - unscopedLike.ms) / Math.max(unscopedLike.ms, 0.0001)) * 100;
const stateGain = scanForState.ms / Math.max(state.ms, 0.0001);

console.log();
console.log('  Finding vs. reading:  ' + fmt(speedup) + 'x faster, ' +
            fmt(shrink) + 'x less text');
console.log('    ' + readChars.toLocaleString() + ' chars of brain -> ' +
            chars(search.out).toLocaleString() + ' chars of answer.');
console.log('    Characters are the number that matters: that is what becomes tokens.');
console.log();
console.log('  Living state vs. scanning for it: ' + fmt(stateGain) + 'x faster');
console.log('    But speed is the lesser half. The scan returns ' +
            scanForState.out.competing + ' notes that all claim');
console.log('    to be the current status, and choosing between them is a judgement');
console.log('    the agent made differently every session. One row has no ambiguity.');
console.log();
console.log('  Cost of the tenant filter: ' + (overhead < 0 ? 'none measurable' : fmt(overhead) + '%') +
            ' on a 50-row read');
console.log('    It runs on every read, so it had to be close to free. The filter is');
console.log('    one indexed AND; the in-process guard is one integer comparison');
console.log('    (' + fmt(guard.ms) + ' ms). Both are noise next to the query itself.');
console.log();
console.log('  Read honestly: at this size FTS wins on text volume far more than');
console.log('  on wall-clock — both are sub-millisecond, and SQLite was never the');
console.log('  bottleneck. The win is that the agent reads an answer instead of a');
console.log('  corpus. That is also why the structured lookups in C matter more');
console.log('  than the search in B: they remove a judgement call, not just bytes.');
console.log();
"
