#!/bin/bash
#
# Run every E2E suite and report a one-line summary per suite.
#
# Each suite is self-contained: it generates its own fixture, uses its own
# temp directory, and (for the v0.3 ones) its own registry, so they can run
# in any order on any checkout.
#
# Usage: tests/run-all.sh [--bench]

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO/global}"

# ─── refuse to run against a shadowed bin/ ────────────────────────
#
# MYJARBIS_INSTALL_DIR defaults to the checkout's global/, and bin/myjarbis
# resolves subcommands by preferring $INSTALL_DIR/bin before falling back to
# $INSTALL_DIR/../bin. global/bin/ is not in the repository, so normally the
# fallback wins and the suites exercise bin/ — the code being edited.
#
# But `myjarbis update` copies the checkout's bin/ into its install dir, and
# a dev run with MYJARBIS_INSTALL_DIR pointed at this global/ leaves a real
# global/bin/ behind. From then on every suite silently tests that snapshot
# instead of bin/, and keeps passing while the source is broken. There is no
# symptom: the output is identical.
#
# Fatal rather than a warning, and fatal rather than deleting it: the
# directory is someone's state, and a green suite that proved nothing is
# worse than no suite.
if [ -d "$REPO/global/bin" ]; then
  echo "✗ $REPO/global/bin exists and shadows $REPO/bin" >&2
  echo "  bin/myjarbis prefers \$MYJARBIS_INSTALL_DIR/bin, so every suite would" >&2
  echo "  test that copy instead of the checkout, and pass regardless." >&2
  echo "  It is a leftover from running \`myjarbis update\` with" >&2
  echo "  MYJARBIS_INSTALL_DIR=$REPO/global. Remove it and re-run:" >&2
  echo "      rm -rf $REPO/global/bin $REPO/global/.source" >&2
  exit 1
fi

SUITES=(
  bootstrap-import
  full-session-cycle
  skills-lifecycle
  compact-cycle
  dx-batch-1
  v03-isolation
  v03-shared-resolution
  v03-migrate-merge
  v03-org-pack
  v03-auto-close
  v03-maintenance
  v04-review-reseed
  v04-commands-sync
  v04-close-ritual
  v04-chat-triggers
  v04-hook-wiring
  v045-session-ownership
  v045-unwired-detection
  v045-update-self-overwrite
  v045-sessionend-ownership
  v045-close-ordering
  v045-commands-history
  v045-update-observation-files
)

# ─── what to print when a suite fails ─────────────────────────────
#
# This used to be `tail -15`, selecting by POSITION. Position is the one
# thing that does not correlate with a failure: an assertion that fails in
# section [1] of a suite that goes on to pass sections [2]..[8] scrolls out
# of the window, and the suite's own epilogue ("✗ 3 assertion(s) failed")
# arrives with the count but not the names. That is how three real failures
# in v03-auto-close were seen but never identified.
#
# So select by MARKER instead. Every suite prints "✗ <what failed>" per
# failed assertion and announces its sections as "[n] ..." or "→ [n] ...",
# which is enough to reconstruct what broke: each ✗ line, under the section
# header it belongs to, wherever in the output it happens to be.
#
# The tail stays as well, because a suite can fail with no ✗ at all — a
# crash under `set -e`, a missing build, a non-zero exit from the epilogue —
# and then the last lines are the only evidence there is.
#
# And the whole output is written to a file, because a cap on how much is
# printed should never be a cap on what was recorded.
FAIL_LOGS=""
report_failure() {
  local name="$1" out="$2" marks
  marks=$(printf '%s\n' "$out" | grep -c '✗')

  if [ "${marks:-0}" -gt 0 ]; then
    printf '%s\n' "$out" | awk '
      /^[[:space:]]*(→[[:space:]]*)?\[/ { section = $0; next }
      /✗/ {
        if (section != "" && section != shown) { print section; shown = section }
        sub(/^[[:space:]]+/, "")
        print "  " $0
        if (++n >= 40) { print "  … and more; see the full log below"; exit }
      }' | sed 's/^/      /'
  else
    echo "      (no ✗ line in the output — the suite exited non-zero without" \
         "reaching an assertion)"
  fi

  echo "      ── last 15 lines ──"
  printf '%s\n' "$out" | tail -15 | sed 's/^/      /'

  [ -n "$FAIL_LOGS" ] || FAIL_LOGS="$(mktemp -d -t myjarbis-run-all-logs-XXXXXX)"
  printf '%s\n' "$out" > "$FAIL_LOGS/$name.log"
  echo "      full output: $FAIL_LOGS/$name.log"
}

PASS=0; FAIL=0; FAILED_NAMES=()
for t in "${SUITES[@]}"; do
  printf "%-24s " "$t"
  if out=$(bash "$HERE/$t.sh" 2>&1); then
    echo "PASS  ($(echo "$out" | grep -c '✓') checks)"
    PASS=$((PASS + 1))
  else
    echo "FAIL"
    report_failure "$t" "$out"
    FAIL=$((FAIL + 1)); FAILED_NAMES+=("$t")
  fi
done

echo
echo "suites: $PASS passed, $FAIL failed"
[ "$FAIL" -gt 0 ] && echo "failed: ${FAILED_NAMES[*]}"
[ -n "$FAIL_LOGS" ] && echo "full output of each failing suite: $FAIL_LOGS/"

if [ "${1:-}" = "--bench" ]; then
  echo
  bash "$HERE/v03-benchmark.sh"
fi

exit $((FAIL > 0 ? 1 : 0))
