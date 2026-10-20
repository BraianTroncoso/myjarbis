#!/bin/bash
#
# E2E test: close order must not depend on the wall clock going forwards.
#
# `ended_at` is the only key that orders closes — `findLastClosedByModule`
# does `ORDER BY ended_at DESC, id DESC`, and `resume` reads that to decide
# which "resume here" the next session gets. It is written with
# `datetime('now')`, and a wall clock is not monotonic. On the WSL2/Hyper-V
# machine this was found on, CLOCK_REALTIME steps BACKWARD about 0.8s every
# 32s as the guest re-anchors to the host:
#
#   1792508437074 -> 1792508436270   -804ms
#   1792508468768 -> 1792508467967   -801ms
#
# When one of those steps lands between two closes, the close that happened
# LATER carries the EARLIER timestamp. The id tie-break covers timestamps that
# are equal, not inverted. The consequence in production is specific and bad:
# an auto-close stamped a second "after" a curated close outranks it, so the
# next session is handed `[auto] nothing was recorded` instead of the handoff
# a person wrote — the exact burial `curatedResume` exists to undo.
#
# The fix clamps each close to at least one second after the newest close in
# its module. This test asserts the property by moving the clock backwards the
# only way a test can: by putting an existing close in the future and then
# closing another session.
#
# What it pins:
#
#   · a close is never stamped at or before the newest close in its module
#   · with a close sitting in the future, the next close still sorts after it
#   · `resume` therefore returns the curated handoff, not the auto one, under
#     exactly the inversion that used to break it
#   · closes in OTHER modules do not drag a module's clock forward
#
# Exits 0 on success, non-zero on the first failed assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"

