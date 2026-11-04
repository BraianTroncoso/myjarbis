#!/bin/bash
#
# E2E test: a command finds its own installation, wherever it was invoked from.
#
#   1. invoked through a symlink, a command still finds its library
#   2. and through a chain of them
#   3. an installation (templates next to bin/) resolves to its own root
#   4. a checkout does NOT claim to be an installation
#   5. MYJARBIS_INSTALL_DIR still wins over both
#   6. `start` honours MYJARBIS_REGISTRY, which it used to ignore
#   7. `doctor` honours MYJARBIS_REGISTRY, which it used to ignore
#   8. the dispatcher reaches the subcommand next to it, not the installed one
#   9. only myjarbis-env.sh decides where the registry lives
#  10. sync_executables puts the library in place, next to the commands
#
# Why a symlink at all: `pnpm add -g` links the command into a bin directory
# on PATH, so `dirname "$0"` is that directory and not the package. Everything
# a command needs — its library, templates/, the built server — is next to the
# real file, so the link has to be followed before anything else happens. It
# is followed by hand because `readlink -f` is GNU-only and macOS lacks it.
#
# Exits 0 on success, non-zero if any assertion fails.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

WORK="$(mktemp -d -t myjarbis-paths-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
echo "→ work dir: $WORK"
export HOME="$WORK/fakehome"; mkdir -p "$HOME"
unset TMUX WSL_DISTRO_NAME MYJARBIS_INSTALL_DIR MYJARBIS_REGISTRY MYJARBIS_HOME

FAILED=0
pass() { echo "    ✓ $1"; }
oops() { echo "    ✗ $1" >&2; FAILED=$((FAILED + 1)); }

# An installation: bin/ with a templates/ beside it, which is what tells an
# install apart from a checkout (a checkout keeps templates under global/).
INSTALL="$WORK/install"
mkdir -p "$INSTALL/templates"
cp -r "$REPO_ROOT/bin" "$INSTALL/"

