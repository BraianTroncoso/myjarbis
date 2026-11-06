#!/bin/bash
#
# MyJarbis — install from a git checkout
#
# The other way in is `npm i -g myjarbis && myjarbis setup`. Both end in the
# same place, bin/myjarbis-setup, which builds the runtime at
# ~/.myjarbis-global. What this script adds is only what a checkout lacks
# and an npm install gets for free: putting the CLI on the PATH.
#
# This script used to copy, install, build and register by itself, and on
# an existing installation it `rm -rf`'d the directory and rescued the
# registry through a temp file. setup never deletes the install dir, so
# there is nothing to rescue and nothing to ask: running this again is an
# update from this checkout.
#
# MYJARBIS_ASSUME_YES=1 is still honoured, as --yes.

set -e

RED='\033[38;5;88m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$HOME/.myjarbis-global}"

if [ ! -f "package.json" ] || [ ! -d "global" ] || [ ! -x "bin/myjarbis-setup" ]; then
    echo -e "  ${RED}${BOLD}FAIL${NC}  run this script from the MyJarbis root directory"
    exit 1
fi

SETUP_ARGS=(--from="$(pwd)")
[ -n "${MYJARBIS_ASSUME_YES:-}" ] && SETUP_ARGS+=(--yes)
bin/myjarbis-setup "${SETUP_ARGS[@]}" "$@"

# ─── PATH ─────────────────────────────────────────────────────────
echo -e "${RED}${BOLD}PATH${NC}"
SHELL_RC=""
case "$(basename "${SHELL:-}")" in
    zsh)  SHELL_RC="$HOME/.zshrc" ;;
    bash) SHELL_RC="$HOME/.bashrc" ;;
esac

if command -v myjarbis >/dev/null 2>&1; then
    echo -e "  already on PATH ${DIM}($(command -v myjarbis))${NC}"
elif [ -n "$SHELL_RC" ]; then
    if ! grep -q "myjarbis-global/bin" "$SHELL_RC" 2>/dev/null; then
        {
            echo ""
            echo "# MyJarbis CLI"
            echo "export PATH=\"\$HOME/.myjarbis-global/bin:\$PATH\""
        } >> "$SHELL_RC"
        echo "  added to $SHELL_RC"
    fi
    echo -e "  ${RED}WARN${NC}  reload your shell: source $SHELL_RC"
else
    echo -e "  ${RED}WARN${NC}  add $INSTALL_DIR/bin to your PATH by hand"
    echo -e "        ${DIM}or skip this entirely: npm i -g myjarbis${NC}"
fi
echo