if [ ! -f "$B/context.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-closeorder-XXXXXX)"
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
"$MJ" module add cli --description="CLI" >/dev/null
"$MJ" module add web --description="Web" >/dev/null

# One node process per step, so nothing is cached in memory between them.
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

# ── [1] a close never lands at or before the newest close ───────────────
echo "[1] two closes in a row are strictly ordered"
OUT="$(brain "
  const m = mod('cli');
  const a = db.sessions.start(m.id);
  db.sessions.end(a.id, 'first', 'first handoff');
  const b = db.sessions.start(m.id);
  db.sessions.end(b.id, 'second', 'second handoff');
  const rows = db.db.prepare('SELECT id, ended_at FROM sessions WHERE module_id = ? ORDER BY id').all(m.id);
  console.log(JSON.stringify(rows));
")"
if echo "$OUT" | grep -q '\['; then
  FIRST=$(echo "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s.trim());console.log(r[0].ended_at)})")
  SECOND=$(echo "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s.trim());console.log(r[1].ended_at)})")
  if [[ "$SECOND" > "$FIRST" ]]; then
    pass "second close ($SECOND) sorts after the first ($FIRST)"
  else
    oops "two consecutive closes are not ordered: $FIRST then $SECOND"
  fi
else
  oops "could not read the closes back: $OUT"
fi

# ── [2] the inversion itself ────────────────────────────────────────────
#
# A close sitting in the future is what a backward clock step looks like from
# the point of view of the NEXT close: `datetime('now')` returns a value
# earlier than one already stored.
echo "[2] a close already in the future does not outrank the next one"
OUT="$(brain "
  const m = mod('cli');
  // Put the newest close an hour ahead — a 0.8s step is enough in reality,
  // an hour just makes the assertion unambiguous.
  db.db.prepare(\"UPDATE sessions SET ended_at = datetime('now','+1 hour') WHERE id = (SELECT MAX(id) FROM sessions WHERE module_id = ?)\").run(m.id);
  const ahead = db.db.prepare('SELECT MAX(ended_at) AS t FROM sessions WHERE module_id = ?').get(m.id).t;
  const c = db.sessions.start(m.id);
  const closed = db.sessions.end(c.id, 'third', 'third handoff');
  console.log(JSON.stringify({ ahead, now: closed.ended_at, id: c.id }));
")"
AHEAD=$(echo "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s.trim()).ahead)}catch{console.log('')}})")
NOW=$(echo "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s.trim()).now)}catch{console.log('')}})")
if [ -z "$NOW" ]; then
  oops "the close did not happen: $OUT"
elif [[ "$NOW" > "$AHEAD" ]]; then
  pass "clamped past the future close ($AHEAD → $NOW)"
else
  oops "the new close ($NOW) did not sort after the one in the future ($AHEAD) — the inversion survives"
fi

# ── [3] what the inversion actually cost: the wrong handoff ─────────────
echo "[3] resume returns the curated handoff under the inversion"
OUT="$(brain "
  const m = mod('web');
  // A curated close, then an [auto] one in the future — the shape that used
  // to bury a hand-written handoff.
  const curated = db.sessions.start(m.id);
  db.sessions.end(curated.id, 'real work', 'CURATED: do the thing');
  db.db.prepare(\"UPDATE sessions SET ended_at = datetime('now','+1 hour') WHERE id = ?\").run(curated.id);
  const auto = db.sessions.start(m.id);
  db.sessions.end(auto.id, '[auto] nothing was recorded', '[auto] no resume point');
  const newest = db.sessions.findLastClosedByModule(m.id);
  console.log(JSON.stringify({ newest: newest.next_session, curatedId: curated.id, autoId: auto.id, newestId: newest.id }));
")"
if echo "$OUT" | grep -q '\[auto\] no resume point'; then
  pass "the later [auto] close is the newest, as it should be"
else
  oops "the newest close is not the one that closed last: $OUT"
fi
# And the reverse order: the curated one closed last, so it must win even
# though its id is lower than an auto-close that preceded it.
OUT="$(brain "
  const m = mod('web');
  const auto2 = db.sessions.start(m.id);
  db.sessions.end(auto2.id, '[auto] x', '[auto] stale');
  db.db.prepare(\"UPDATE sessions SET ended_at = datetime('now','+2 hours') WHERE id = ?\").run(auto2.id);
  const curated2 = db.sessions.start(m.id);
  db.sessions.end(curated2.id, 'real', 'CURATED LAST: resume here');
  const newest = db.sessions.findLastClosedByModule(m.id);
  console.log(JSON.stringify({ ns: newest.next_session }));
")"
if echo "$OUT" | grep -q 'CURATED LAST'; then
  pass "a curated close made after a future-stamped auto one still wins"
else
  oops "the curated handoff was buried by an auto-close stamped in the future: $OUT"
fi

# ── [4] the clamp is per module ─────────────────────────────────────────
#
# Clamping against every close in the project would let one module's clock
# skew drag an unrelated module's timestamps hours into the future.
# `api` is a module with no history of its own: `cli` and `web` have both had
# closes pushed into the future by the sections above, and the clamp carries
# that forward by design — so measuring drift on either of them would measure
# the earlier fixture rather than cross-module leakage.
echo "[4] another module's future close does not drag this one forward"
"$MJ" module add api --description="API" >/dev/null
OUT="$(brain "
  const web = mod('web');
  const api = mod('api');
  db.db.prepare(\"UPDATE sessions SET ended_at = datetime('now','+10 hours') WHERE module_id = ?\").run(web.id);
  const s = db.sessions.start(api.id);
  const closed = db.sessions.end(s.id, 'x', 'y');
  const drift = db.db.prepare(\"SELECT CAST((julianday(?) - julianday(datetime('now'))) * 24 AS INT) AS hours\").get(closed.ended_at).hours;
  console.log(JSON.stringify({ ended: closed.ended_at, driftHours: drift }));
")"
DRIFT=$(echo "$OUT" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s.trim()).driftHours)}catch{console.log('999')}})")
if [ "$DRIFT" -lt 1 ] 2>/dev/null; then
  pass "the api close stayed at wall-clock time (drift ${DRIFT}h)"
else
  oops "a close in another module pushed this one ${DRIFT}h into the future: $OUT"
fi

echo
if [ "$FAILED" -eq 0 ]; then
    echo "✓ v045-close-ordering: all assertions passed"
    exit 0
fi
echo "✗ v045-close-ordering: $FAILED assertion(s) failed"
exit 1
