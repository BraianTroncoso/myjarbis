#!/bin/bash
#
# MyJarbis Stop hook.
#
# Fires when the user closes Claude Code. We:
#   1. Detect any open session (no ended_at) and remind the agent to
#      call /complete or end_session before exit, so the next session
#      can resume from a coherent next_session.
#   2. Optionally clean up module-level skill folders if
#      settings.skills.cleanup_module_skills_on_session_end is true.

set -uo pipefail

INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$HOME/.myjarbis-global}"
CLI="$INSTALL_DIR/mcp-server/build/cli.js"

if [ ! -f "$CLI" ]; then
  exit 0
fi

exec node "$CLI" hook session-stop
