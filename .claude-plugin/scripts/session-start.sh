#!/bin/bash
#
# MyJarbis SessionStart hook (matcher: startup|clear).
#
# Delegates to the node CLI helper which:
#   1. Detects the project at cwd.
#   2. Lists modules.
#   3. If exactly one module exists and auto_module_select_when_single is
#      not disabled, starts a session there and materializes its skills.
#   4. Otherwise, prints the module menu plus the most recent
#      "Retomar aquí" so the agent can ask the user which one to use.
#
# Output is plain text on stdout, which Claude Code injects as
# systemMessage at session start. stderr is shown only on failure.

set -uo pipefail

INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$HOME/.myjarbis-global}"
CLI="$INSTALL_DIR/mcp-server/build/cli.js"

if [ ! -f "$CLI" ]; then
  # Hook is best-effort: do not fail the session if MyJarbis isn't installed.
  exit 0
fi

exec node "$CLI" hook session-start
