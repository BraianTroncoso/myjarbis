/**
 * What MyJarbis binds into Claude Code's lifecycle, and how to tell
 * whether a given project actually has it bound.
 *
 * This lives apart from cli.ts because two callers need the same answer
 * from opposite directions:
 *
 *   - `hook install claude` WRITES the wiring (see wireClaudeHooks).
 *   - `health` / `doctor` / `update --projects` READ it to decide whether
 *     a project needs repairing.
 *
 * They were not sharing it, and that is precisely how the bug this module
 * exists to prevent got in: health.ts decided a project's hook state by
 * diffing .claude-plugin/hooks/hooks.json against the template and never
 * looked at the settings file that makes those scripts run. Copying the
 * scripts is not installing them — Claude Code only reads a plugin's
 * hooks.json for plugins installed from a marketplace, so a project can
 * hold a byte-identical copy of the template and still have every event
 * dead. That combination reported as `current`, and `update --projects`
 * skips anything reporting `current`, so the one command meant to fix it
 * was gated off by the wrong reading.
 *
 * If you add an event to CLAUDE_HOOKS, the detector follows automatically.
 * That is the point of the file.
 */

import * as fs from 'fs';
import * as path from 'path';

export const HOOK_SCRIPT_DIR = '.claude-plugin/scripts';

/** The events MyJarbis binds and the script each one runs. SessionStart
 *  appears twice because startup and post-compaction are different
 *  scripts behind the same event, told apart by their matcher.
 *
 *  `timeout` is in SECONDS — the hooks.json this replaces said 10000 and
 *  5000, which read as ~3 hours rather than the 10s and 5s intended. */
export const CLAUDE_HOOKS: ReadonlyArray<{
  event: string;
  matcher?: string;
  script: string;
  timeout: number;
}> = [
  { event: 'SessionStart', matcher: 'startup|clear', script: 'session-start.sh', timeout: 10 },
  { event: 'SessionStart', matcher: 'compact', script: 'post-compaction.sh', timeout: 10 },
  { event: 'UserPromptSubmit', script: 'user-prompt-submit.sh', timeout: 5 },
  { event: 'Stop', script: 'session-stop.sh', timeout: 5 },
  { event: 'SessionEnd', script: 'session-end.sh', timeout: 10 },
];

/** Quoted so a project path containing spaces still resolves — the
 *  hooks.json this replaces interpolated ${CLAUDE_PROJECT_DIR} bare. */
export function hookCommand(script: string): string {
  return `"\${CLAUDE_PROJECT_DIR}/${HOOK_SCRIPT_DIR}/${script}"`;
}

/** True when a settings hook entry is one of ours, i.e. every command it
 *  runs points into .claude-plugin/scripts/. Used to replace our own
 *  entries on re-run while leaving the user's own hooks untouched. */
export function isMyJarbisHookEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks) || hooks.length === 0) return false;
  return hooks.every((h) => {
    const cmd = (h as { command?: unknown }).command;
    return typeof cmd === 'string' && cmd.includes(HOOK_SCRIPT_DIR);
  });
}

/**
 * Settings files Claude Code reads, in the order we check them.
 *
 * `hook install claude` only ever writes settings.local.json (it is
 * gitignored as per-developer state). We still accept a hand-written
 * entry in the shared settings.json as wired — a user who bound the
 * hooks themselves should not be told their project is broken.
 */
const SETTINGS_FILES = [
  path.join('.claude', 'settings.local.json'),
  path.join('.claude', 'settings.json'),
];

export type WiringState =
  /** Every event in CLAUDE_HOOKS is bound in a settings file. */
  | 'wired'
  /** Some events are bound and some are not — a partial or stale wiring. */
  | 'partial'
  /** No MyJarbis hook entry anywhere, including "no settings file at all". */
  | 'unwired'
  /** A settings file exists but is not readable/parseable JSON. */
  | 'unknown';

/**
 * Which of our events this project has bound, by reading the settings
 * files rather than the plugin directory.
 *
 * Deliberately lenient about HOW an event is bound: we count an event as
 * bound when any entry for it is one of ours. Matching the generated
 * command byte-for-byte would report a user who moved the scripts or
 * added their own timeout as unwired, and the repair we would then
 * suggest (`hook install claude`) would overwrite their edit. Staleness
 * of the scripts themselves is a separate question with a separate
 * answer — that is what the hooks.json diff is for.
 */
export function wiringState(projectPath: string): {
  state: WiringState;
  bound: string[];
  missing: string[];
} {
  const wanted = [...new Set(CLAUDE_HOOKS.map((h) => h.event))];
  const bound = new Set<string>();
  let unreadable = false;

  for (const rel of SETTINGS_FILES) {
    const file = path.join(projectPath, rel);
    if (!fs.existsSync(file)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      // Malformed JSON disables every setting in the file, so this is a
      // real failure state and not the same as "not wired" — the repair
      // is to fix the file by hand, and `hook install claude` refuses to
      // touch it for exactly that reason.
      unreadable = true;
      continue;
    }
    const hooksBlock = (parsed as { hooks?: unknown } | null)?.hooks;
    if (!hooksBlock || typeof hooksBlock !== 'object' || Array.isArray(hooksBlock)) continue;
    for (const event of wanted) {
      const entries = (hooksBlock as Record<string, unknown>)[event];
      if (Array.isArray(entries) && entries.some(isMyJarbisHookEntry)) bound.add(event);
    }
  }

  const missing = wanted.filter((e) => !bound.has(e));
  if (bound.size === wanted.length) return { state: 'wired', bound: wanted, missing: [] };
  // An unreadable file outranks "unwired" only while nothing is bound:
  // if the local file is broken but the shared one binds everything, the
  // hooks do run, and saying "unknown" would send the user chasing a
  // problem they do not have.
  if (unreadable && bound.size === 0) return { state: 'unknown', bound: [], missing };
  if (bound.size > 0) return { state: 'partial', bound: [...bound], missing };
  // No settings file and a settings file with no hooks block are the same
  // thing to Claude Code: nothing runs. Both are repaired by the same
  // command, so they get the same state.
  return { state: 'unwired', bound: [], missing };
}
