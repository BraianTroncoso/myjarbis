#!/bin/bash
#
# E2E test: init asks the person's preferences once, and initialises several
# projects in one run.
#
#   4. language and persona come from the saved defaults, so a second project
#      does not ask what the first already answered; --ask ignores them
#   5. a flag is a choice for one run: it never rewrites the defaults
#   6. a batch initialises every directory named, skips the ones that are not
#      repositories or are already initialised, reports the missing ones as a
#      failure, and backs ~/.claude.json up once rather than once per project
#   7. in the --list picker, `all` leaves the initialised projects out, and
#      with --yes takes them in, as the confirmation screen says it does
#
# The picker reads from a terminal, so [7] runs it inside a pseudo-terminal
# from python3, which init already needs, rather than expect, which a CI
# image may not have.
#
# Exits 0 on success, non-zero if any assertion fails.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"

if [ ! -f "$B/cli.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-init-batch-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
# Hermetic HOME: this suite is about what init writes into $HOME, so the real
# one must never be in reach.
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/home"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"
unset MYJARBIS_LANGUAGE MYJARBIS_PERSONA MYJARBIS_ASSUME_YES MYJARBIS_CLAUDE_JSON_BACKED_UP

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

# Through a file, not a pipe: a `| while read` loop runs in a subshell and
# every FAILED increment inside it would be lost.
ASSERTS="$WORK/asserts.out"
read_asserts() {
  while IFS='|' read -r st msg; do
    [ "$st" = "PASS" ] && pass "$msg" || oops "$msg"
  done < "$ASSERTS"
}

new_repo() {
  mkdir -p "$1"
  git -C "$1" init -q .
}

is_es() { grep -q "Activar MyJarbis" "$1/.claude/commands/jarbis.md" 2>/dev/null; }

# ─── [4-5] defaults ───
echo "→ [4] a saved default answers the question a second project would ask"
mkdir -p "$MYJARBIS_HOME"
printf '{ "language": "ES", "persona": "2" }\n' > "$MYJARBIS_HOME/defaults.json"
new_repo "$WORK/second"
(cd "$WORK/second" && "$MJ" init --yes --skip-memory </dev/null >/dev/null 2>&1) || true
is_es "$WORK/second" && pass "the ES /jarbis was installed from the defaults" \
                     || oops "the defaults were not read"

new_repo "$WORK/asked"
(cd "$WORK/asked" && "$MJ" init --yes --skip-memory --ask </dev/null >/dev/null 2>&1) || true
is_es "$WORK/asked" && oops "--ask still used the saved defaults" \
                    || pass "--ask ignores the saved defaults"

echo "→ [5] a flag does not rewrite the defaults"
new_repo "$WORK/flagged"
(cd "$WORK/flagged" && "$MJ" init --yes --skip-memory --language=PT </dev/null >/dev/null 2>&1) || true
grep -q '"ES"' "$MYJARBIS_HOME/defaults.json" \
  && pass "defaults still say ES after a --language=PT run" \
  || oops "a flag overwrote the saved defaults"

# ─── [6] batch ───
echo "→ [6] several projects in one run"
printf '{ "projects": {} }\n' > "$HOME/.claude.json"
rm -f "$HOME"/.claude.json.bak-*
new_repo "$WORK/batch/one"
new_repo "$WORK/batch/two"
new_repo "$WORK/batch/ready"
mkdir -p "$WORK/batch/ready/.myjarbis"; echo keep > "$WORK/batch/ready/.myjarbis/marker"
mkdir -p "$WORK/batch/plain"

set +e
(cd "$WORK" && "$MJ" init batch/one batch/two/ batch/ready batch/plain batch/missing \
    --skip-memory --language=ES </dev/null > "$WORK/batch.out" 2>&1)
STATUS=$?
set -e

[ -d "$WORK/batch/one/.myjarbis" ] && [ -d "$WORK/batch/two/.myjarbis" ] \
  && pass "both repositories were initialised" \
  || { oops "a repository of the batch was not initialised"; cat "$WORK/batch.out"; }
is_es "$WORK/batch/one" && is_es "$WORK/batch/two" \
  && pass "the language given once reached every project" \
  || oops "the batch did not hand its language down"
[ "$(ls "$WORK/batch/ready/.myjarbis")" = "marker" ] \
  && pass "an initialised project is skipped, not reinitialised" \
  || oops "the batch reinitialised a project without --yes"
[ ! -d "$WORK/batch/plain/.myjarbis" ] \
  && pass "a directory that is not a repository is skipped" \
  || oops "a non-repository was initialised"
[ "$STATUS" -ne 0 ] && grep -q "batch/missing" "$WORK/batch.out" \
  && pass "a missing directory fails the batch, by name" \
  || oops "a missing directory went unreported (exit $STATUS)"

node -e "
const d = JSON.parse(require('fs').readFileSync(process.env.HOME + '/.claude.json', 'utf8'));
const n = Object.values(d.projects).filter((p) => p.mcpServers && p.mcpServers.myjarbis).length;
console.log((n === 2 ? 'PASS|' : 'FAIL|') + n + ' projects registered in ~/.claude.json');
" > "$ASSERTS"
read_asserts

BACKUPS=$( (ls "$HOME"/.claude.json.bak-* 2>/dev/null || true) | wc -l | tr -d ' ')
[ "$BACKUPS" -eq 1 ] && pass "one backup for the whole batch" \
                     || oops "$BACKUPS backups for one batch"

# ─── [7] picker ───
echo "→ [7] 'all' in the picker, with and without --yes"
# Runs init under a pseudo-terminal and types $2.. one line each, then waits
# for it to finish. The output goes to $1.
pick() {
  local out="$1"; shift
  python3 - "$out" "$MJ" "$@" <<'PY'
import os, pty, sys, time
out, mj, root, flags, *lines = sys.argv[1:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(mj, [mj, "init", "--list", root, *flags.split()])
buf = b""
for line in lines:
    time.sleep(0.5)
    os.write(fd, line.encode() + b"\n")
while True:
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    buf += chunk
os.waitpid(pid, 0)
open(out, "wb").write(buf)
PY
}

new_repo "$WORK/pick/fresh"
new_repo "$WORK/pick/ready"
mkdir -p "$WORK/pick/ready/.myjarbis"; echo keep > "$WORK/pick/ready/.myjarbis/marker"

pick "$WORK/pick1.out" "$WORK/pick" "--skip-memory --language=ES" all "" y || true
[ -d "$WORK/pick/fresh/.myjarbis" ] \
  && pass "'all' picks the projects not initialised yet" \
  || { oops "'all' did not pick a fresh project"; cat "$WORK/pick1.out"; }
[ "$(ls "$WORK/pick/ready/.myjarbis")" = "marker" ] \
  && pass "without --yes, 'all' leaves an initialised project alone" \
  || oops "'all' reinitialised a project without --yes"

pick "$WORK/pick2.out" "$WORK/pick" "--skip-memory --language=ES --yes" all "" y || true
[ -d "$WORK/pick/ready/.myjarbis/config" ] \
  && pass "with --yes, 'all' reinitialises the initialised project too" \
  || { oops "with --yes, 'all' still skipped an initialised project"; cat "$WORK/pick2.out"; }

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ all assertions passed"
else
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
