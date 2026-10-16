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
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$(dirname "$HERE")/global}"

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
)

PASS=0; FAIL=0; FAILED_NAMES=()
for t in "${SUITES[@]}"; do
  printf "%-24s " "$t"
  if out=$(bash "$HERE/$t.sh" 2>&1); then
    echo "PASS  ($(echo "$out" | grep -c '✓') checks)"
    PASS=$((PASS + 1))
  else
    echo "FAIL"
    echo "$out" | tail -15 | sed 's/^/      /'
    FAIL=$((FAIL + 1)); FAILED_NAMES+=("$t")
  fi
done

echo
echo "suites: $PASS passed, $FAIL failed"
[ "$FAIL" -gt 0 ] && echo "failed: ${FAILED_NAMES[*]}"

if [ "${1:-}" = "--bench" ]; then
  echo
  bash "$HERE/v03-benchmark.sh"
fi

exit $((FAIL > 0 ? 1 : 0))
