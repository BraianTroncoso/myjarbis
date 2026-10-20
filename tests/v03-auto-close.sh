#!/bin/bash
#
# E2E test: sessions close themselves.
#
# `sessions.summary` was NULL on 2 of 2 sessions in one real project and 2
# of 10 in another, and this repository's own brain has five modules with
# three sessions, none closed. The cost is not a missing paragraph: `resume`
# returns nothing and `list_modules` reports hasNextSession=false and
# lastSessionEndedAt=null for every module, which is the signal used both to
# pick up where you left off AND to choose which module to open.
#
# The old mitigation was a Stop hook printing a reminder for the agent. This
# tests the replacement, which does not depend on the agent remembering:
#
#   1. a session with work gets closed on SessionEnd, with a summary built
#      from its observations and the commits made during it
#   2. project_state, when set, becomes the resume point — it is the one
#      field written deliberately to say where things stand
#   3. when NO hook fires at all (killed terminal, crash, reboot) the next
#      start_session closes it retroactively, so the guarantee does not
#      depend on a clean exit
#   4. a session the agent closed properly is NEVER overwritten, including
#      when an auto-close lands in the same second — `ended_at` has
#      one-second granularity, so that tie is ordinary rather than rare
#   5. generated text is labelled, and the agent is told it is generated
#   6. the opt-out is honoured
#   7. a curated handoff with auto-closes stacked ON TOP of it is still
#      reachable. Automatic closing is always the newest close, so it wins
#      every "last closed session" lookup and pushes the real handoff one
#      level down per occurrence. Seen in a real module: a 3538-char handoff,
#      then two sessions left open on later days, auto-closed with 292 and
#      124 chars of synthetic text. The agent read the emptiest of the three
#      and told the user there was no resume point.
#
# Exits 0 on success, non-zero on the first failed assertion.
#
# ─────────────────────────────────────────────────────────────────────
# Why this file pins its own timestamps instead of letting the clock do it
#
# Every "which close is the newest" question in MyJarbis is answered by
# comparing `sessions.ended_at`, which SQLite writes with `datetime('now')`
# — the host's CLOCK_REALTIME, truncated to the second. The suite drives a
# dozen short-lived node processes, so that clock is the only thing ordering
# them, and it assumes the clock only ever moves forward.
#
# It does not. On the WSL2 machine this is developed on, CLOCK_REALTIME steps
# BACKWARD by ~0.8s roughly every 32 seconds (Hyper-V guest time sync
# re-anchoring to the host), measured directly:
#
#     BACKWARD STEP 1792508437074 -> 1792508436270  -804ms
#     BACKWARD STEP 1792508468768 -> 1792508467967  -801ms
#     BACKWARD STEP 1792508500452 -> 1792508499701  -751ms
#
# When one of those steps lands between two closes that are less than a
# second apart, the one that happened LATER gets the EARLIER `ended_at`, and
# `findLastClosedByModule` correctly returns the wrong session. Reproduced on
# iteration 22 of 150: the final section's curated close was stamped 14:58:29
# while an auto-close that preceded it was stamped 14:58:30, and both of its
# assertions failed. That is the flake — not a timezone. SQLite's
# `datetime('now')` is UTC and so is every parse of it in autoClose.ts /
# session.ts; the suite was run under TZ=UTC, UTC+14, UTC-11, UTC+05:30 and
# Argentina, and with a faked clock crossing local AND UTC midnight at 20
# phase offsets, and passes in all of them.
#
# So the arrangement each section needs is now written into the fixture
# explicitly — back-dated by days where the story is "on an earlier day",
# pinned to an exact tie where the story is "in the same second" — rather
# than being whatever the clock happened to produce. No assertion was
# relaxed; the inputs stopped being accidental.
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$B/cli.js"

