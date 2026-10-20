#!/bin/bash
#
# E2E test: `update` must not break the scripts it is replacing.
#
# `cp` over an existing file rewrites it IN PLACE — same inode, new bytes — and
# bash reads a script incrementally, by byte offset, rather than loading it
# whole. So when step 3 copied $SOURCE/bin over $INSTALL_DIR/bin, the running
# $INSTALL_DIR/bin/myjarbis-update read the NEW bytes at its OLD offset and
# resumed mid-token: `line 196: f: command not found`, from a line where
# nothing was wrong. Steps 4 (rebuild) and 5 (report) never ran.
#
# The fix is a property of the WRITER: replace by rename, so the old inode
# stays alive for whoever still has it open. This test pins that property
# rather than any particular trick for surviving it, because the point is that
# a script added to bin/ tomorrow is covered without doing anything.
#
# What it pins:
#
#   · the hazard is real and still reproduces — an in-place copy over a
#     running script kills it (without this, [2] would prove nothing)
#   · replacing by rename does not: the same running script completes
#   · the real bin/myjarbis-update replaces every file in $INSTALL_DIR/bin by
#     rename, verified by inode, against a sandbox install dir
#   · end to end: a script parked mid-file while the real update replaces it
#     runs to completion
#   · running the update twice is a repair, not a pile-up: it leaves no
#     staging files behind and sweeps any left by a run that died
#
# Exits 0 on success, non-zero on the first failed assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPDATE="$REPO_ROOT/bin/myjarbis-update"

WORK="$(mktemp -d -t myjarbis-selfoverwrite-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

inode() { node -e "console.log(require('fs').statSync(process.argv[1]).ino)" "$1"; }

# A script long enough that bash cannot have buffered all of it, parked on a
# flag file so the replacement provably lands while it is mid-file. The padding
# is what puts the read offset nowhere near a statement boundary — a short
# script is read in a single gulp and is immune, which is why the five-line
# hook scripts never showed this.
make_victim() {
    local path="$1" i
    {
        echo '#!/bin/bash'
        echo 'echo STARTED > "$VICTIM_READY"'
        echo 'while [ ! -f "$VICTIM_GO" ]; do sleep 0.05; done'
        for i in $(seq 1 400); do
            echo ": \"padding line $i so the read offset is nowhere near a statement boundary\""
        done
        echo 'echo REACHED_THE_END >> "$VICTIM_READY"'
    } > "$path"
    chmod +x "$path"
}

# Park a victim mid-file, replace it the given way, then let it finish.
# Returns whatever the victim managed to print.
run_victim_through() {
    local victim="$1" replace_how="$2" ready="$WORK/ready.$$" go="$WORK/go.$$"
    rm -f "$ready" "$go"
    VICTIM_READY="$ready" VICTIM_GO="$go" bash "$victim" >/dev/null 2>&1 &
    local pid=$!
    local waited=0
    while [ ! -f "$ready" ] && [ "$waited" -lt 100 ]; do sleep 0.05; waited=$((waited+1)); done

    # The replacement happens here, with the victim demonstrably parked.
    printf '#!/bin/bash\necho CLOBBERED\n' > "$WORK/replacement"
    case "$replace_how" in
        in-place) cp "$WORK/replacement" "$victim" ;;
        by-rename) cp "$WORK/replacement" "$victim.incoming"; mv -f "$victim.incoming" "$victim" ;;
    esac

    touch "$go"
    wait "$pid" 2>/dev/null
    cat "$ready" 2>/dev/null
}

# ── [1] the hazard is real ──────────────────────────────────────────────
echo "[1] an in-place copy kills the script that is running"
make_victim "$WORK/victim-a"
OUT="$(run_victim_through "$WORK/victim-a" in-place)"
if echo "$OUT" | grep -q STARTED; then
    pass "the victim did start, so the fixture itself works"
else
    oops "the victim never started — fixture is broken, nothing below is meaningful"
fi
if echo "$OUT" | grep -q REACHED_THE_END; then
    oops "the in-place copy no longer kills the running script: the fixture stopped reproducing the hazard, so [2] proves nothing"
else
    pass "it never reached the end (died exactly as the real update did)"
fi

# ── [2] replacing by rename does not ────────────────────────────────────
echo "[2] replacing by rename leaves the running script alone"
make_victim "$WORK/victim-b"
OUT="$(run_victim_through "$WORK/victim-b" by-rename)"
if echo "$OUT" | grep -q REACHED_THE_END; then
    pass "the victim ran to completion through its own replacement"
else
    oops "the victim died even though it was replaced by rename: $OUT"
fi
if grep -q CLOBBERED "$WORK/victim-b"; then
    pass "and the replacement really landed (the file on disk is the new one)"
else
    oops "the file was never replaced, so nothing was under test"
fi

# ── a sandbox installation for the real script to update ────────────────
#
# Nothing here points at the real ~/.myjarbis-global: MYJARBIS_INSTALL_DIR and
# MYJARBIS_REGISTRY are both inside $WORK, so a bug in this test cannot reach
# the actual installation or its registry.
INSTALL="$WORK/install"
SOURCE="$WORK/checkout"
mkdir -p "$INSTALL/bin" "$INSTALL/mcp-server" \
         "$SOURCE/global/mcp-server" "$SOURCE/bin"
