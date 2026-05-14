#!/bin/bash
#
# MyJarbis UserPromptSubmit hook.
#
# Reads the user prompt from stdin and pipes it to the node CLI helper,
# which:
#   1. On the first message of a project session, suggests ToolSearch
#      to load MyJarbis tools (one-shot per project, tracked in a tmp flag).
#   2. Detects the configured story_pattern (e.g., MM-S1.2) and suggests
#      `search` for the corresponding story.
#   3. After 15 minutes without a save_observation, injects a reminder.
#
# Output is plain text on stdout, injected into the agent's context.

set -uo pipefail

INSTALL_DIR="${MYJARBIS_INSTALL_DIR:-$HOME/.myjarbis-global}"
CLI="$INSTALL_DIR/mcp-server/build/cli.js"

if [ ! -f "$CLI" ]; then
  exit 0
fi

# Forward stdin to the node helper. Best-effort: never block the prompt.
node "$CLI" hook user-prompt-submit
