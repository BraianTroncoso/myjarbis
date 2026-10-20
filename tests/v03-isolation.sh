#!/bin/bash
#
# E2E test: tenant isolation in a shared brain.
#
# This is the most important test in the suite. Before v0.3 isolation was a
# property of the filesystem — one database per project, so a query could not
# reach another project's rows. The shared brain removes that guarantee, and
# this file is what replaces it.
#
# It builds a shared database holding two fictional clients and then asserts,
# five ways, that neither can see the other:
#   1. a read with NO scope bound fails, rather than returning everything
#   2. a scoped connection sees only its own rows (list, and FTS search)
#   3. passing the other tenant's id is refused, not honoured
#   4. crossing tenants requires an explicit 'all' scope AND a reason
#   5. a bound connection cannot be switched to another tenant mid-flight
#
# Exits 0 on success, non-zero on the first failed assertion.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"

if [ ! -f "$B/db/index.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-iso-test-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"

# ─── hermetic HOME ────────────────────────────────────────────────
#
# Insurance, not a behaviour change: every assertion below opens
# $WORK/shared.db by explicit path (MyJarbisDB.openAtPath), so the brain
# under test is not the one HOME or MYJARBIS_HOME resolve to. Pinning them
# anyway means a future assertion that DOES go through the default
# resolution cannot silently land in the developer's real ~/.myjarbis.
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

node --input-type=module -e "
import { MyJarbisDB } from '$B/db/index.js';

let failed = 0;
const ok   = (m) => console.log('    ✓ ' + m);
const bad  = (m) => { console.error('    ✗ ' + m); failed++; };
const DB   = '$WORK/shared.db';

// ─── fixture: two fictional clients in ONE file ───
{
  const db = MyJarbisDB.openAtPath(DB);
  db.bindScope({ kind: 'all', reason: 'building the test fixture' });
  const a = db.projects.create({ name: 'acme-portal',  path: '$WORK/acme',  isolation: 'shared' });
  const b = db.projects.create({ name: 'globex-store', path: '$WORK/globex', isolation: 'shared' });
  const ma = db.modules.create(a.id, 'api');
  const mb = db.modules.create(b.id, 'api');
  const sa = db.sessions.start(ma.id);
  const sb = db.sessions.start(mb.id);
  db.observations.add({ sessionId: sa.id, kind: 'gotcha',
    title: 'Acme credentials rotate weekly', content: 'rotation detail belonging to Acme' });
  db.observations.add({ sessionId: sb.id, kind: 'gotcha',
    title: 'Globex credentials rotate daily', content: 'rotation detail belonging to Globex' });
  db.projectContext.upsert({ projectId: a.id, kind: 'gotchas',
    title: 'Acme rotation note', content: 'credentials are Acme-specific' });
  db.projectContext.upsert({ projectId: b.id, kind: 'gotchas',
    title: 'Globex rotation note', content: 'credentials are Globex-specific' });
  db.close();
  console.log('  fixture: 2 projects, 2 modules, 2 sessions, 2 notes, 2 context rows');
}

// ─── 1. an unscoped read must FAIL ───
console.log('→ [1] a read with no scope bound must fail, not return everything');
{
  const db = MyJarbisDB.openAtPath(DB);
  try { const h = db.search('credentials', { scope: 'observations' });
        bad('unscoped search returned ' + h.length + ' rows'); }
  catch (e) { e.type === 'SCOPE_NOT_RESOLVED'
      ? ok('search threw SCOPE_NOT_RESOLVED')
      : bad('search threw the wrong error: ' + e.type); }

  try { db.projects.list(); bad('unscoped projects.list() succeeded'); }
  catch (e) { e.type === 'SCOPE_NOT_RESOLVED'
      ? ok('projects.list() threw SCOPE_NOT_RESOLVED')
      : bad('projects.list() threw the wrong error: ' + e.type); }
  db.close();
}

// ─── 2. a scoped connection sees only its own rows ───
console.log('→ [2] scoped to Acme: sees only Acme');
{
  const db = MyJarbisDB.openAtPath(DB);
  db.bindScope({ kind: 'project', id: 1 });

  const names = db.projects.list().map((p) => p.name);
  JSON.stringify(names) === JSON.stringify(['acme-portal'])
    ? ok('projects.list() -> ' + JSON.stringify(names))
    : bad('projects.list() leaked: ' + JSON.stringify(names));

  const obs = db.search('credentials', { scope: 'observations' }).map((h) => h.title);
  obs.length === 1 && obs[0].includes('Acme')
    ? ok('FTS over notes -> ' + JSON.stringify(obs))
    : bad('FTS over notes leaked: ' + JSON.stringify(obs));

  const pc = db.search('credentials', { scope: 'project' }).map((h) => h.title);
  pc.length === 1 && pc[0].includes('Acme')
    ? ok('FTS over context -> ' + JSON.stringify(pc))
    : bad('FTS over context leaked: ' + JSON.stringify(pc));
  db.close();
}

// ─── 3. passing the other tenant's id is refused ───
console.log('→ [3] passing the other tenant\\'s id is refused, not honoured');
{
  const db = MyJarbisDB.openAtPath(DB);
  db.bindScope({ kind: 'project', id: 1 });

  try { const r = db.projectContext.listByProject(2);
        bad('read ' + r.length + ' of Globex\\'s context rows'); }
  catch (e) { e.type === 'OUT_OF_SCOPE'
      ? ok('listByProject(other) threw OUT_OF_SCOPE')
      : bad('wrong error: ' + e.type); }

  try { db.modules.findById(2); bad('read Globex\\'s module by id'); }
  catch (e) { e.type === 'OUT_OF_SCOPE'
      ? ok('modules.findById(other) threw OUT_OF_SCOPE')
      : bad('wrong error: ' + e.type); }

  try { db.observations.findById(2); bad('read Globex\\'s note by id'); }
  catch (e) { e.type === 'OUT_OF_SCOPE'
      ? ok('observations.findById(other) threw OUT_OF_SCOPE')
      : bad('wrong error: ' + e.type); }
  db.close();
}

// ─── 4. crossing tenants is explicit and needs a reason ───
console.log('→ [4] crossing tenants requires an explicit scope and a reason');
{
  const db = MyJarbisDB.openAtPath(DB);
  db.bindScope({ kind: 'all', reason: 'auditing gotchas across clients' });
  const titles = db.search('credentials', { scope: 'observations' }).map((h) => h.title);
  titles.length === 2
    ? ok('explicit all-scope sees both: ' + titles.length + ' rows')
    : bad('all-scope saw ' + titles.length + ' rows, expected 2');

  try { db.projects.listAll(''); bad('listAll() accepted an empty reason'); }
  catch (e) { e.type === 'SCOPE_NOT_RESOLVED'
      ? ok('listAll(\"\") refused: a reason is mandatory')
      : bad('wrong error: ' + e.type); }
  db.close();
}

// ─── 5. no tenant switch on a live connection ───
console.log('→ [5] a bound connection cannot switch tenants mid-flight');
{
  const db = MyJarbisDB.openAtPath(DB);
  db.bindScope({ kind: 'project', id: 1 });
  try { db.bindScope({ kind: 'project', id: 2 }); bad('rebind to another tenant allowed'); }
  catch (e) { e.type === 'OUT_OF_SCOPE'
      ? ok('rebind refused')
      : bad('wrong error: ' + e.type); }

  // Re-binding the SAME scope is harmless and must stay allowed, or every
  // caller has to track whether it already bound.
  try { db.bindScope({ kind: 'project', id: 1 }); ok('rebind to the same tenant allowed'); }
  catch (e) { bad('rebind to the same tenant was refused: ' + e.type); }

  // Widening a pinned connection is refused: it would end up able to see
  // more than it could a moment ago, with no reason recorded.
  try { db.bindScope({ kind: 'all', reason: 'sneaky widening' });
        bad('a pinned connection was widened to all projects'); }
  catch (e) { e.type === 'OUT_OF_SCOPE'
      ? ok('widening project -> all refused')
      : bad('wrong error: ' + e.type); }
  db.close();

  // Narrowing the other way MUST be allowed, or a tool that legitimately
  // opens a brain across projects (merge, org sync) could never then work
  // inside one of them.
  const w = MyJarbisDB.openAtPath(DB);
  w.bindScope({ kind: 'all', reason: 'a cross-project tool starting up' });
  try { w.bindScope({ kind: 'project', id: 2 });
        const seen = w.projects.list().map((p) => p.name);
        JSON.stringify(seen) === JSON.stringify(['globex-store'])
          ? ok('narrowing all -> project allowed, and the narrowing takes effect')
          : bad('narrowed but still sees: ' + JSON.stringify(seen)); }
  catch (e) { bad('narrowing all -> project was refused: ' + e.type); }
  w.close();
}

if (failed > 0) { console.error('\\n✗ ' + failed + ' isolation assertion(s) failed'); process.exit(1); }
"

echo "✓ v03-isolation E2E PASSED"