touch "$SOURCE/install.sh"

# Minimal, dependency-free mcp-server so step 4 (npm install + build) is a real
# run rather than a mock, without reaching the network.
cat > "$SOURCE/global/mcp-server/package.json" <<'PKG'
{
  "name": "sandbox-mcp-server",
  "version": "9.9.9",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "mkdir -p build/db && echo '' > build/index.js && echo 'export const SCHEMA_VERSION = 4;' > build/db/schema.js"
  }
}
PKG

make_victim "$SOURCE/bin/victim"
cp "$SOURCE/bin/victim" "$INSTALL/bin/victim"
printf '#!/bin/bash\necho old\n' > "$INSTALL/bin/myjarbis-doctor"
printf '#!/bin/bash\necho new\n' > "$SOURCE/bin/myjarbis-doctor"
chmod +x "$INSTALL/bin/myjarbis-doctor" "$SOURCE/bin/myjarbis-doctor"

export MYJARBIS_INSTALL_DIR="$INSTALL"
export MYJARBIS_REGISTRY="$WORK/no-such-registry.json"
export npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false

run_update() {
    bash "$UPDATE" --from="$SOURCE" --no-pull --yes "$@" 2>&1
}

# ── [3] the real update replaces bin/ by rename ─────────────────────────
echo "[3] the real update replaces every file in \$INSTALL_DIR/bin by rename"
INO_BEFORE="$(inode "$INSTALL/bin/myjarbis-doctor")"
UPDATE_OUT="$(run_update)"
UPDATE_RC=$?
if [ "$UPDATE_RC" -eq 0 ]; then
    pass "the update completed (rc=0)"
else
    oops "the update failed (rc=$UPDATE_RC): $(echo "$UPDATE_OUT" | tail -5)"
fi
INO_AFTER="$(inode "$INSTALL/bin/myjarbis-doctor")"
if [ "$INO_BEFORE" != "$INO_AFTER" ]; then
    pass "the inode changed ($INO_BEFORE → $INO_AFTER): a new file was renamed into place"
else
    oops "same inode ($INO_AFTER) — the file was rewritten in place, which is the bug"
fi
if grep -q new "$INSTALL/bin/myjarbis-doctor"; then
    pass "and the new content actually arrived"
else
    oops "the file was not updated at all"
fi
if [ -x "$INSTALL/bin/myjarbis-doctor" ]; then
    pass "the synced script is still executable"
else
    oops "the synced script lost its executable bit — the dispatcher cannot run it"
fi

# ── [4] end to end: a script parked mid-file survives a real update ─────
echo "[4] a script running while the real update replaces it completes"
READY="$WORK/e2e-ready"; GO="$WORK/e2e-go"
rm -f "$READY" "$GO"
VICTIM_READY="$READY" VICTIM_GO="$GO" bash "$INSTALL/bin/victim" >/dev/null 2>&1 &
VICTIM_PID=$!
WAITED=0
while [ ! -f "$READY" ] && [ "$WAITED" -lt 100 ]; do sleep 0.05; WAITED=$((WAITED+1)); done
# Change the source copy so the sync has something to write, then update while
# the victim is parked inside the old one.
printf '#!/bin/bash\necho replaced-by-update\n' > "$SOURCE/bin/victim"
run_update >/dev/null 2>&1
touch "$GO"
wait "$VICTIM_PID" 2>/dev/null
if grep -q REACHED_THE_END "$READY" 2>/dev/null; then
    pass "it ran to the end while the update replaced it underneath"
else
    oops "the running script was killed by the update: $(cat "$READY" 2>/dev/null)"
fi
if grep -q replaced-by-update "$INSTALL/bin/victim"; then
    pass "and the update did replace it (not a no-op that trivially passed)"
else
    oops "the update never replaced the file, so the assertion above is empty"
fi

# ── [5] running it twice is a repair, not a pile-up ─────────────────────
echo "[5] the update is safe to re-run and leaves no staging files"
LEFTOVERS="$(find "$INSTALL/bin" -name '.myjarbis-incoming.*' | wc -l)"
if [ "$LEFTOVERS" -eq 0 ]; then
    pass "no staging files left behind after two runs"
else
    oops "$LEFTOVERS staging file(s) left in $INSTALL/bin"
fi
# What a run that died mid-copy would leave: it must be swept, not inherited.
printf 'garbage from a crashed run\n' > "$INSTALL/bin/.myjarbis-incoming.999-myjarbis-doctor"
if run_update >/dev/null 2>&1; then
    pass "a third run completed with a crashed run's leftovers present"
else
    oops "the update failed when a previous run's staging file was present"
fi
if [ ! -f "$INSTALL/bin/.myjarbis-incoming.999-myjarbis-doctor" ]; then
    pass "and swept the leftover instead of leaving it next to the real commands"
else
    oops "the stale staging file survived the run"
fi
if grep -q new "$INSTALL/bin/myjarbis-doctor"; then
    pass "re-running left the installation correct, not half-applied"
else
    oops "the re-run corrupted $INSTALL/bin/myjarbis-doctor"
fi

echo
if [ "$FAILED" -eq 0 ]; then
    echo "✓ v045-update-self-overwrite: all assertions passed"
    exit 0
fi
echo "✗ v045-update-self-overwrite: $FAILED assertion(s) failed"
exit 1
