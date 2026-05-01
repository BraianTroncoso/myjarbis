#!/bin/bash
#
# MyJarbis SessionStart hook (matcher: compact).
#
# Fires after Claude Code compacts the conversation. The agent's recent
# context was summarized; we inject an imperative recovery sequence so
# it reloads the active module's full context + the last next_session
# before continuing the user's task.

set -uo pipefail

INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$HOME/.myjarbis-global}"
CLI="$INSTALL_DIR/mcp-server/build/cli.js"

if [ ! -f "$CLI" ]; then
  exit 0
fi

exec node "$CLI" hook post-compaction
