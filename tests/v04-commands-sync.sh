#!/bin/bash
#
# E2E test: commands sync.
#
# The command writes FILES into projects that already exist, so the
# assertions that matter are the ones about what it must NOT do:
#
#   · a hand-edited command file is never overwritten without --force.
#     There is no history that tells a hand-edit from an old version, so
#     the tool reports `diverged` and stops. This is the same shape of
#     mistake `skill reseed` made with `interaction-style`, one layer out
#     — there it was a DB row, here it is a file the user can open.
#   · nothing is written without --apply.
#   · a file that matches another language's template is OURS, not a
#     hand-edit, so correcting the language must not need --force.
#
# Plus a drift guard: the command list lives twice (TypeScript and the
# install loop in bin/myjarbis-init) and the two must name the same set.
#
# Exits 0 on success, non-zero on the first failed assertion.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export MYJARBIS_INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$REPO_ROOT/global}"
B="$MYJARBIS_INSTALL_DIR/mcp-server/build"
MJ="$REPO_ROOT/bin/myjarbis"
CLI="$B/cli.js"
TPL="$MYJARBIS_INSTALL_DIR/templates/.claude/commands"

if [ ! -f "$B/commands.js" ]; then
  echo "✗ build not found at $B — run: cd $MYJARBIS_INSTALL_DIR/mcp-server && npm run build"
  exit 1
fi

WORK="$(mktemp -d -t myjarbis-cmdsync-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export HOME="$WORK/home"; mkdir -p "$HOME"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

mkdir -p "$WORK/proj" && cd "$WORK/proj" && git init -q .
git config user.email t@example.com && git config user.name Test
"$MJ" init --yes --skip-memory >/dev/null 2>&1
CMDS="$WORK/proj/.claude/commands"

# ── [1] init installs every shipped command ───────────────────────
echo "[1] a freshly initialised project is already current"

