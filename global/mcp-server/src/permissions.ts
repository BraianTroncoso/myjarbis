/**
 * The permissions MyJarbis pre-approves in a project it wires.
 *
 * A session that opens by asking for permission six times is a session that
 * has not started. Every entry below is a read, or MyJarbis talking to its
 * own brain — nothing that writes a file, pushes, publishes or deletes. Those
 * keep prompting, which is the point: the goal is to remove the noise that
 * precedes work, not the pause that precedes damage.
 *
 * Why this lives in the installer at all: MyJarbis shipped NO permissions,
 * so every project accumulated its allowlist by the user clicking "allow" one
 * tool at a time. A 23-project fleet had eight of the thirty-two MCP tools
 * granted in its busiest project, with the remaining twenty-four still queued
 * up to interrupt someone.
 */
export const BASELINE_PERMISSIONS = [
  // One entry for all 32 MyJarbis tools. The wildcard is only legal in the
  // tool name, never in the server name, so this cannot widen to another
  // server even by accident.
  'mcp__myjarbis__*',
  'Bash(myjarbis *)',
  'Bash(git status)',
  'Bash(git log *)',
  'Bash(git diff *)',
  'Bash(git branch *)',
] as const;

/**
 * Add the baseline entries that are missing, and only those.
 *
 * Strictly additive. An entry the user deleted on purpose will come back —
 * there is no way to tell that apart from one they never had — but nothing
 * they wrote is reordered, rewritten or dropped, and `deny` is never touched.
 *
 * Returns what it actually added, so the caller can say so out loud. Writing
 * to someone's permission file is not something to do silently.
 *
 * Deliberately NOT handled here: `permissions.defaultMode`. Claude Code
 * ignores `bypassPermissions` when it comes from a project settings file (the
 * session starts in manual mode regardless), and changing the default mode of
 * every registered project is not a decision an installer gets to make on the
 * user's behalf.
 */
export function mergeBaselinePermissions(settings: Record<string, unknown>): string[] {
  const perms =
    settings.permissions &&
    typeof settings.permissions === 'object' &&
    !Array.isArray(settings.permissions)
      ? { ...(settings.permissions as Record<string, unknown>) }
      : {};

  const allow = Array.isArray(perms.allow) ? [...(perms.allow as unknown[])] : [];
  const have = new Set(allow.map((e) => String(e)));
  const added = BASELINE_PERMISSIONS.filter((p) => !have.has(p));
  if (added.length === 0) {
    // Leave the object untouched so the caller's `changed` flag stays false
    // and `--check` does not report a rewrite that would be a no-op.
    return [];
  }

  perms.allow = [...allow, ...added];
  settings.permissions = perms;
  return [...added];
}
