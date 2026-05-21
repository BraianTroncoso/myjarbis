#!/bin/bash
#
# E2E tests for markdown chunking in `import_md` and `myjarbis rechunk`.
#
# Covers:
#   1. Short docs (<threshold) still land as a single row with the
#      original source_path (no `#` anchor).
#   2. Docs above threshold land as N rows, one per H2, with
#      `source_path#<slug>` and titles `<docTitle> / <heading>`.
#   3. Re-importing a chunked doc yields status=unchanged (per-chunk
#      content_hash idempotency).
#   4. Editing only one section reports aggregated status=updated and
#      mutates exactly one chunk's content_hash.
#   5. `myjarbis rechunk` finds oversized pre-existing rows, takes a
#      VACUUM INTO backup, and replaces them with chunked rows.
#   6. `myjarbis rechunk --dry-run` reports the plan without writing.
#
# Exits 0 on success, non-zero on any assertion failure.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FIXTURES="$REPO_ROOT/tests/fixtures"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$MYJARBIS_INSTALL_DIR/mcp-server/build/cli.js"
SEED_HELPER="$MYJARBIS_INSTALL_DIR/mcp-server/build/db/migrate.js"
DB_HELPER="$MYJARBIS_INSTALL_DIR/mcp-server/build/db/index.js"

# ─── preflight ───
if [ ! -f "$CLI" ]; then
  echo "✗ MCP build not found at $CLI — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-chunking-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"

# ─── seed project + module ───
node --input-type=module -e "
  import { seedNewProject } from '$SEED_HELPER';
  import { MyJarbisDB } from '$DB_HELPER';
  const r = seedNewProject('$WORK', { name: 'chunking-test', framework: 'generic' });
  const db = MyJarbisDB.open('$WORK');
  db.modules.upsertByName(r.projectId, 'MM', 'Media Manager');
  db.close();
"
cd "$WORK"
cp "$FIXTURES/small.md" "$WORK/small.md"
cp "$FIXTURES/medium-headings.md" "$WORK/medium.md"

count_rows() {
  local where="$1"
  node --input-type=module -e "
    import { MyJarbisDB } from '$DB_HELPER';
    const db = MyJarbisDB.open('$WORK');
    const n = db.db.prepare('SELECT COUNT(*) as n FROM module_context WHERE ' + ${where@Q}).get().n;
    console.log(n);
    db.close();
  "
}

# ─── 1. small doc → 1 row, source_path unchanged ───
echo "→ test 1: small doc stays as one row"
SMALL_OUT="$("$MJ" import small.md --target=module:MM --kind=other)"
SMALL_CHUNKS="$(echo "$SMALL_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).chunks))")"
if [ "$SMALL_CHUNKS" != "1" ]; then
  echo "✗ expected chunks=1 for small doc, got $SMALL_CHUNKS"
  echo "$SMALL_OUT"
  exit 1
fi
SMALL_SOURCE="$(node --input-type=module -e "
  import { MyJarbisDB } from '$DB_HELPER';
  const db = MyJarbisDB.open('$WORK');
  const row = db.db.prepare(\"SELECT source_path FROM module_context WHERE source_path LIKE 'small%'\").get();
  console.log(row.source_path);
  db.close();
")"
if [ "$SMALL_SOURCE" != "small.md" ]; then
  echo "✗ expected source_path=small.md, got $SMALL_SOURCE"
  exit 1
fi
echo "  ✓ small.md → 1 row, source_path=small.md"

# ─── 2. medium doc → multiple rows with #slug ───
echo "→ test 2: medium doc splits into chunks"
MED_OUT="$("$MJ" import medium.md --target=module:MM --kind=workflow)"
MED_CHUNKS="$(echo "$MED_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).chunks))")"
if [ "$MED_CHUNKS" -lt 3 ]; then
  echo "✗ expected chunks>=3 for medium doc, got $MED_CHUNKS"
  echo "$MED_OUT"
  exit 1
fi
# Each chunk must have its own #slug-style source_path.
HASHED="$(node --input-type=module -e "
  import { MyJarbisDB } from '$DB_HELPER';
  const db = MyJarbisDB.open('$WORK');
  const rows = db.db.prepare(\"SELECT source_path FROM module_context WHERE source_path LIKE 'medium.md%'\").all();
  const ok = rows.every(r => r.source_path.includes('#'));
  console.log(ok ? 'yes' : 'no:' + JSON.stringify(rows));
  db.close();
")"
if [ "$HASHED" != "yes" ]; then
  echo "✗ medium.md chunks missing #slug anchor: $HASHED"
  exit 1
fi
echo "  ✓ medium.md → $MED_CHUNKS chunks, each with #slug"

# ─── 3. re-import medium → unchanged ───
echo "→ test 3: re-import medium is idempotent"
RE_OUT="$("$MJ" import medium.md --target=module:MM --kind=workflow)"
RE_STATUS="$(echo "$RE_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).status))")"
if [ "$RE_STATUS" != "unchanged" ]; then
  echo "✗ expected status=unchanged on re-import, got $RE_STATUS"
  exit 1
fi
echo "  ✓ re-import status=unchanged"

