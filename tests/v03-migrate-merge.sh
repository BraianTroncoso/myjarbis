#!/bin/bash
#
# E2E test: migrating a v3 brain and merging brains into a shared one.
#
# These are the two operations that can destroy a brain, so they are tested
# against synthetic-but-realistic data rather than trusted.
#
# It builds three fictional projects with modules, sessions, notes, refs,
# workflows and state, then:
#   1. reconstructs a genuine PRE-v4 database and migrates it, checking that
#      no row is lost and that the project_id backfill lands
#   2. proves --dry-run does not touch the original file
#   3. proves migration is idempotent
#   4. merges all three into one shared brain, checking that
#        · row counts add up exactly, per table
#        · foreign keys were rewritten (no note points at a foreign session)
#        · the self-referential supersedes link survived the id remap
#        · the FTS index was rebuilt and still resolves to the right rows
#        · integrity_check and foreign_key_check are clean
#   5. proves a second merge of the same project is refused, not duplicated
#   6. proves the WAL is included in the backup
#
# Exits 0 on success, non-zero on the first failed assertion.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"

if [ ! -f "$B/db/merge.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-merge-test-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
# Hermetic HOME: the default registry lives next to the install and
# $HOME/.claude.json / $HOME/.claude/projects/ are written by `init`, so
# neither may be the developer's real ones. MYJARBIS_HOME is kept as it was.
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"
export MYJARBIS_HOME="$WORK/home"

node --input-type=module -e "
import * as fs from 'fs';
import Database from '$MYJARBIS_INSTALL_DIR/mcp-server/node_modules/better-sqlite3/lib/index.js';
import { MyJarbisDB } from '$B/db/index.js';
import { SCHEMA_VERSION, SCHEMA_SQL } from '$B/db/schema.js';
import { upgradeBrain, backupBrain } from '$B/db/upgrade.js';
import { mergeBrain } from '$B/db/merge.js';

let failed = 0;
const ok  = (m) => console.log('    ✓ ' + m);
const bad = (m) => { console.error('    ✗ ' + m); failed++; };
const W   = '$WORK';

// ───────────────────────────────────────────────────────────────────
// Fixture: three fictional projects, each in its own brain.
// ───────────────────────────────────────────────────────────────────
const CLIENTS = [
  { name: 'acme-portal',   modules: ['api', 'web'],      notes: 14 },
  { name: 'globex-store',  modules: ['checkout'],        notes: 9  },
  { name: 'initech-admin', modules: ['core', 'reports'], notes: 21 },
];

function seedClient(c) {
  const dir = W + '/' + c.name;
  fs.mkdirSync(dir + '/.myjarbis', { recursive: true });
  const dbPath = dir + '/.myjarbis/memory.db';
  const db = MyJarbisDB.openAtPath(dbPath);

  db.bindScope({ kind: 'all', reason: 'seeding a test fixture' });
  const org = db.orgs.upsert({ slug: 'example-co', name: 'Example Co', packPath: '/nowhere', packRev: 'test' });
  const p = db.projects.create({
    name: c.name, path: dir, framework: 'generic',
    orgId: org.id, gitRemote: 'github.com/example-co/' + c.name, isolation: 'silo',
  });
  db.bindScope({ kind: 'project', id: p.id });

  let firstObs = null, lastObs = null;
  for (const mName of c.modules) {
    const m = db.modules.create(p.id, mName, mName + ' vertical');
    db.moduleContext.upsert({ moduleId: m.id, kind: 'plan', title: mName + ' plan',
      content: 'Plan for ' + mName + ' in ' + c.name, sourcePath: mName + '/PLAN.md' });
    const s = db.sessions.start(m.id);
    db.sessions.end(s.id, 'Worked on ' + mName, 'Next: continue ' + mName);
    const per = Math.ceil(c.notes / c.modules.length);
    for (let i = 0; i < per; i++) {
      const r = db.observations.add({
        sessionId: s.id,
        kind: ['decision','gotcha','progress','error','discovery'][i % 5],
        title: c.name + ' ' + mName + ' finding number ' + i,
        content: 'Detail ' + i + ' recorded while working on ' + mName + ' for ' + c.name +
                 '. Mentions the word zarquon' + i + ' so FTS has something unique to find.',
        tags: mName,
      });
      if (!firstObs) firstObs = r.row.id;
      lastObs = r.row.id;
    }
  }
  db.projectContext.upsert({ projectId: p.id, kind: 'stack', title: c.name + ' stack',
    content: 'The stack of ' + c.name, sourcePath: 'STACK.md' });
  db.projectState.set({ projectId: p.id, content: 'State of ' + c.name, updatedBy: 'fixture' });
  db.providers.upsert({ projectId: p.id, role: 'tracker', kind: 'generic-tracker',
    config: JSON.stringify({ base_url: 'https://tracker.example.com' }) });

  // A ref, and a supersedes chain — the two foreign keys most likely to be
  // mis-remapped, because one is cross-table and one is self-referential.
  db.refs.add({ observationId: lastObs, kind: 'ticket', provider: 'generic-tracker',
    externalId: c.name.toUpperCase() + '-1', url: 'https://tracker.example.com/1' });
  db.db.prepare('UPDATE observations SET supersedes = ? WHERE id = ?').run(firstObs, lastObs);

  const wf = db.workflows.upsert({ slug: 'ticket-close', name: 'Closing a ticket', scope: 'project', scopeId: p.id });
  db.workflowSteps.upsert({ workflowId: wf.id, position: 10, name: 'run-tests', actor: 'agent', gate: 'none' });
  db.workflowSteps.upsert({ workflowId: wf.id, position: 20, name: 'ask', actor: 'human', gate: 'approve' });

  const counts = {};
  for (const t of ['projects','modules','project_context','module_context','skills',
                   'sessions','observations','refs','project_state','providers',
                   'workflows','workflow_steps']) {
    counts[t] = db.db.prepare('SELECT COUNT(*) n FROM ' + t).get().n;
  }
  db.close();
  return { ...c, dir, dbPath, counts, firstObs, lastObs };
}

const seeded = CLIENTS.map(seedClient);
console.log('  fixture: ' + seeded.length + ' projects, ' +
  seeded.reduce((a, s) => a + s.counts.observations, 0) + ' notes total');

// ───────────────────────────────────────────────────────────────────
// 1. migrate a genuine pre-v4 brain
// ───────────────────────────────────────────────────────────────────
console.log('→ [1] migrating a reconstructed pre-v4 brain');
{
  // Build a genuine v3-shaped file with RAW sqlite, never touching
  // MyJarbisDB — going through it would apply the v4 schema first, and then
  // the migration would have nothing to do. The v4 columns have to be truly
  // absent for this to test anything, and their absence is what triggered
  // the real \"no such table / no such column\" failures this reproduces.
  const legacy = W + '/legacy.db';
  const raw = new Database(legacy);
  raw.exec(\`
    PRAGMA journal_mode = WAL;
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      path TEXT NOT NULL UNIQUE, framework TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE project_context (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
      kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT, source_path TEXT,
      content_hash TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE modules (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
      name TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE module_context (id INTEGER PRIMARY KEY AUTOINCREMENT, module_id INTEGER NOT NULL,
      kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, tags TEXT, source_path TEXT,
      content_hash TEXT NOT NULL, progress TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE skills (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER NOT NULL,
      module_id INTEGER, name TEXT NOT NULL, description TEXT, trigger_pattern TEXT,
      content TEXT NOT NULL, content_hash TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, module_id INTEGER NOT NULL,
      started_at TEXT DEFAULT (datetime('now')), ended_at TEXT, summary TEXT, next_session TEXT);
    CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL,
      kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, story_local_id TEXT,
      files TEXT, tags TEXT, created_at TEXT DEFAULT (datetime('now')));
    INSERT INTO meta (key, value) VALUES ('schema_version', '3');
    INSERT INTO projects (name, path) VALUES ('legacy-co', '$WORK/legacy-co');
    INSERT INTO modules (project_id, name) VALUES (1, 'api');
    INSERT INTO sessions (module_id) VALUES (1);
    INSERT INTO project_context (project_id, kind, title, content, content_hash)
      VALUES (1, 'dominio', 'Legacy domain', 'what the business does', 'h1');
  \`);
  const ins = raw.prepare('INSERT INTO observations (session_id, kind, title, content) VALUES (1, ?, ?, ?)');
  for (let i = 0; i < 25; i++) ins.run('decision', 'Legacy note ' + i, 'Body of legacy note ' + i);
  raw.close();

  // Sanity: the columns the migration must add are genuinely missing.
  {
    const check = new Database(legacy, { readonly: true });
    const cols = check.prepare('PRAGMA table_info(projects)').all().map((c) => c.name);
    check.close();
    !cols.includes('git_remote') && !cols.includes('isolation')
      ? ok('fixture is genuinely pre-v4 (no git_remote, no isolation)')
      : bad('fixture already had the v4 columns: ' + cols.join(', '));
  }

  // --- dry run must not touch the original ---
  const sizeBefore = fs.statSync(legacy).size;
  const dry = upgradeBrain(legacy, { dryRun: true });
  const probe = MyJarbisDB.openExisting(legacy);
  const stillV3 = probe.schemaVersion;
  const stillNoColumn = !probe.db.prepare('PRAGMA table_info(projects)').all()
    .some((c) => c.name === 'git_remote');
  probe.close();
  stillV3 === 3 && stillNoColumn
    ? ok('--dry-run left the original at v3 with no new columns')
    : bad('--dry-run modified the original (v' + stillV3 + ')');
  dry.after.observations === 25
    ? ok('--dry-run reported the real post-migration counts (25 notes)')
    : bad('--dry-run counts wrong: ' + dry.after.observations);

  // --- the real migration ---
  const rep = upgradeBrain(legacy);
  rep.fromVersion === 3 && rep.toVersion === SCHEMA_VERSION
    ? ok('migrated v' + rep.fromVersion + ' -> v' + rep.toVersion)
    : bad('wrong versions: ' + rep.fromVersion + ' -> ' + rep.toVersion);
  rep.after.observations === 25 && rep.after.projects === 1 && rep.after.project_context === 1
    ? ok('no rows lost (25 notes, 1 project, 1 context row)')
    : bad('row counts changed: ' + JSON.stringify(rep.after));
  rep.integrity === 'ok' && rep.foreignKeyViolations === 0
    ? ok('integrity_check ok, foreign_key_check clean')
    : bad('integrity=' + rep.integrity + ' fk=' + rep.foreignKeyViolations);
  rep.backup && fs.existsSync(rep.backup.backupPath)
    ? ok('backup written: ' + rep.backup.files.join(', '))
    : bad('no backup was written');

  // The backfill is the one thing that SHOULD change a value.
  const after = MyJarbisDB.openExisting(legacy);
  const backfilled = after.db.prepare(
    'SELECT COUNT(*) n FROM observations WHERE project_id IS NULL').get().n;
  backfilled === 0
    ? ok('project_id backfilled on all 25 pre-v4 notes')
    : bad(backfilled + ' notes still have a NULL project_id');
  after.close();

  // --- idempotent ---
  const again = upgradeBrain(legacy);
  again.alreadyCurrent
    ? ok('re-running reports alreadyCurrent and changes nothing')
    : bad('second migration did work it should not have');
}

// ───────────────────────────────────────────────────────────────────
// 2. the WAL is part of the backup
// ───────────────────────────────────────────────────────────────────
console.log('→ [2] a backup includes the WAL, not just the .db');
{
  const target = seeded[0].dbPath;
  const db = MyJarbisDB.openExisting(target);
  db.bindScope({ kind: 'project', id: 1 });
  // Leave something in the WAL without checkpointing it.
  db.db.pragma('wal_checkpoint(TRUNCATE)');
  db.db.prepare('INSERT INTO project_context (project_id, kind, title, content, content_hash) VALUES (1, ?, ?, ?, ?)')
    .run('gotchas', 'only in the wal', 'this row lives in the -wal file', 'hw');
  const walSize = fs.existsSync(target + '-wal') ? fs.statSync(target + '-wal').size : 0;
  db.close();

  const bk = backupBrain(target, 'waltest');
  walSize > 0
    ? ok('wrote ' + walSize + ' bytes of un-checkpointed WAL before backing up')
    : ok('WAL was already flushed by close (still covered below)');
  const restored = MyJarbisDB.openExisting(bk.backupPath);
  const found = restored.db.prepare(
    \"SELECT COUNT(*) n FROM project_context WHERE title = 'only in the wal'\").get().n;
  restored.close();
  found === 1
    ? ok('the WAL-resident row is present in the backup')
    : bad('the backup lost the WAL-resident row — this is the 3-4 MB failure mode');
}

// ───────────────────────────────────────────────────────────────────
// 3. merge all three into one shared brain
// ───────────────────────────────────────────────────────────────────
console.log('→ [3] merging three brains into one shared brain');
const SHARED = W + '/home/memory.db';
fs.mkdirSync(W + '/home', { recursive: true });
{
  const reports = [];
  for (const s of seeded) {
    const r = mergeBrain({ from: s.dbPath, into: SHARED, skipBackup: false });
    reports.push(r);
    r.mismatches.length === 0
      ? ok(s.name + ': counts add up (' + r.copied.observations + ' notes, ' +
           r.copied.sessions + ' sessions, ' + r.copied.modules + ' modules)')
      : bad(s.name + ': MISMATCH ' + JSON.stringify(r.mismatches));
    r.integrity === 'ok' && r.foreignKeyViolations === 0
      ? ok(s.name + ': integrity ok, no dangling foreign keys')
      : bad(s.name + ': integrity=' + r.integrity + ' fk=' + r.foreignKeyViolations);
  }

  // --- totals ---
  const db = MyJarbisDB.openExisting(SHARED);
  db.bindScope({ kind: 'all', reason: 'verifying the merge' });
  const total = (t) => db.db.prepare('SELECT COUNT(*) n FROM ' + t).get().n;
  const expectedObs = seeded.reduce((a, s) => a + s.counts.observations, 0);
  total('projects') === 3
    ? ok('3 projects in the shared brain')
    : bad(total('projects') + ' projects, expected 3');
  total('observations') === expectedObs
    ? ok(expectedObs + ' notes, all accounted for')
    : bad(total('observations') + ' notes, expected ' + expectedObs);

  // --- THE critical check: no foreign key crosses a project boundary ---
  const crossed = db.db.prepare(\`
    SELECT COUNT(*) n FROM observations o
      JOIN sessions s  ON s.id = o.session_id
      JOIN modules  m  ON m.id = s.module_id
     WHERE m.project_id != o.project_id\`).get().n;
  crossed === 0
    ? ok('every note sits under a session of its OWN project')
    : bad(crossed + ' notes point at a session belonging to another project');

  const orphanRefs = db.db.prepare(\`
    SELECT COUNT(*) n FROM refs r
     WHERE NOT EXISTS (SELECT 1 FROM observations o WHERE o.id = r.observation_id)\`).get().n;
  orphanRefs === 0 ? ok('no orphaned refs') : bad(orphanRefs + ' orphaned refs');

  // --- the self-referential link survived the remap ---
  const chains = db.db.prepare(\`
    SELECT COUNT(*) n FROM observations a JOIN observations b ON b.id = a.supersedes
     WHERE a.project_id = b.project_id\`).get().n;
  chains === seeded.length
    ? ok('all ' + chains + ' supersedes links survived, each within its own project')
    : bad('expected ' + seeded.length + ' intra-project supersedes links, found ' + chains);

  const badChains = db.db.prepare(\`
    SELECT COUNT(*) n FROM observations a JOIN observations b ON b.id = a.supersedes
     WHERE a.project_id != b.project_id\`).get().n;
  badChains === 0
    ? ok('no supersedes link crosses a project')
    : bad(badChains + ' supersedes links point into another project');

  // --- FTS rebuilt and resolving to the RIGHT rows ---
  const ftsHits = db.db.prepare(\`
    SELECT o.title, o.project_id FROM observations_fts
      JOIN observations o ON o.id = observations_fts.rowid
     WHERE observations_fts MATCH 'zarquon0'\`).all();
  const resolvesCorrectly = ftsHits.length > 0 &&
    ftsHits.every((h) => h.title.includes('finding number 0'));
  resolvesCorrectly
    ? ok('FTS rebuilt: ' + ftsHits.length + ' hits for \"zarquon0\", all resolving to the right rows')
    : bad('FTS resolves to the wrong rows after the remap: ' + JSON.stringify(ftsHits));

  // --- and FTS respects the tenant boundary ---
  db.close();
  const scoped = MyJarbisDB.openExisting(SHARED);
  scoped.bindScope({ kind: 'project', id: 1 });
  const leaked = scoped.search('zarquon0', { scope: 'observations' })
    .filter((h) => !h.title.startsWith('acme-portal'));
  leaked.length === 0
    ? ok('a scoped FTS search over the merged brain returns only its own project')
    : bad('scoped search leaked ' + leaked.length + ' rows from other projects');
  scoped.close();
}

// ───────────────────────────────────────────────────────────────────
// 4. merging twice is refused, not duplicated
// ───────────────────────────────────────────────────────────────────
console.log('→ [4] re-merging the same project is refused');
{
  try {
    mergeBrain({ from: seeded[0].dbPath, into: SHARED, skipBackup: true });
    bad('a second merge of the same project was allowed');
  } catch (e) {
    /already has a project/.test(e.message)
      ? ok('refused: ' + e.message.split('.')[0])
      : bad('wrong error: ' + e.message);
  }

  // Even under a different name, the git remote gives it away.
  try {
    mergeBrain({ from: seeded[0].dbPath, into: SHARED, asName: 'acme-portal-copy', skipBackup: true });
    bad('the same repository was merged twice under a different name');
  } catch (e) {
    /git remote|already has a project at path/.test(e.message)
      ? ok('refused by path or remote even under a new name')
      : bad('wrong error: ' + e.message);
  }

  const db = MyJarbisDB.openExisting(SHARED);
  db.bindScope({ kind: 'all', reason: 'confirming nothing was duplicated' });
  db.db.prepare('SELECT COUNT(*) n FROM projects').get().n === 3
    ? ok('still exactly 3 projects after the refused attempts')
    : bad('project count changed after a refused merge');
  db.close();
}

// ───────────────────────────────────────────────────────────────────
// 5. a dry-run merge does not touch the destination
// ───────────────────────────────────────────────────────────────────
console.log('→ [5] a dry-run merge leaves the destination untouched');
{
  const fresh = seedClient({ name: 'hooli-crm', modules: ['api'], notes: 5 });
  const before = (() => {
    const db = MyJarbisDB.openExisting(SHARED);
    db.bindScope({ kind: 'all', reason: 'before a dry run' });
    const n = db.db.prepare('SELECT COUNT(*) n FROM projects').get().n;
    db.close(); return n;
  })();

  const r = mergeBrain({ from: fresh.dbPath, into: SHARED, dryRun: true });
  r.copied.projects === 1 && r.copied.observations === fresh.counts.observations
    ? ok('dry run reported the real work (' + r.copied.observations + ' notes)')
    : bad('dry run reported wrong counts: ' + JSON.stringify(r.copied));

  const after = (() => {
    const db = MyJarbisDB.openExisting(SHARED);
    db.bindScope({ kind: 'all', reason: 'after a dry run' });
    const n = db.db.prepare('SELECT COUNT(*) n FROM projects').get().n;
    db.close(); return n;
  })();
  after === before
    ? ok('destination unchanged (' + before + ' projects before and after)')
    : bad('dry run wrote to the destination: ' + before + ' -> ' + after);

  // And the real thing still works afterwards.
  const real = mergeBrain({ from: fresh.dbPath, into: SHARED, skipBackup: true });
  real.mismatches.length === 0
    ? ok('the real merge after the dry run adds up')
    : bad('real merge mismatched: ' + JSON.stringify(real.mismatches));
}

if (failed > 0) { console.error('\\n✗ ' + failed + ' assertion(s) failed'); process.exit(1); }
"

echo "✓ v03-migrate-merge E2E PASSED"
