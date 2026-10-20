#!/bin/bash
#
# E2E test: `commands sync` must tell "ours, from an earlier release" from
# "somebody edited this".
#
# `diverged` used to mean "matches no template we currently ship", which
# conflates those two and refuses both without `--force`. It cost something
# real: a commit removed three live client identifiers from the `/jarbis`
# template because they appeared in user-facing output of a public repo. That
# fixed the repository and nothing else — 23 projects on disk kept the old
# file, all 23 reported `diverged`, and the scrub read as done in git while
# being undone everywhere it mattered. Establishing that `--force` was safe
# meant diffing all 23 copies against the template as it existed at several
# past commits, by hand.
#
# Now an exact git object-name match against every version the repository has
# ever shipped answers that for free, because a hand-edited file cannot
# collide with a blob we actually shipped.
#
# What it pins:
#
#   · a copy of a genuinely older shipped template reports
#     `old-shipped-version` and is updated WITHOUT --force
#   · a hand-edited file still reports `diverged` and is left alone
#   · --force still overwrites a hand-edited file, as before
#   · with no git history reachable, classification degrades to `diverged`
#     rather than guessing — the pre-existing behaviour
#
# Exits 0 on success, non-zero on the first failed assertion.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MJ="$REPO_ROOT/bin/myjarbis"

WORK="$(mktemp -d -t myjarbis-cmdhistory-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export HOME="$WORK/home"; mkdir -p "$HOME"
export MYJARBIS_INSTALL_DIR="$REPO_ROOT/global"
export MYJARBIS_HOME="$WORK/brain"
export MYJARBIS_REGISTRY="$WORK/projects-registry.json"

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

TEMPLATE_REL="global/templates/.claude/commands/jarbis.es.md"

# A version of the template this repository really shipped, taken from its own
# history rather than fabricated — a fabricated "old version" would not have a
# matching object name, so it would prove nothing.
OLD_SHA="$(git -C "$REPO_ROOT" log --all --format=%H -- "$TEMPLATE_REL" | sed -n '2p')"
if [ -z "$OLD_SHA" ]; then
    echo "✗ $TEMPLATE_REL has fewer than two commits in this checkout — cannot test history matching"
    exit 1
fi
OLD_TEMPLATE="$WORK/old-template.md"
git -C "$REPO_ROOT" show "$OLD_SHA:$TEMPLATE_REL" > "$OLD_TEMPLATE"
CURRENT_TEMPLATE="$REPO_ROOT/$TEMPLATE_REL"
if cmp -s "$OLD_TEMPLATE" "$CURRENT_TEMPLATE"; then
    echo "✗ the previous commit's template is identical to the current one — pick another fixture"
    exit 1
fi
echo "    · fixture: $TEMPLATE_REL as of ${OLD_SHA:0:8}"

mkdir -p "$WORK/proj" && cd "$WORK/proj" && git init -q .
git config user.email t@example.com && git config user.name Test
"$MJ" init --yes --skip-memory >/dev/null 2>&1
# The classification is per language; pin it so the fixture and the template
# the sync compares against are the same language.
mkdir -p .myjarbis/config
node -e "
  const fs=require('fs'), p='.myjarbis/config/settings.json';
  const s=JSON.parse(fs.readFileSync(p,'utf8')); s.language='es';
  fs.writeFileSync(p, JSON.stringify(s,null,2));
" 2>/dev/null || echo '{"language":"es"}' > .myjarbis/config/settings.json

status_of() {
  node -e "
    const r = JSON.parse(require('fs').readFileSync('$WORK/report.json','utf8'));
    const p = r.projects[0] || {};
    const f = (p.files || []).find(x => x.command === 'jarbis');
    console.log(f ? f.status : 'MISSING');
  "
}
written_of() {
  node -e "
    const r = JSON.parse(require('fs').readFileSync('$WORK/report.json','utf8'));
    const p = r.projects[0] || {};
    const f = (p.files || []).find(x => x.command === 'jarbis');
    console.log(f && f.written ? 'yes' : 'no');
  "
}
sync_json() { "$MJ" commands sync --json "$@" > "$WORK/report.json" 2>/dev/null; }