# ─── 4. edit one section → status=updated, only one content_hash changes ───
echo "→ test 4: partial edit reports updated"
BEFORE_HASHES="$(node --input-type=module -e "
  import { MyJarbisDB } from '$DB_HELPER';
  const db = MyJarbisDB.open('$WORK');
  const rows = db.db.prepare(\"SELECT source_path, content_hash FROM module_context WHERE source_path LIKE 'medium.md%' ORDER BY source_path\").all();
  console.log(JSON.stringify(rows));
  db.close();
")"
# Append a sentinel line to the Render section.
node -e "
  const fs = require('fs');
  const p = '$WORK/medium.md';
  const src = fs.readFileSync(p, 'utf-8');
  fs.writeFileSync(p, src + '\nSENTINEL EDIT — only this section should change.\n');
"
EDIT_OUT="$("$MJ" import medium.md --target=module:MM --kind=workflow)"
EDIT_STATUS="$(echo "$EDIT_OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).status))")"
if [ "$EDIT_STATUS" != "updated" ]; then
  echo "✗ expected status=updated after partial edit, got $EDIT_STATUS"
  exit 1
fi
AFTER_HASHES="$(node --input-type=module -e "
  import { MyJarbisDB } from '$DB_HELPER';
  const db = MyJarbisDB.open('$WORK');
  const rows = db.db.prepare(\"SELECT source_path, content_hash FROM module_context WHERE source_path LIKE 'medium.md%' ORDER BY source_path\").all();
  console.log(JSON.stringify(rows));
  db.close();
")"
DIFF_COUNT="$(node -e "
  const a = JSON.parse(process.argv[1]);
  const b = JSON.parse(process.argv[2]);
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i].content_hash !== b[i].content_hash) d++;
  console.log(d);
" "$BEFORE_HASHES" "$AFTER_HASHES")"
if [ "$DIFF_COUNT" != "1" ]; then
  echo "✗ expected exactly 1 chunk to change hash, got $DIFF_COUNT"
  echo "before: $BEFORE_HASHES"
  echo "after:  $AFTER_HASHES"
  exit 1
fi
echo "  ✓ partial edit touched exactly 1 chunk hash"

# ─── 5. rechunk on a synthetic pre-existing oversized row ───
echo "→ test 5: rechunk replaces oversized legacy rows"
node --input-type=module -e "
  import { MyJarbisDB } from '$DB_HELPER';
  const db = MyJarbisDB.open('$WORK');
  const mod = db.modules.findByName(1, 'MM');
  const big = '# Legacy Doc\n\n## A\n\n' + 'a'.repeat(3000) + '\n\n## B\n\n' + 'b'.repeat(3000);
  db.moduleContext.upsert({
    moduleId: mod.id, kind: 'plan', title: 'Legacy Doc',
    content: big, sourcePath: 'legacy.md',
  });
  db.close();
"
RE_JSON="$("$MJ" rechunk MM --json)"
RE_TOTAL="$(echo "$RE_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).total_rows))")"
RE_BACKUP="$(echo "$RE_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).backup))")"
if [ "$RE_TOTAL" -lt 1 ]; then
  echo "✗ expected rechunk to find >=1 oversized row, got total_rows=$RE_TOTAL"
  echo "$RE_JSON"
  exit 1
fi
if [ ! -f "$RE_BACKUP" ]; then
  echo "✗ rechunk backup not created at $RE_BACKUP"
  exit 1
fi
LEGACY_ROWS="$(node --input-type=module -e "
  import { MyJarbisDB } from '$DB_HELPER';
  const db = MyJarbisDB.open('$WORK');
  const n = db.db.prepare(\"SELECT COUNT(*) as n FROM module_context WHERE source_path LIKE 'legacy.md%'\").get().n;
  console.log(n);
  db.close();
")"
if [ "$LEGACY_ROWS" -lt 2 ]; then
  echo "✗ expected legacy.md to become >=2 rows after rechunk, got $LEGACY_ROWS"
  exit 1
fi
echo "  ✓ legacy row split into $LEGACY_ROWS chunks, backup at $RE_BACKUP"

# ─── 6. rechunk --dry-run is a no-op ───
echo "→ test 6: rechunk --dry-run does not write"
# Insert another oversized row so dry-run has something to report.
node --input-type=module -e "
  import { MyJarbisDB } from '$DB_HELPER';
  const db = MyJarbisDB.open('$WORK');
  const mod = db.modules.findByName(1, 'MM');
  db.moduleContext.upsert({
    moduleId: mod.id, kind: 'other', title: 'Dry Doc',
    content: '# Dry\n\n## X\n\n' + 'x'.repeat(3000) + '\n\n## Y\n\n' + 'y'.repeat(3000),
    sourcePath: 'dry.md',
  });
  db.close();
"
DRY_JSON="$("$MJ" rechunk MM --dry-run --json)"
DRY_BACKUP="$(echo "$DRY_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).backup))")"
DRY_FLAG="$(echo "$DRY_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>console.log(JSON.parse(d).dry_run))")"
if [ "$DRY_FLAG" != "true" ] || [ "$DRY_BACKUP" != "null" ]; then
  echo "✗ dry-run should set dry_run=true and backup=null"
  echo "$DRY_JSON"
  exit 1
fi
DRY_ROWS_AFTER="$(node --input-type=module -e "
  import { MyJarbisDB } from '$DB_HELPER';
  const db = MyJarbisDB.open('$WORK');
  const n = db.db.prepare(\"SELECT COUNT(*) as n FROM module_context WHERE source_path = 'dry.md'\").get().n;
  console.log(n);
  db.close();
")"
if [ "$DRY_ROWS_AFTER" != "1" ]; then
  echo "✗ dry-run wrote to DB: dry.md row count is $DRY_ROWS_AFTER (expected 1)"
  exit 1
fi
echo "  ✓ dry-run preserved DB"

echo "✓ chunking E2E PASSED"
