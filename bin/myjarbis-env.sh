#!/bin/bash
#
# MyJarbis — where the code is, and where the state is.
#
# Sourced by every command in this directory. It answers two questions that
# used to be answered by a hardcoded "$HOME/.myjarbis-global" repeated in five
# scripts, each with its own slightly different idea of the fallback:
#
#   INSTALL_DIR        the code — scripts, templates, the built MCP server.
#                      Owned by whatever installed it, replaced wholesale by an
#                      update.
#   MYJARBIS_STATE_DIR the state — the brain, the projects registry, the saved
#                      defaults, the brain backups. Owned by the user, and it
#                      has to survive any reinstall.
#
# Keeping the two apart is the prerequisite for being installed by a package
# manager: `pnpm up -g` replaces the package directory, so nothing of the
# user's may live inside it.
#
# This file is sourced, not executed. It sets variables and defines helpers;
# it prints nothing and decides nothing on its own.
#
# `set -u` is on in some callers, so every expansion here carries a default.

# ─── where this installation's bin/ really is ─────────────────────
# Follow symlinks by hand. `readlink -f` is GNU-only and macOS does not have
# it, and a package manager linking the command into a bin on PATH — which is
# exactly what `pnpm add -g` does — is the case that needs the resolution.
__mj_self="${BASH_SOURCE[0]}"
while [ -L "$__mj_self" ]; do
    __mj_link="$(readlink "$__mj_self")"
    case "$__mj_link" in
        /*) __mj_self="$__mj_link" ;;
        *)  __mj_self="$(dirname "$__mj_self")/$__mj_link" ;;
    esac
done
MYJARBIS_BIN_DIR="$(cd "$(dirname "$__mj_self")" && pwd)"
unset __mj_self __mj_link

# ─── the code ─────────────────────────────────────────────────────
# The parent of bin/ is the installation when it looks like one. A checkout
# also has a bin/, and `bash bin/myjarbis-update` from a checkout is the
# documented way to jump versions, so the parent is NOT the installation
# there. A sibling templates/ is what tells the two apart: an installation has
# it next to bin/, a checkout keeps it under global/.
if [ -n "${MYJARBIS_INSTALL_DIR:-}" ]; then
    INSTALL_DIR="$MYJARBIS_INSTALL_DIR"
elif [ -d "$MYJARBIS_BIN_DIR/../templates" ]; then
    INSTALL_DIR="$(cd "$MYJARBIS_BIN_DIR/.." && pwd)"
else
    INSTALL_DIR="$HOME/.myjarbis-global"
fi

# ─── the state ────────────────────────────────────────────────────
# The registry and the brain backups used to live INSIDE the install dir,
# which is the one place they must not be: a package manager replaces that
# directory wholesale, so `pnpm up -g` would take the list of the user's
# projects with it. `install.sh` already had to rescue the file across a
# reinstall by hand, and v0.5.2 put the saved defaults under MYJARBIS_HOME for
# this exact reason. These follow.
#
# Nothing is moved here. An installation that still has its registry in the
# old place keeps being read from there, and `myjarbis update` is what moves
# it — once, out loud, where a step can report it. A library that silently
# relocated a user's file on every command invocation is not a trade worth
# making for one line saved.
MYJARBIS_STATE_DIR="${MYJARBIS_HOME:-$HOME/.myjarbis}"
MYJARBIS_REGISTRY_LEGACY="$INSTALL_DIR/projects-registry.json"
if [ -n "${MYJARBIS_REGISTRY:-}" ]; then
    REGISTRY_FILE="$MYJARBIS_REGISTRY"
elif [ -f "$MYJARBIS_STATE_DIR/projects-registry.json" ]; then
    REGISTRY_FILE="$MYJARBIS_STATE_DIR/projects-registry.json"
elif [ -f "$MYJARBIS_REGISTRY_LEGACY" ]; then
    REGISTRY_FILE="$MYJARBIS_REGISTRY_LEGACY"
else
    # Neither exists: a fresh install writes to the new place.
    REGISTRY_FILE="$MYJARBIS_STATE_DIR/projects-registry.json"
fi

BACKUPS_DIR="${MYJARBIS_BACKUPS:-$MYJARBIS_STATE_DIR/backups}"
MYJARBIS_BACKUPS_LEGACY="$INSTALL_DIR/backups"

# ─── finding the other commands ───────────────────────────────────
# Prefer the sibling of the script that is actually running over the one under
# INSTALL_DIR: running `bash bin/myjarbis` out of a checkout should reach that
# checkout's subcommands, not the installed ones. Falls back to the
# installation, then to its parent, which is how the dispatcher used to look.
mj_command_path() {
    local name="$1" candidate
    for candidate in \
        "$MYJARBIS_BIN_DIR/$name" \
        "$INSTALL_DIR/bin/$name" \
        "$INSTALL_DIR/../bin/$name"
    do
        [ -f "$candidate" ] && { echo "$candidate"; return 0; }
    done
    return 1
}