# Driven off SHIPPED_COMMANDS rather than a hand-written list, so a command
# added to the product without being installed by `init` fails here instead
# of shipping unreachable. That is the gap this whole suite exists for.
WANT=$(node -e "
  import('$B/commands.js').then(m=>console.log(m.SHIPPED_COMMANDS.join(' ')))")
MISSED=""
for c in $WANT; do
  [ -f "$CMDS/$c.md" ] || MISSED="$MISSED $c"
done
if [ -z "$MISSED" ]; then
  pass "init installed every shipped command ($WANT)"
else
  oops "init did not install:$MISSED — found: $(ls "$CMDS" 2>&1)"
fi

# Each one has to exist in every language, or `commands sync` silently
# falls back and a user on ES/PT gets a command they cannot read.
MISSING_TPL=""
for c in $WANT; do
  for l in es en pt; do
    [ -f "$TPL/$c.$l.md" ] || MISSING_TPL="$MISSING_TPL $c.$l"
  done
done
if [ -z "$MISSING_TPL" ]; then
  pass "every shipped command ships in all three languages"
else
  oops "missing templates:$MISSING_TPL"
fi

# /jarbis-save is only worth having if it is NOT /jarbis-close. The one
# line that makes them different is the absence of end_session, so assert
# that rather than trusting the prose around it.
if [ -f "$TPL/jarbis-save.en.md" ]; then
  if grep -q 'Do not call `end_session`' "$TPL/jarbis-save.en.md" \
     && grep -q 'set_project_state' "$TPL/jarbis-save.en.md"; then
    pass "jarbis-save says set_project_state and refuses end_session"
  else
    oops "jarbis-save lost the rule that distinguishes it from jarbis-close"
  fi
fi

node "$CLI" commands sync --json > "$WORK/c1.json" 2>&1 || true
if node -e "
  const p=require('$WORK/c1.json').projects[0];
  process.exit(p.files.every(f=>f.status==='current')?0:1)"; then
  pass "sync has nothing to do right after init"
else
  oops "sync wants to change a fresh project: $(node -e "
    console.log(JSON.stringify(require('$WORK/c1.json').projects[0].files))")"
fi

# ── [2] a missing command is `new`, and --apply is required ───────
echo "[2] a command the project never got"
rm -f "$CMDS/jarbis-close.md"

node "$CLI" commands sync --json > "$WORK/c2.json" 2>&1 || true
if node -e "
  const f=require('$WORK/c2.json').projects[0].files.find(f=>f.command==='jarbis-close');
  process.exit(f && f.status==='new' && f.written===false ? 0 : 1)"; then
  pass "reported as new"
else
  oops "a missing command was not reported as new"
fi
if [ ! -f "$CMDS/jarbis-close.md" ]; then
  pass "wrote nothing without --apply"
else
  oops "wrote the file without --apply"
fi

node "$CLI" commands sync --apply --json > "$WORK/c3.json" 2>&1 || true
if [ -f "$CMDS/jarbis-close.md" ] && cmp -s "$CMDS/jarbis-close.md" "$TPL/jarbis-close.en.md"; then
  pass "--apply installed it, byte-identical to the EN template"
else
  oops "--apply did not install the command correctly"
fi

# ── [3] a hand-edited command survives --apply ────────────────────
echo "[3] a file the user edited by hand"
MINE="# MY OWN /jarbis — must survive"
echo "$MINE" > "$CMDS/jarbis.md"

node "$CLI" commands sync --json > "$WORK/c4.json" 2>&1 || true
if node -e "
  const f=require('$WORK/c4.json').projects[0].files.find(f=>f.command==='jarbis');
  process.exit(f && f.status==='diverged' ? 0 : 1)"; then
  pass "reported as diverged"
else
  oops "a hand-edited file was not reported as diverged"
fi

node "$CLI" commands sync --apply --json > "$WORK/c5.json" 2>&1 || true
if [ "$(cat "$CMDS/jarbis.md")" = "$MINE" ]; then
  pass "--apply left the user's file untouched"
else
  oops "--apply overwrote a hand-edited command"
fi

node "$CLI" commands sync --apply --force --json > "$WORK/c6.json" 2>&1 || true
if cmp -s "$CMDS/jarbis.md" "$TPL/jarbis.en.md"; then
  pass "--force overwrites it, which is what --force is for"
else
  oops "--force did not overwrite the diverged file"
fi

# ── [4] the wrong language is ours, not a hand-edit ───────────────
echo "[4] a project whose language changed"
node -e "
  const fs=require('fs');
  const p='$WORK/proj/.myjarbis/config/settings.json';
  const s=JSON.parse(fs.readFileSync(p,'utf-8'));
  s.language='es';
  fs.writeFileSync(p, JSON.stringify(s,null,2));
"
# The file on disk is still the EN one, which the project no longer wants.
node "$CLI" commands sync --json > "$WORK/c7.json" 2>&1 || true
if node -e "
  const f=require('$WORK/c7.json').projects[0].files.find(f=>f.command==='jarbis');
  process.exit(f && f.status==='other-language' && f.matched==='en' ? 0 : 1)"; then
  pass "reported as other-language, not diverged"
else
  oops "an EN file in an ES project was misclassified"
fi

node "$CLI" commands sync --apply --json > "$WORK/c8.json" 2>&1 || true
if cmp -s "$CMDS/jarbis.md" "$TPL/jarbis.es.md"; then
  pass "corrected to ES without needing --force"
else
  oops "the language was not corrected"
fi

# ── [5] a directory that is not a project is reported, not fatal ──
echo "[5] a target that is not a MyJarbis project"
mkdir -p "$WORK/notaproject" && cd "$WORK/notaproject"
if node "$CLI" commands sync --json > "$WORK/c9.json" 2>&1; then
  if node -e "
    const p=require('$WORK/c9.json').projects[0];
    process.exit(p.error && p.files.length===0 ? 0 : 1)"; then
    pass "reported the error and exited 0"
  else
    oops "did not report a non-project cleanly"
  fi
else
  oops "crashed on a directory that is not a MyJarbis project"
fi
cd "$WORK/proj"

# ── [6] drift guard: the list lives twice ─────────────────────────
echo "[6] the TS list and the init loop agree"
TS_LIST=$(node -e "
  import('$B/commands.js').then(m=>console.log(m.SHIPPED_COMMANDS.slice().sort().join(',')))" )
SH_LIST=$(grep -oP '^for cmd in \K[^;]+' "$REPO_ROOT/bin/myjarbis-init" | tr ' ' '\n' | sort | paste -sd, -)
if [ "$TS_LIST" = "$SH_LIST" ]; then
  pass "both name the same commands: $TS_LIST"
else
  oops "command lists drifted — TS has [$TS_LIST], myjarbis-init has [$SH_LIST]"
fi

# Every command must carry the prefix: the slash menu is a flat namespace
# shared with every other plugin, so the prefix is the only thing that marks
# a command as ours at a glance. A bare `close` would ship loose.
if node -e "
  import('$B/commands.js').then(m => {
    const bad = m.SHIPPED_COMMANDS.filter(c => !c.startsWith(m.COMMAND_PREFIX));
    if (bad.length) { console.error(bad.join(',')); process.exit(1); }
  })"; then
  pass "every shipped command starts with the MyJarbis prefix"
else
  oops "a command ships without the prefix, so nothing marks it as ours"
fi

# ── [7] init ignores what it generates in the user's repo ─────────
echo "[7] the .gitignore init writes for the user"
# Found by walking the newcomer path: the block covered the brain, `active`
# and the materialised skills, but not the generated command files, so every
# project showed .claude/ as untracked and one `git add -A` committed this
# machine's copy. settings.local.json is worse — it carries absolute paths.
cd "$WORK/proj"
for p in .claude/commands/jarbis.md .claude/commands/jarbis-close.md .claude/settings.local.json .myjarbis/active; do
  if git check-ignore -q "$p"; then
    pass "ignored: $p"
  else
    oops "not ignored by the block init writes: $p"
  fi
done

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ v04-commands-sync: all assertions passed"
  exit 0
fi
echo "✗ v04-commands-sync: $FAILED assertion(s) failed" >&2
exit 1