# ── [1] an older shipped version is recognised as ours ──────────────────
echo "[1] a copy of an older shipped template is not 'diverged'"
mkdir -p .claude/commands
cp "$OLD_TEMPLATE" .claude/commands/jarbis.md
sync_json
S="$(status_of)"
if [ "$S" = "old-shipped-version" ]; then
    pass "classified as old-shipped-version"
else
    oops "classified as '$S' — a stale copy of our own file still needs --force"
fi

# ── [2] and is updated without --force ─────────────────────────────────
echo "[2] it is updated without --force"
sync_json --apply
if [ "$(written_of)" = "yes" ]; then
    pass "the sync reported it as written"
else
    oops "the sync refused to write it: status $(status_of)"
fi
if cmp -s .claude/commands/jarbis.md "$CURRENT_TEMPLATE"; then
    pass "the file on disk is now the current template"
else
    oops "the file was not actually updated"
fi
sync_json
if [ "$(status_of)" = "current" ]; then
    pass "a second run reports it as current — the propagation finished"
else
    oops "still not current after --apply: $(status_of)"
fi

# ── [3] a hand-edited file is still protected ──────────────────────────
echo "[3] a hand-edited file is still 'diverged' and left alone"
printf '# my own version\n\nI edited this on purpose.\n' > .claude/commands/jarbis.md
sync_json --apply
if [ "$(status_of)" = "diverged" ]; then
    pass "classified as diverged"
else
    oops "a hand-edited file was classified '$(status_of)' — it can now be overwritten silently"
fi
if grep -q 'I edited this on purpose' .claude/commands/jarbis.md; then
    pass "and --apply without --force did not touch it"
else
    oops "the hand-edited file was overwritten without --force: data loss"
fi

# ── [4] --force still means what it said ───────────────────────────────
echo "[4] --force still overwrites a hand-edited file"
sync_json --apply --force
if cmp -s .claude/commands/jarbis.md "$CURRENT_TEMPLATE"; then
    pass "--force replaced it with the current template"
else
    oops "--force no longer overwrites a diverged file"
fi

# ── [5] no git history reachable → the old behaviour ───────────────────
#
# An installation whose source checkout is gone cannot ask git anything. It
# must fall back to reporting `diverged` rather than guessing, which is also
# exactly how it behaved before history matching existed.
echo "[5] with no reachable git history it degrades to 'diverged'"
# An install dir with the same templates but no repository above it: the CLI
# is symlinked rather than copied, because what is under test is where the
# TEMPLATES sit, not where the code does.
mkdir -p "$WORK/detached"
cp -r "$REPO_ROOT/global/templates" "$WORK/detached/templates"
ln -s "$REPO_ROOT/global/mcp-server" "$WORK/detached/mcp-server"
cp "$OLD_TEMPLATE" .claude/commands/jarbis.md
MYJARBIS_INSTALL_DIR="$WORK/detached" "$MJ" commands sync --json > "$WORK/report.json" 2>/dev/null
S="$(status_of)"
if [ "$S" = "diverged" ]; then
    pass "no history, no guess: reported diverged"
else
    oops "expected diverged without a git checkout, got '$S'"
fi
if grep -q 'MM-S\|CHK-\|PROL-' "$WORK/detached/templates/.claude/commands/jarbis.es.md" 2>/dev/null; then
    oops "the shipped ES template still contains real client identifiers"
else
    pass "and the shipped template carries no client identifiers (the scrub holds)"
fi

echo
if [ "$FAILED" -eq 0 ]; then
    echo "✓ v045-commands-history: all assertions passed"
    exit 0
fi
echo "✗ v045-commands-history: $FAILED assertion(s) failed"
exit 1
