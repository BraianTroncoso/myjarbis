#!/bin/bash
#
# E2E test: several modules open at once, one of them primary.
#
# `.myjarbis/active` held one module name. Work does not respect module
# boundaries — touching the CLI means reading what the MCP server does — so the
# old shape forced a choice between carrying the wrong context and switching
# modules mid-thought, which closes one session and opens another for what is
# one piece of work.
#
# The shape chosen, and what each assertion here is defending:
#
#   · PRIMARY + COMPANIONS, not equals. Everything that writes needs one home:
#     `sessions.module_id` is a single column, and a handoff in three copies is
#     three handoffs to reconcile. Companions are for reading.
#   · No schema migration. `.myjarbis/active` becomes a list, primary on line
#     one — where the old reader already looked.
#   · Companions load at INDEX depth. Loading their bodies would spend the
#     context window before any work starts.
#   · One selection, two entry points. `myjarbis module use a,b` before opening
#     Claude and `start_session(module, with_modules)` from inside it must write
#     the same file, or they are two features that look like one.
#
# Exits 0 on success, non-zero on the first failed assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$B/cli.js"

if [ ! -f "$B/context.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-multimodule-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

mkdir -p "$WORK/proj" && cd "$WORK/proj" && git init -q .
git config user.email t@example.com && git config user.name Test
"$MJ" init --yes --skip-memory >/dev/null 2>&1
"$MJ" module add cli    --description="bash bin/*" >/dev/null
"$MJ" module add server --description="MCP server" >/dev/null
"$MJ" module add docs   --description="Documentation" >/dev/null

ACTIVE="$WORK/proj/.myjarbis/active"

brain() {
  node --input-type=module -e "
    process.chdir('$WORK/proj');
    import { ServerContext } from '$B/context.js';
    const ctx = ServerContext.initialize();
    const db = ctx.db;
    const mod = (n) => db.modules.listByProject(ctx.project.id).find(m => m.name === n);
    try { $1 } finally { ctx.close(); }
  " 2>&1
}

# Context to find later, one row in each module, with a word unique to it.
brain "
  db.moduleContext.upsert({ moduleId: mod('cli').id, kind: 'workflow',
    title: 'CLI workflow', content: 'the zebraword lives in the cli module' });
  db.moduleContext.upsert({ moduleId: mod('server').id, kind: 'workflow',
    title: 'Server workflow', content: 'the zebraword also lives in the server module' });
  db.moduleContext.upsert({ moduleId: mod('docs').id, kind: 'workflow',
    title: 'Docs workflow', content: 'the zebraword lives in docs too' });
" >/dev/null

# ── [1] `module use` takes several, in either notation ───────────────────
echo "[1] module use accepts a list, primary first"
"$MJ" module use cli,server >/dev/null 2>&1
if [ "$(cat "$ACTIVE")" = "$(printf 'cli\nserver')" ]; then
    pass "comma-separated: primary on line 1, companion on line 2"
else
    oops "unexpected file contents: $(tr '\n' '|' < "$ACTIVE")"
fi
"$MJ" module use cli server docs >/dev/null 2>&1
if [ "$(wc -l < "$ACTIVE")" -eq 3 ]; then
    pass "space-separated works the same way (3 modules)"
else
    oops "space-separated form did not produce 3 lines"
fi
# The old one-name file must still read correctly — people have one on disk.
printf 'server\n' > "$ACTIVE"
CUR="$("$MJ" module current --json 2>/dev/null)"
if echo "$CUR" | grep -q '"primary": *"server"' && echo "$CUR" | grep -q '"companions": *\[\]'; then
    pass "a file written by the old single-module version still reads as primary"
else
    oops "backward compatibility broken: $CUR"
fi

# ── [2] a typo rejects the whole selection ──────────────────────────────
#
# A half-applied selection is worse than a rejected one: the hook would open
# on a primary the user did not mean.
echo "[2] an unknown module rejects the selection instead of half-applying it"
"$MJ" module use cli,server >/dev/null 2>&1
OUT="$("$MJ" module use cli,nosuchmodule 2>&1)"
if echo "$OUT" | grep -qi 'does not exist'; then
    pass "refused with a message naming the problem"
else
    oops "expected a refusal, got: $OUT"
fi
if [ "$(cat "$ACTIVE")" = "$(printf 'cli\nserver')" ]; then
    pass "and the previous selection was left untouched"
else
    oops "the failed call changed the selection to: $(tr '\n' '|' < "$ACTIVE")"
fi

# ── [3] the hook greets with the primary and indexes the companions ─────
echo "[3] SessionStart loads the primary and lists companions at index depth"
"$MJ" module use cli,server,docs >/dev/null 2>&1
HOOK="$(printf '{"session_id":"T1","cwd":"%s"}' "$WORK/proj" | node "$CLI" hook session-start 2>/dev/null)"
if echo "$HOOK" | grep -q 'Module: cli.*(primary)'; then
    pass "the primary is named as primary"
else
    oops "no primary marker in the greeting: $(echo "$HOOK" | grep -i '^Module' || echo '(no Module line)')"
fi
if echo "$HOOK" | grep -q 'Also open (read-only, index only): 2'; then
    pass "both companions are announced"
else
    oops "companions not announced: $(echo "$HOOK" | grep -i 'also open' || echo '(no line)')"
fi
if echo "$HOOK" | grep -q '· server — MCP server' && echo "$HOOK" | grep -q '· docs — Documentation'; then
    pass "each companion is listed with its description"
else
    oops "companion lines missing or malformed"
fi
if echo "$HOOK" | grep -q 'row(s)' && echo "$HOOK" | grep -qi 'no closed session yet'; then
    pass "each carries its row count and when it was last worked in"
else
    oops "the companion lines lack the counts or the last-worked marker"
fi
# Index depth means the BODY of a companion row must not be in the greeting.
if echo "$HOOK" | grep -q 'zebraword also lives in the server module'; then
    oops "a companion's row body was dumped into the greeting — that is not index depth"
else
    pass "no companion body in the greeting"
fi

# ── [4] a stale name in the file is reported, not fatal ─────────────────
echo "[4] a companion that no longer exists is skipped with a warning"
printf 'cli\nghostmodule\n' > "$ACTIVE"
ERR="$(printf '{"session_id":"T2","cwd":"%s"}' "$WORK/proj" | node "$CLI" hook session-start 2>&1 >/dev/null)"
OUTP="$(printf '{"session_id":"T2b","cwd":"%s"}' "$WORK/proj" | node "$CLI" hook session-start 2>/dev/null)"
if echo "$ERR" | grep -q 'ghostmodule'; then
    pass "the skipped name is reported on stderr"
else
    oops "the stale companion was dropped silently: $ERR"
fi
if echo "$OUTP" | grep -q 'Module: cli'; then
    pass "and the greeting still works"
else
    oops "a stale companion broke the greeting"
fi

# ── [5] start_session(with_modules) writes the same selection ───────────
#
# Two entry points, one file. If the chat path and the CLI path disagreed,
# the selection would depend on how it was made.
echo "[5] start_session with_modules persists the same selection"
printf 'docs\n' > "$ACTIVE"
OUT="$(brain "
  const { startSession } = await import('$B/tools/session.js');
  const r = startSession(ctx, { module: 'cli', with_modules: ['server', 'docs'] });
  console.log(JSON.stringify({
    module: r.module.name,
    companions: (r.companions ?? []).map(c => ({ m: c.module, rows: c.rows })),
  }));
")"
if echo "$OUT" | grep -q '"module":"cli"'; then
    pass "the session opened on the primary"
else
    oops "start_session did not open on cli: $OUT"
fi
if echo "$OUT" | grep -q '"m":"server"' && echo "$OUT" | grep -q '"m":"docs"'; then
    pass "both companions came back in the result"
else
    oops "companions missing from the result: $OUT"
fi
if echo "$OUT" | grep -q '"rows":1'; then
    pass "each companion reports its row count, not its rows"
else
    oops "companion row counts missing: $OUT"
fi
if [ "$(cat "$ACTIVE")" = "$(printf 'cli\nserver\ndocs')" ]; then
    pass "and the selection was written where the hook will read it"
else
    oops "start_session did not persist the selection: $(tr '\n' '|' < "$ACTIVE")"
fi

# ── [6] search follows the open set, and says so ────────────────────────
echo "[6] scope=module spans the open modules"
OUT="$(brain "
  const { search } = await import('$B/tools/search.js');
  const { startSession } = await import('$B/tools/session.js');
  startSession(ctx, { module: 'cli', with_modules: ['server'] });
  const r = search(ctx, { query: 'zebraword' });
  console.log(JSON.stringify({
    companions: r.scopeContext.companions ?? [],
    titles: r.hits.map(h => h.title).sort(),
  }));
")"
if echo "$OUT" | grep -q 'CLI workflow' && echo "$OUT" | grep -q 'Server workflow'; then
    pass "hits came from the primary AND the companion"
else
    oops "the search did not span the open set: $OUT"
fi
if echo "$OUT" | grep -q 'Docs workflow'; then
    oops "a module that is NOT open was searched — the default scope leaked"
else
    pass "the module that was not open stayed out"
fi
if echo "$OUT" | grep -q '"companions":\["server"\]'; then
    pass "the response names which companions were searched"
else
    oops "scopeContext does not say what was searched: $OUT"
fi
# An explicit module is an explicit answer: it must NOT be widened.
OUT="$(brain "
  const { search } = await import('$B/tools/search.js');
  const r = search(ctx, { query: 'zebraword', module: 'cli' });
  console.log(JSON.stringify(r.hits.map(h => h.title).sort()));
")"
if echo "$OUT" | grep -q 'CLI workflow' && ! echo "$OUT" | grep -q 'Server workflow'; then
    pass "an explicit module= is not widened to the companions"
else
    oops "module= was widened, so there is no way to search one module: $OUT"
fi

# ── [7] writes land in the primary unless told otherwise ────────────────
echo "[7] observations go to the primary by default"
OUT="$(brain "
  const { saveObservation } = await import('$B/tools/observations.js');
  const { startSession } = await import('$B/tools/session.js');
  const s = startSession(ctx, { module: 'cli', with_modules: ['server'] });
  const a = saveObservation(ctx, { kind: 'decision', title: 'default lands here', content: 'why/what/how' });
  console.log(JSON.stringify({ module: a.module.name, session: a.sessionId, primary: s.sessionId }));
")"
if echo "$OUT" | grep -q '"module":"cli"'; then
    pass "filed under cli without being asked"
else
    oops "the default is not the primary: $OUT"
fi

echo "[7b] and can be diverted to a companion on request"
OUT="$(brain "
  const { saveObservation } = await import('$B/tools/observations.js');
  const { startSession } = await import('$B/tools/session.js');
  const s = startSession(ctx, { module: 'cli', with_modules: ['server'] });
  const b = saveObservation(ctx, { kind: 'gotcha', title: 'belongs to server', content: 'why/what/how', module: 'server' });
  const sess = db.db.prepare('SELECT module_id, ended_at, next_session FROM sessions WHERE id = ?').get(b.sessionId);
  const newest = db.sessions.findLastClosedByModule(mod('server').id);
  console.log(JSON.stringify({
    filedUnder: b.module.name,
    divertedSession: b.sessionId !== s.sessionId,
    sidecarClosed: sess.ended_at !== null,
    sidecarHasNoHandoff: sess.next_session === null,
    serverNewestHandoff: newest ? newest.id : null,
    hint: b.hint ?? '',
  }));
")"
if echo "$OUT" | grep -q '"filedUnder":"server"'; then
    pass "the note is filed under the companion"
else
    oops "the divert did not work: $OUT"
fi
if echo "$OUT" | grep -q '"sidecarClosed":true'; then
    pass "the sidecar session was closed, not left open"
else
    oops "the divert left a session open — the thing auto-close exists to prevent: $OUT"
fi
if echo "$OUT" | grep -q '"sidecarHasNoHandoff":true' && echo "$OUT" | grep -q '"serverNewestHandoff":null'; then
    pass "and it cannot become that module's 'resume here'"
else
    oops "the sidecar polluted the companion's handoff chain: $OUT"
fi
# The hint arrives inside JSON, so its quotes are escaped — match on the
# words, not on the punctuation.
if echo "$OUT" | grep -qi 'Filed under .*server.*not the session'; then
    pass "the result says where it went, so the user can find it"
else
    oops "no hint explaining the divert: $OUT"
fi

# ── [8] the session itself stays single ─────────────────────────────────
#
# The whole point of primary-plus-companions: opening three modules must not
# open three sessions, each asking to be closed with its own handoff.
echo "[8] opening three modules opens one session"
OUT="$(brain "
  const { startSession } = await import('$B/tools/session.js');
  const before = db.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL').get().n;
  startSession(ctx, { module: 'cli', with_modules: ['server', 'docs'] });
  const after = db.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE ended_at IS NULL').get().n;
  console.log(JSON.stringify({ before, after }));
")"
if echo "$OUT" | grep -q '"after":1'; then
    pass "exactly one session is open afterwards"
else
    oops "opening three modules left more than one open session: $OUT"
fi

echo
if [ "$FAILED" -eq 0 ]; then
    echo "✓ v046-multi-module: all assertions passed"
    exit 0
fi
echo "✗ v046-multi-module: $FAILED assertion(s) failed"
exit 1