# Asks the library, through $1, where it thinks things are.
ask() {
  env -u MYJARBIS_INSTALL_DIR -u MYJARBIS_REGISTRY HOME="$HOME" bash -c '
    __mj_s="$1"
    while [ -L "$__mj_s" ]; do
      __mj_l="$(readlink "$__mj_s")"
      case "$__mj_l" in /*) __mj_s="$__mj_l";; *) __mj_s="$(dirname "$__mj_s")/$__mj_l";; esac
    done
    . "$(cd "$(dirname "$__mj_s")" && pwd)/myjarbis-env.sh"
    echo "$INSTALL_DIR"
  ' _ "$1"
}

echo "→ [1] invoked through a symlink"
mkdir -p "$WORK/pnpm-bin"
ln -s "$INSTALL/bin/myjarbis" "$WORK/pnpm-bin/myjarbis"
OUT="$("$WORK/pnpm-bin/myjarbis" --version 2>&1)" || OUT="FAILED: $OUT"
[ "$OUT" = "MyJarbis v$(grep -m1 '"version"' "$REPO_ROOT/package.json" | sed 's/.*"\([0-9.]*\)".*/\1/')" ] \
  && pass "the linked command ran and found myjarbis-env.sh" \
  || oops "a symlinked command did not run: $OUT"

echo "→ [2] through a chain of symlinks"
mkdir -p "$WORK/pnpm-bin2"
ln -s "$WORK/pnpm-bin/myjarbis" "$WORK/pnpm-bin2/myjarbis"
"$WORK/pnpm-bin2/myjarbis" --version >/dev/null 2>&1 \
  && pass "two hops resolve to the same file" \
  || oops "a two-hop symlink did not resolve"

echo "→ [3] an installation resolves to its own root"
[ "$(ask "$INSTALL/bin/myjarbis")" = "$INSTALL" ] \
  && pass "templates/ next to bin/ means this is the installation" \
  || oops "expected $INSTALL, got $(ask "$INSTALL/bin/myjarbis")"

echo "    · and so does the symlink pointing into it"
[ "$(ask "$WORK/pnpm-bin/myjarbis")" = "$INSTALL" ] \
  && pass "the link resolves to the installation, not to the bin on PATH" \
  || oops "through the link: expected $INSTALL, got $(ask "$WORK/pnpm-bin/myjarbis")"

echo "→ [4] a checkout does not claim to be an installation"
# This is the case that matters for `bash bin/myjarbis-update` out of a
# checkout: the installation being updated is somewhere else entirely, and
# taking the checkout root would make the script update itself in place.
GOT="$(ask "$REPO_ROOT/bin/myjarbis")"
[ "$GOT" = "$HOME/.myjarbis-global" ] \
  && pass "a checkout falls back to ~/.myjarbis-global" \
  || oops "a checkout resolved to $GOT instead of $HOME/.myjarbis-global"

echo "→ [5] MYJARBIS_INSTALL_DIR wins"
GOT="$(MYJARBIS_INSTALL_DIR=/opt/elsewhere bash -c '. "$1"; echo "$INSTALL_DIR"' _ "$INSTALL/bin/myjarbis-env.sh")"
[ "$GOT" = "/opt/elsewhere" ] \
  && pass "the override beats both the layout and the fallback" \
  || oops "MYJARBIS_INSTALL_DIR was ignored: got $GOT"

echo "→ [6] start honours MYJARBIS_REGISTRY"
# It built "$INSTALL_DIR/projects-registry.json" itself and ignored the
# override, so a hermetic run read the developer's real project list.
printf '{ "projects": {} }\n' > "$INSTALL/projects-registry.json"
set +e
OUT="$(MYJARBIS_INSTALL_DIR="$INSTALL" MYJARBIS_REGISTRY="$WORK/elsewhere.json" \
       "$INSTALL/bin/myjarbis-start" --print </dev/null 2>&1)"
set -e
grep -q "$WORK/elsewhere.json" <<<"$OUT" \
  && pass "start names the overridden path, not the install dir's" \
  || oops "start ignored MYJARBIS_REGISTRY: $(head -2 <<<"$OUT")"

echo "→ [7] doctor honours MYJARBIS_REGISTRY"
# doctor only reaches the registry check once it has a project to look up, so
# the minimum a project needs is .myjarbis/config/settings.json with a name.
mkdir -p "$WORK/proj/.myjarbis/config"
printf '{ "name": "proj", "framework": "generic" }\n' > "$WORK/proj/.myjarbis/config/settings.json"
printf '{ "projects": { "proj": { "name": "proj", "path": "%s" } } }\n' "$WORK/proj" \
  > "$WORK/override.json"
set +e
OUT="$(cd "$WORK/proj" && MYJARBIS_INSTALL_DIR="$INSTALL" MYJARBIS_REGISTRY="$WORK/override.json" \
       "$INSTALL/bin/myjarbis-doctor" 2>&1)"
set -e
# The install dir's registry is empty and the override has this project, so
# reading the wrong one produces "not registered" and reading the right one
# produces the pass. Matching the "OK" prefix is what keeps the warning from
# satisfying a grep for the same words.
grep -q "OK    registered in global registry" <<<"$OUT" \
  && pass "doctor read the overridden registry" \
  || oops "doctor did not see the project the override registers: $(grep -i registered <<<"$OUT" || echo 'no registry line at all')"

echo "→ [8] the dispatcher reaches its own sibling"
# Running a checkout's `myjarbis` must reach that checkout's subcommands.
# It used to look under INSTALL_DIR first, so a checkout dispatched into the
# installed copy and a change you were testing never ran.
mkdir -p "$WORK/fake/bin"
cat > "$WORK/fake/bin/myjarbis-doctor" <<'EOF'
#!/bin/bash
echo "SIBLING DOCTOR"
EOF
chmod +x "$WORK/fake/bin/myjarbis-doctor"
cp "$REPO_ROOT/bin/myjarbis" "$REPO_ROOT/bin/myjarbis-env.sh" "$WORK/fake/bin/"
set +e
OUT="$(MYJARBIS_INSTALL_DIR="$INSTALL" "$WORK/fake/bin/myjarbis" doctor 2>&1)"
set -e
grep -q "SIBLING DOCTOR" <<<"$OUT" \
  && pass "the sibling subcommand ran, not the installed one" \
  || oops "the dispatcher went to the installation: $(head -2 <<<"$OUT")"

echo "→ [9] only the library builds the registry path"
# A second script gluing INSTALL_DIR to the filename is how the override got
# ignored in the first place, in two commands at once. `update` does reassign
# REGISTRY_FILE — it is the thing that moves the file — so the guard is about
# the path being rebuilt from the install dir, not about the assignment.
HITS="$(grep -ln 'INSTALL_DIR/projects-registry\.json' "$REPO_ROOT"/bin/* | grep -v 'myjarbis-env.sh' || true)"
[ -z "$HITS" ] \
  && pass "no command glues the registry path to the install dir" \
  || oops "these still build the registry path from the install dir: $HITS"

echo "→ [10] the library is synced next to the commands"
# Every command sources it on its first lines, so an installation that has the
# commands and not the library has five broken commands and no clue why.
for cmd in "$REPO_ROOT"/bin/*; do
  case "$(basename "$cmd")" in *.sh) continue ;; esac
  grep -q 'myjarbis-env.sh' "$cmd" \
    || oops "$(basename "$cmd") does not source myjarbis-env.sh"
done
[ -f "$INSTALL/bin/myjarbis-env.sh" ] \
  && pass "every command sources it, and a copied bin/ carries it" \
  || oops "myjarbis-env.sh is missing from a copied bin/"

echo
if [ "$FAILED" -eq 0 ]; then
  echo "✓ all assertions passed"
else
  echo "✗ $FAILED assertion(s) failed"
  exit 1
fi
