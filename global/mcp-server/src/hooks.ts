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
  // `resume` belongs here with `startup` and `clear`. It was missing, so
  // `claude --continue` / `claude --resume` ran no hook at all: no greeting, no
  // session opened or adopted, and — once sessions grew owners — no claim
  // either. The premise is that every Claude session has a MyJarbis session
  // behind it, and resuming is one of the ordinary ways to start one.
  //
  // `fork` is deliberately NOT included. A fork is a branch of a conversation
  // rather than someone sitting down to work, and binding it would open or
  // adopt a session for machinery the user never asked about. Add it only with
  // evidence of what actually fires it.
  {
    event: 'SessionStart',
    matcher: 'startup|resume|clear',
    script: 'session-start.sh',
    timeout: 10,
  },
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
/** The sources a matcher string covers. No matcher means every source, which
 *  is how Claude Code reads an entry without one. */
function matcherSources(matcher: string | undefined): string[] | null {
  if (matcher === undefined || matcher.trim() === '') return null; // all
  return matcher.split('|').map((s) => s.trim()).filter(Boolean);
}

/**
 * Whether one of OUR entries on this event covers the binding we need.
 *
 * Lenient about the command string and the timeout — a user who moved the
 * scripts or set their own timeout is wired, and rewriting over their edit
 * would be the wrong repair. NOT lenient about the matcher, because a matcher
 * is not a style choice: a SessionStart bound to `startup|clear` genuinely
 * does not fire on `resume`, and calling that "wired" is how a propagated
 * matcher change reaches 22 projects and silently skips the 23rd.
 */
function entriesCover(entries: unknown[], matcher: string | undefined): boolean {
  const needed = matcherSources(matcher);
  for (const entry of entries) {
    if (!isMyJarbisHookEntry(entry)) continue;
    const have = matcherSources((entry as { matcher?: string }).matcher);
    if (have === null) return true; // their entry covers every source
    if (needed === null) continue; // we need every source, theirs is narrower
    if (needed.every((n) => have.includes(n))) return true;
  }
  return false;
}

export function wiringState(projectPath: string): {
  state: WiringState;
  bound: string[];
  missing: string[];
  /** True when ANY entry of ours exists anywhere, regardless of matcher.
   *  Tells "nothing is bound" apart from "bound in an older shape" — two
   *  situations with the same repair and very different urgency. */
  anyBound: boolean;
} {
  const wanted = [...new Set(CLAUDE_HOOKS.map((h) => h.event))];
  // Per BINDING, not per event: SessionStart appears twice with different
  // matchers, and counting the event as bound because one of them exists is
  // how a project with only the `compact` entry read as fully wired.
  const covered = new Set<string>();
  let anyBound = false;
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
    for (const h of CLAUDE_HOOKS) {
      const entries = (hooksBlock as Record<string, unknown>)[h.event];
      if (!Array.isArray(entries)) continue;
      if (entries.some(isMyJarbisHookEntry)) anyBound = true;
      if (entriesCover(entries, h.matcher)) covered.add(`${h.event}|${h.matcher ?? ''}`);
    }
  }

  // An event counts as bound only when every binding we declare for it is
  // covered, so `bound`/`missing` stay event names for their existing readers.
  const bound = new Set(
    wanted.filter((e) =>
      CLAUDE_HOOKS.filter((h) => h.event === e).every((h) =>
        covered.has(`${h.event}|${h.matcher ?? ''}`),
      ),
    ),
  );

  const missing = wanted.filter((e) => !bound.has(e));
  if (bound.size === wanted.length)
    return { state: 'wired', bound: wanted, missing: [], anyBound };
  // An unreadable file outranks "unwired" only while nothing is bound:
  // if the local file is broken but the shared one binds everything, the
  // hooks do run, and saying "unknown" would send the user chasing a
  // problem they do not have.
  if (unreadable && bound.size === 0) return { state: 'unknown', bound: [], missing, anyBound };
  // `anyBound` and not `bound.size` here: a project whose every event carries
  // one of our entries but with an outdated matcher has bound.size 0 and is
  // still a partial wiring, not an absent one.
  if (bound.size > 0 || anyBound)
    return { state: 'partial', bound: [...bound], missing, anyBound };
  // No settings file and a settings file with no hooks block are the same
  // thing to Claude Code: nothing runs. Both are repaired by the same
  // command, so they get the same state.
  return { state: 'unwired', bound: [], missing, anyBound };
}