if [ ! -f "$B/tools/autoClose.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-autoclose-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
# Hermetic HOME: `myjarbis init` runs twice below, and each run registers the
# project in $HOME/.claude.json and writes $HOME/.claude/projects/<slug>/.
# Unisolated, every run left two dead entries in the developer's real home.
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/home"
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


mkdir -p "$WORK/proj"
cd "$WORK/proj"
git init -q .
git config user.email t@example.com
git config user.name Test
"$MJ" init --yes --skip-memory >/dev/null 2>&1
echo seed > a.txt && git add -A && git commit -qm "chore: seed the repo"

# ─── 1. work happens, the agent never closes ───
echo "→ [1] a session with work, left open, closed by the hook"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
import { saveObservation } from '$B/tools/observations.js';
const ctx = ServerContext.initialize();
startSession(ctx, { module: '_general' });
saveObservation(ctx, { kind:'decision', title:'Use a materialised view for the nightly rollup', content:'WHY: the join timed out past a million rows.' });
saveObservation(ctx, { kind:'gotcha',   title:'The nightly job runs in UTC, not local time', content:'WHY: off-by-one at month boundaries.' });
saveObservation(ctx, { kind:'progress', title:'Closed API-12: rollup endpoint shipped', content:'Behind a flag.' });
ctx.close();
"

# The commit the summary is supposed to report has to land AFTER the session
# opened, because `commitsSince` asks git for `--since <session start> UTC`.
# This used to be committed before the session, and passed only when the
# commit and the session start happened to fall inside the same second —
# `--since` is inclusive at one-second granularity. It was a coin flip that
# the suite could not report either way, because the assertion ran inside a
# pipe.
#
# Committing "now" and hoping is still a coin flip, just a thinner one: the
# clock can step backward between the INSERT that stamped started_at and this
# commit (see the note at the top), and then the commit sits BEFORE the
# session it belongs to and drops out of `--since`. So derive the commit date
# from the timestamp that was actually stored, in UTC, a minute later. Same
# property under test — the commit falls inside the session's window — stated
# instead of hoped for, and handed to git with an explicit +0000 so there is
# no local/UTC question on the git side either.
SESSION_STARTED_AT=$(node --input-type=module -e "
import { ServerContext } from '$B/context.js';
const ctx = ServerContext.initialize();
const open = ctx.db.sessions.listOpenByProject(ctx.requireProject().id);
console.log(open[open.length - 1].started_at);
ctx.close();
")
COMMIT_DATE=$(node -e "
const d = new Date(process.argv[1].replace(' ', 'T') + 'Z');
d.setUTCSeconds(d.getUTCSeconds() + 60);
console.log(d.toISOString().slice(0, 19).replace('T', ' ') + ' +0000');
" "$SESSION_STARTED_AT")
echo rollup > b.txt && git add b.txt
GIT_AUTHOR_DATE="$COMMIT_DATE" GIT_COMMITTER_DATE="$COMMIT_DATE" \
  git commit -qm "feat(api): add the rollup endpoint"

# Before: this is the state the project has been living in.
BEFORE=$(node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { resume } from '$B/tools/session.js';
const ctx = ServerContext.initialize();
console.log(JSON.stringify(resume(ctx, { module: '_general' }).hasNextSession));
ctx.close();
")
[ "$BEFORE" = "false" ] \
  && pass "before the hook, resume has nothing to return" \
  || oops "expected hasNextSession=false before closing, got $BEFORE"

node "$CLI" hook session-end >/dev/null 2>&1

node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { resume } from '$B/tools/session.js';
import { listModules } from '$B/tools/discovery.js';
const ctx = ServerContext.initialize();
const r = resume(ctx, { module: '_general' });
const m = listModules(ctx, {}).modules.find((x) => x.name === '_general');
const out = [];
const t = (c, msg) => out.push((c ? 'PASS|' : 'FAIL|') + msg);

t(r.hasNextSession === true, 'resume now returns a next_session');
t(m.lastSessionEndedAt !== null, 'list_modules reports lastSessionEndedAt');
t(m.hasNextSession === true, 'list_modules reports hasNextSession — the module-picking signal');
t(r.summary.startsWith('[auto]'), 'the summary is labelled [auto]');
t(/1 decision, 1 gotcha, 1 progress/.test(r.summary), 'the summary counts what was saved, by kind');
t(/rollup endpoint/.test(r.summary), 'the summary names the observations');
t(/feat\(api\): add the rollup endpoint/.test(r.summary), 'the summary includes commits made during the session');
console.log(out.join('\n'));
ctx.close();
" > "$ASSERTS"
read_asserts

# ─── 2. project_state becomes the resume point ───
echo "→ [2] with project_state set, that becomes the resume point"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
import { setProjectState } from '$B/tools/state.js';
const ctx = ServerContext.initialize();
startSession(ctx, { module: '_general' });
setProjectState(ctx, { content: 'On release/2.1. Rollup is hourly behind ROLLUP_V2. NEXT: enable the flag in staging.' });
ctx.close();
"
node "$CLI" hook session-end >/dev/null 2>&1
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { resume } from '$B/tools/session.js';
const ctx = ServerContext.initialize();
const m = ctx.db.modules
  .listByProject(ctx.requireProject().id)
  .find((x) => x.name === '_general');
// Pin \"the close that just happened is the newest one\" instead of assuming
// it. ended_at comes from a clock that steps backward (see the note at the
// top), so section [1]'s close can outrank this one, and then both
// assertions below fail for a reason that has nothing to do with
// project_state. Ids are monotonic; the clock is not — so age every close
// below the newest id by a day, which is also the shape of the real case.
ctx.db.db.prepare(
  \"UPDATE sessions SET ended_at = datetime(ended_at, '-1 day') \" +
  'WHERE module_id = ? AND ended_at IS NOT NULL AND id < ' +
  '(SELECT MAX(id) FROM sessions WHERE module_id = ? AND ended_at IS NOT NULL)'
).run(m.id, m.id);
const r = resume(ctx, { module: '_general' });
const out = [];
const t = (c, msg) => out.push((c ? 'PASS|' : 'FAIL|') + msg);
t(/ROLLUP_V2/.test(r.nextSession), 'the living state is used verbatim as the resume point');
t(/set deliberately/.test(r.nextSession), 'and is marked as the trustworthy source');
console.log(out.join('\n'));
ctx.close();
" > "$ASSERTS"
read_asserts

# ─── 3. no hook fires at all ───
echo "→ [3] no hook fires (killed terminal): the next start_session closes it"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
import { saveObservation } from '$B/tools/observations.js';
const ctx = ServerContext.initialize();
startSession(ctx, { module: '_general' });
saveObservation(ctx, { kind:'error', title:'Flag rollout stuck on a config cache', content:'WHY: cached 5 minutes.' });
ctx.close(); // process dies here; no hook runs
"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
const ctx = ServerContext.initialize();
const s = startSession(ctx, { module: '_general' });
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
t(s.autoClosedPrevious !== undefined, 'start_session reports it closed a stale session');
t(s.autoClosedPrevious?.observations === 1, 'and counted its observations');
t(/MACHINE-WRITTEN/.test(s.hint ?? ''), 'the hint warns the agent the resume point is generated');
t(/auto-closed/.test(s.hint ?? ''), 'and tells it to say so to the user');
const p = ctx.requireProject();
t(ctx.db.sessions.listOpenByProject(p.id).length === 1,
  'exactly one session open afterwards: the new one');
console.log(out.join('\n'));
ctx.close();
" > "$ASSERTS"
read_asserts

# ─── 4. a curated close is never overwritten, even on a same-second tie ───
echo "→ [4] a curated close wins, including against a same-second auto-close"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession, endSession, resume } from '$B/tools/session.js';
import { saveObservation } from '$B/tools/observations.js';
const ctx = ServerContext.initialize();
// Leave one session open so the NEXT start_session auto-closes it in the
// same second that the curated session is created and closed. ended_at is
// only second-granular, so without an id tie-break resume could return
// either of the two — and it returned the wrong one before the fix.
startSession(ctx, { module: '_general' });
saveObservation(ctx, { kind:'discovery', title:'dangling session marker', content:'x' });
const opened = startSession(ctx, { module: '_general' });
const closed = endSession(ctx, { summary: 'Shipped the hourly rollup and verified it in staging.',
                  next_session: 'Ask for sign-off on API-12, then enable ROLLUP_V2 in prod.' });
const autoId = opened.autoClosedPrevious.sessionId;
// Two fixture facts, written down rather than left to the clock:
//
//   · sections [1]-[3] closed sessions in this module seconds ago, and the
//     clock steps backward (see the note at the top), so one of them can be
//     stamped AFTER this close. Age everything below the newest id by a day.
//   · the tie this section is named after is then restored exactly, by
//     copying the curated close's ended_at onto the auto-close. It used to
//     be a tie only when the two happened to fall inside one second, i.e.
//     usually — so the id tie-break was usually, not always, under test.
ctx.db.db.prepare(
  \"UPDATE sessions SET ended_at = datetime(ended_at, '-1 day') \" +
  'WHERE module_id = ? AND ended_at IS NOT NULL AND id < ' +
  '(SELECT MAX(id) FROM sessions WHERE module_id = ? AND ended_at IS NOT NULL)'
).run(opened.module.id, opened.module.id);
ctx.db.db
  .prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
  .run(closed.endedAt, autoId);
const r = resume(ctx, { module: '_general' });
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
t(ctx.db.sessions.findById(autoId).ended_at === closed.endedAt,
  'fixture: the auto-close and the curated close really do share one ended_at');
t(!r.summary.startsWith('[auto]'), 'resume returns the CURATED summary, not the auto one');
t(/verified it in staging/.test(r.summary), 'and it is the right curated summary');
t(/sign-off on API-12/.test(r.nextSession), 'with the curated next_session');
console.log(out.join('\n'));
ctx.close();
" > "$ASSERTS"
read_asserts

# A properly closed session leaves the hook nothing to do.
OUT=$(node "$CLI" hook session-end 2>&1)
echo "$OUT" | grep -q "no open session to close" \
  && pass "with nothing open, the hook is a no-op" \
  || oops "the hook did something unexpected: $(echo "$OUT" | head -1)"

# ─── 5. opt-out ───
echo "→ [5] settings.session.auto_close_on_exit = false is honoured"
node -e "
const fs = require('fs'), p = '.myjarbis/config/settings.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
s.session = { ...(s.session || {}), auto_close_on_exit: false };
fs.writeFileSync(p, JSON.stringify(s, null, 2));
"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession } from '$B/tools/session.js';
const ctx = ServerContext.initialize();
startSession(ctx, { module: '_general' });
ctx.close();
"
node "$CLI" hook session-end >/dev/null 2>&1
REMAIN=$(node --input-type=module -e "
import { ServerContext } from '$B/context.js';
const ctx = ServerContext.initialize();
console.log(ctx.db.sessions.listOpenByProject(ctx.requireProject().id).length);
ctx.close();
")
[ "$REMAIN" = "1" ] \
  && pass "the session stays open when the setting is off" \
  || oops "expected the session to stay open, $REMAIN remained"

# ─── 6. the hook is wired into the plugin ───
echo "→ [6] SessionEnd is registered, and is not Stop"
node -e "
const d = require('$WORK/proj/.claude-plugin/hooks/hooks.json');
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
t(Array.isArray(d.hooks.SessionEnd), 'hooks.json registers SessionEnd');
t(/session-end\.sh/.test(JSON.stringify(d.hooks.SessionEnd)), 'pointing at session-end.sh');
t(!/session-end\.sh/.test(JSON.stringify(d.hooks.Stop)),
  'and Stop does NOT close sessions — it fires every turn');
console.log(out.join('\n'));
" > "$ASSERTS"
read_asserts
[ -x "$WORK/proj/.claude-plugin/scripts/session-end.sh" ] \
  && pass "session-end.sh is executable in the provisioned project" \
  || oops "session-end.sh missing or not executable"

# ─── 7. a curated handoff is reachable under a stack of auto-closes ───
#
# A fresh project, because this exercises the fallback branches of
# composeNextSession: proj has project_state set by [2], and that branch
# deliberately carries no pointer (a living state set on purpose is more
# current than an older handoff).
echo "→ [7] two auto-closes on top of a curated handoff, which is still reachable"
mkdir -p "$WORK/proj2"
cd "$WORK/proj2"
git init -q .
git config user.email t@example.com
git config user.name Test
"$MJ" init --yes --skip-memory >/dev/null 2>&1

# The curated handoff.
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession, endSession } from '$B/tools/session.js';
import { saveObservation } from '$B/tools/observations.js';
const ctx = ServerContext.initialize();
startSession(ctx, { module: '_general' });
saveObservation(ctx, { kind:'progress', title:'Closed BILL-7: invoice export', content:'Behind a flag.' });
endSession(ctx, { summary: 'Shipped the invoice export and verified the CSV byte-for-byte.',
                  next_session: 'CURATED HANDOFF: get sign-off on BILL-7, then turn on EXPORT_V2 for the pilot tenant.' });
ctx.close();
"
# Two sessions left open on later days, each closed by the hook. This is the
# shape that buried the real handoff: every auto-close is the newest close.
for n in 1 2; do
  node --input-type=module -e "
  import { ServerContext } from '$B/context.js';
  import { startSession } from '$B/tools/session.js';
  import { saveObservation } from '$B/tools/observations.js';
  const ctx = ServerContext.initialize();
  startSession(ctx, { module: '_general' });
  saveObservation(ctx, { kind:'progress', title:'poked at the exporter, nothing written up', content:'x' });
  ctx.close();
  "
  node "$CLI" hook session-end >/dev/null 2>&1
done

# Age the curated close by 20 days. Without this the whole chain is same-day
# and the staleness assertion below could not tell the two clocks apart —
# which is the second half of the bug: an auto-close that ran today sets
# previousSession.daysSinceClose to 0 for a handoff that is weeks old.
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
const ctx = ServerContext.initialize();
const p = ctx.requireProject();
const m = ctx.db.modules.listByProject(p.id).find((x) => x.name === '_general');
const curated = ctx.db.sessions.findLastCuratedByModule(m.id);
ctx.db.db.prepare(\"UPDATE sessions SET ended_at = datetime('now','-20 days') WHERE id = ?\").run(curated.id);
ctx.close();
"

node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession, resume } from '$B/tools/session.js';
const ctx = ServerContext.initialize();
const r = resume(ctx, { module: '_general' });
const s = startSession(ctx, { module: '_general' });
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);

t(s.previousSession.nextSession.startsWith('[auto]'),
  'previousSession is the machine-written close, as before');
t(s.curatedResume !== undefined, 'start_session surfaces curatedResume');
t(/CURATED HANDOFF/.test(s.curatedResume?.nextSession ?? ''),
  'and it is the handoff a human wrote');
t(s.curatedResume?.buriedUnder === 2, 'reporting it was buried under 2 automatic closes');
t(/verified the CSV/.test(s.curatedResume?.summary ?? ''),
  'with the curated summary alongside it');
t(/curatedResume/.test(s.hint ?? ''), 'the hint points the agent at curatedResume');
t(s.curatedResume?.stale === true,
  'the curated handoff is stale on ITS OWN clock (20 days)');
t(s.previousSession.stale === false,
  'while previousSession is not — the automatic close reset that clock');
t(/session #/.test(s.previousSession.nextSession),
  'the synthetic text itself points back at the curated session');
t(r.curatedResume !== undefined, 'resume surfaces it too');
t(/CURATED HANDOFF/.test(r.curatedResume?.nextSession ?? ''), 'and the same text');
console.log(out.join('\n'));
ctx.close();
" > "$ASSERTS"
read_asserts

# The hook output is what the USER reads, and it was showing the empty one.
HOOKOUT=$(node "$CLI" hook session-start 2>/dev/null)
echo "$HOOKOUT" | grep -q "CURATED HANDOFF" \
  && pass "the SessionStart hook prints the curated handoff, not the synthetic one" \
  || oops "the hook still shows the machine-written resume point"
echo "$HOOKOUT" | grep -qi "automátic\|automatic\|automát" \
  && pass "and says the newest close was automatic" \
  || oops "the hook does not explain why an older note is being shown"

# Burial is ordered by ended_at, NOT by id.
#
# A session started long ago and auto-closed today has a LOW id and a RECENT
# ended_at, so it buries a handoff whose id is higher than its own. Counting
# by id reported "buried under 0" for handoffs that were plainly buried —
# which is what showed up after closing 54 abandoned sessions across 12
# projects.
#
# Built here in the order that produces it, with no id surgery: open the
# abandoned session FIRST so it takes the lower id, write the curated handoff
# SECOND, and only then let the hook close the abandoned one. Its ended_at
# lands after the handoff's while its id stays before it.
echo "→ [8] burial is counted by ended_at, not by id"
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession, endSession } from '$B/tools/session.js';
const ctx = ServerContext.initialize();
const p = ctx.requireProject();
const m = ctx.db.modules.create(p.id, 'abandoned-first');
const stale = ctx.db.sessions.start(m.id);           // lower id, stays open
ctx.db.db
  .prepare(\"UPDATE sessions SET started_at = datetime('now','-90 days') WHERE id = ?\")
  .run(stale.id);
const later = ctx.db.sessions.start(m.id);           // higher id
ctx.setActiveSession(later.id, m.id);
endSession(ctx, { summary: 'Wrote this one up.', next_session: 'CURATED UNDER A LOW ID: finish the exporter.' });
// Back-date the curated close by a day. Everything in a test happens inside
// one second, and ended_at is only second-granular, so without this the
// handoff and the auto-close tie and the id tie-break picks the handoff —
// hiding the very arrangement under test. In the real case the handoff was
// written days before the abandoned session got closed.
ctx.db.db
  .prepare(\"UPDATE sessions SET ended_at = datetime('now','-1 day') WHERE id = ?\")
  .run(later.id);
ctx.close();
"
node "$CLI" hook session-end >/dev/null 2>&1
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { resume } from '$B/tools/session.js';
const ctx = ServerContext.initialize();
const r = resume(ctx, { module: 'abandoned-first' });
const c = r.curatedResume;
const out = [];
const t = (x, m) => out.push((x ? 'PASS|' : 'FAIL|') + m);
t(r.nextSession.startsWith('[auto]'),
  'the abandoned session, auto-closed today, is the newest close');
t(/CURATED UNDER A LOW ID/.test(c?.nextSession ?? ''),
  'the curated handoff is still found, even with a higher id than its burier');
t((c?.buriedUnder ?? 0) === 1,
  'buriedUnder is 1 — counted by ended_at; by id it would have read 0');
console.log(out.join('\n'));
ctx.close();
" > "$ASSERTS"
read_asserts

# A curated close on top of auto-closes goes back to the normal path.
node --input-type=module -e "
import { ServerContext } from '$B/context.js';
import { startSession, endSession, resume } from '$B/tools/session.js';
const ctx = ServerContext.initialize();
const opened = startSession(ctx, { module: '_general' });
const closed = endSession(ctx, { summary: 'Wrote it up properly this time.', next_session: 'NEWEST CURATED: enable EXPORT_V2 everywhere.' });
// This is the block that caught the clock. The two auto-closes above were
// written by other processes a second or so ago; when CLOCK_REALTIME steps
// backward in between (see the note at the top) THIS close is stamped
// EARLIER than them, resume returns an [auto] note, and both assertions
// below fail — observed with the curated close at 14:58:29 and an auto-close
// that preceded it at 14:58:30. So age every earlier close by a day, which
// is both deterministic and the honest shape of the case: the sessions were
// auto-closed on previous days, the agent wrote this one up today.
ctx.db.db.prepare(
  \"UPDATE sessions SET ended_at = datetime(ended_at, '-1 day') \" +
  'WHERE module_id = ? AND ended_at IS NOT NULL AND id < ' +
  '(SELECT MAX(id) FROM sessions WHERE module_id = ? AND ended_at IS NOT NULL)'
).run(opened.module.id, opened.module.id);
const r = resume(ctx, { module: '_general' });
const out = [];
const t = (c, m) => out.push((c ? 'PASS|' : 'FAIL|') + m);
t(ctx.db.sessions.findLastClosedByModule(opened.module.id).id === closed.sessionId,
  'fixture: the curated close really is the newest close in the module');
t(/NEWEST CURATED/.test(r.nextSession), 'resume returns the newest curated handoff');
t(r.curatedResume === undefined,
  'and curatedResume is absent — nothing is buried, so nothing is duplicated');
console.log(out.join('\n'));
ctx.close();
" > "$ASSERTS"
read_asserts

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
echo "✓ v03-auto-close E2E PASSED"
