/**
 * Session lifecycle tools — start_session, end_session, resume.
 *
 * The session is the unit of work inside a module. Every observation
 * needs an active session; every "Retomar aquí" lookup walks back from
 * the most recent CLOSED session of a module.
 *
 * start_session loads the project + module context AND the previous
 * next_session in one call so the agent has everything it needs to
 * resume coherently.
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { ServerContext } from '../context.js';
import { autoCloseStaleInModule, AUTO_MARKER } from './autoClose.js';
import { claimSessionForProject } from '../sessionOwnership.js';
import { writeActiveModules } from '../activeModules.js';
import { MyJarbisError, ErrorType } from '../types.js';
import {
  ProjectContextRow,
  ModuleContextRow,
  ContextKind,
} from '../db/schema.js';
import { generateModuleDiagram, isDiagramAuto } from '../diagram/generate.js';
import { openInVscode } from '../diagram/open.js';

// ─────────────────────────────────────────────────────────────────────
// Stale-resume detection
//
// A "Retomar aquí" line older than N days is a tripwire: the user is
// about to act on context that may have moved on (PRs merged, branches
// renamed, decisions reversed). Surfacing the age before the agent
// assumes the note still applies prevents stale-autopilot mistakes.
// Day-bucketed against UTC midnight so the value flips only when the
// calendar date crosses — keeps prompt-cache survival within the day.
// ─────────────────────────────────────────────────────────────────────

export const DEFAULT_STALE_AFTER_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export function readStaleThreshold(projectPath: string): number {
  try {
    const p = path.join(projectPath, '.myjarbis', 'config', 'settings.json');
    if (!fs.existsSync(p)) return DEFAULT_STALE_AFTER_DAYS;
    const s = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const v = s?.session?.stale_after_days;
    if (typeof v === 'number' && v > 0 && Number.isFinite(v)) {
      return Math.floor(v);
    }
    return DEFAULT_STALE_AFTER_DAYS;
  } catch {
    return DEFAULT_STALE_AFTER_DAYS;
  }
}

export function computeStaleness(
  endedAtIso: string | null,
  thresholdDays: number,
  now: number = Date.now(),
): { days: number; stale: boolean } | null {
  if (!endedAtIso) return null;
  const normalized = endedAtIso.replace(' ', 'T');
  const parsed = new Date(normalized.endsWith('Z') ? normalized : normalized + 'Z');
  if (Number.isNaN(parsed.getTime())) return null;
  const nowDays = Math.floor(now / DAY_MS);
  const endedDays = Math.floor(parsed.getTime() / DAY_MS);
  const days = Math.max(0, nowDays - endedDays);
  return { days, stale: days >= thresholdDays };
}

// ─────────────────────────────────────────────────────────────────────
// start_session
// ─────────────────────────────────────────────────────────────────────

export const startSessionInputSchema = {
  type: 'object' as const,
  properties: {
    module: {
      type: 'string' as const,
      description:
        'Name of the module to work on. Must exist (use create_module first if not). ' +
        'This is the PRIMARY module: the session belongs to it, and so do ' +
        'observations, progress and the handoff.',
    },
    with_modules: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description:
        'Additional modules to open READ-ONLY alongside the primary, when the ' +
        'work spans more than one. Their context is returned as an index ' +
        '(excerpts, no bodies) and scope="module" searches span them, but ' +
        'nothing is ever written to them. Use when the user picks several ' +
        'modules; the selection is remembered for the next session start.',
    },
  },
  required: ['module'],
};

const startSessionArgsZ = z
  .object({
    module: z.string().min(1),
    with_modules: z.array(z.string().min(1)).optional(),
  })
  .strict();

interface ContextEntrySummary {
  id: number;
  kind: ContextKind;
  title: string;
  source_path: string | null;
  excerpt: string;
  /** Present only on module_context rows that have a non-null `progress`. */
  progress?: string;
}

interface StoryIndexEntry {
  localId: string;
  /** Present only when the story row has a `progress` value set. */
  progress?: string;
}

export interface StartSessionResult {
  sessionId: number;
  startedAt: string;
  project: { id: number; name: string };
  module: { id: number; name: string; description: string | null; status: string };
  projectContext: ContextEntrySummary[];
  moduleContext: ContextEntrySummary[];
  /** Stories are listed by localId only (no body) to avoid dumping
   *  hundreds of rows on bootstrap. Use search() or load_module(kinds=['story'])
   *  to pull a specific one when working on it. Each entry includes
   *  `progress` if the agent has updated it via update_progress. */
  stories: { count: number; entries: StoryIndexEntry[] };
  previousSession: {
    id: number;
    endedAt: string | null;
    summary: string | null;
    nextSession: string | null;
    /** Whole days between the previous session's ended_at and now (UTC,
     *  day-bucketed). Null when there is no previous closed session or
     *  ended_at could not be parsed. */
    daysSinceClose: number | null;
    /** True when daysSinceClose >= settings.session.stale_after_days
     *  (default 7). Signals the agent (and the hook) to surface a
     *  "context may have moved on" warning before continuing. */
    stale: boolean;
    /** Threshold actually applied for the staleness check, for transparency
     *  in the tool response. */
    staleAfterDays: number;
  } | null;
  /** The last handoff a HUMAN wrote, when `previousSession.nextSession` is
   *  machine-written and this is not the same session.
   *
   *  An auto-close is always the newest close, so it is what previousSession
   *  returns — and the curated handoff ends up one level down per auto-close,
   *  visible to nobody. Its staleness is computed from ITS OWN ended_at, which
   *  matters: an auto-close that ran today resets previousSession.daysSinceClose
   *  to 0, so the stale warning never fires for a handoff that is weeks old. */
  curatedResume?: {
    sessionId: number;
    endedAt: string | null;
    summary: string | null;
    nextSession: string;
    daysSinceClose: number | null;
    stale: boolean;
    /** Closed sessions between this one and now, all machine-written. */
    buriedUnder: number;
  };
  /** Set when a session left open in this module was closed retroactively
   *  on the way in. Surfaced so the agent can say so rather than silently
   *  presenting a machine-written resume point as if it were curated. */
  autoClosedPrevious?: {
    sessionId: number;
    observations: number;
    durationMinutes: number;
    nextSessionSource: string;
  };
  /** Modules opened read-only alongside the primary.
   *
   *  Index depth only — a count and the last handoff pointer, never bodies.
   *  Loading a companion's rows at session start would spend the window on
   *  context the session may never touch; `search(module=...)` and
   *  `load_module(module=..., row_ids=[...])` reach them when it does. */
  companions?: Array<{
    module: string;
    description: string | null;
    rows: number;
    lastClosedAt: string | null;
    /** First line of its last handoff, as a pointer rather than the text. */
    lastHandoffFirstLine: string | null;
  }>;
  hint?: string;
}

export function startSession(
  ctx: ServerContext,
  rawArgs: unknown,
): StartSessionResult {
  const args = startSessionArgsZ.parse(rawArgs);
  const project = ctx.requireProject();
  const module = ctx.requireModule(args.module);

  // Close a session left open in this module before opening a new one.
  //
  // The SessionEnd hook normally handles this on exit, but no hook fires for
  // a killed terminal, a crashed process or a reboot — and a guarantee that
  // depends on a clean exit is not a guarantee. Closing retroactively here
  // means `resume` and `list_modules` always have something to report, which
  // is the whole reason the close matters.
  const autoClosed = autoCloseStaleInModule(ctx, module.id);

  const session = ctx.db.sessions.start(module.id);
  ctx.setActiveSession(session.id, module.id);

  // Attribute this session to the editor session driving us, so another
  // Claude's SessionEnd cannot close it. The hook claims the sessions IT
  // opens; this covers the other half — the ones the agent opens mid-session
  // by asking for a module — which is the common case whenever the user did
  // not run `myjarbis module use` before opening Claude. See
  // sessionOwnership.ts for why the attribution is an inference and why being
  // wrong about it is harmless.
  claimSessionForProject(project.id, session.id);

  // Companion modules: resolved, remembered, and summarised at index depth.
  //
  // `requireModule` for each, so a typo fails loudly here rather than
  // silently dropping a module the user asked for.
  const companionRows = (args.with_modules ?? [])
    .map((name) => ctx.requireModule(name))
    .filter((m) => m.id !== module.id);

  // Remembered only when there IS a multi-module selection to remember.
  //
  // `.myjarbis/active` is what the SessionStart hook reads to skip the menu,
  // and writing it on every start_session would change a contract nobody asked
  // to change: picking a module in chat would silently make it the auto-start
  // module for every future open. Two suites caught exactly that. Setting the
  // single active module stays what it has always been — an explicit
  // `myjarbis module use`.
  //
  // With companions, persisting IS the point: it is what makes the checkbox
  // prompt and the CLI one feature rather than two, so the next open comes
  // back with the same set.
  if (companionRows.length > 0) {
    writeActiveModules(ctx.projectPath, [module.name, ...companionRows.map((m) => m.name)]);
  }

  const companions = companionRows.map((m) => {
    const lastClosed = ctx.db.sessions.findLastClosedByModule(m.id);
    return {
      module: m.name,
      description: m.description,
      rows: ctx.db.moduleContext.countByModule(m.id),
      lastClosedAt: lastClosed?.ended_at ?? null,
      lastHandoffFirstLine:
        lastClosed?.next_session?.split('\n').find((l) => l.trim().length > 0)?.trim() ?? null,
    };
  });

  // Living diagram: when a module is chosen by chat (start_session) rather than
  // pre-set via the SessionStart fast-path, open its diagram here too so it
  // shows up automatically. Best-effort, honours the toggle, never throws.
  if (isDiagramAuto(ctx.projectPath)) {
    try {
      const dia = generateModuleDiagram(ctx, module.name);
      if (dia.ok && dia.path) openInVscode(dia.path, ctx.projectPath);
    } catch {
      /* never block start_session on diagram generation */
    }
  }

  const projectCtx = ctx.db.projectContext.listByProject(project.id).map(
    summarizeProjectContext,
  );
  // Split module_context: stories get an index-only summary (count +
  // localIds), the rest (workflow / plan / use_cases / functional_doc /
  // acceptance_criteria / other) keep their 240-char excerpt. Otherwise
  // a module with N stories blows the bootstrap response to ~Nx400b.
  const allModuleCtx = ctx.db.moduleContext.listByModule(module.id);
  const storyRows = allModuleCtx.filter((r) => r.kind === 'story');
  const nonStoryRows = allModuleCtx.filter((r) => r.kind !== 'story');
  const moduleCtx = nonStoryRows.map(summarizeModuleContext);
  const storyEntries: StoryIndexEntry[] = storyRows
    .map((r) => {
      const localId = extractLocalId(r);
      if (!localId) return null;
      const entry: StoryIndexEntry = { localId };
      if (r.progress) entry.progress = r.progress;
      return entry;
    })
    .filter((e): e is StoryIndexEntry => e !== null)
    .sort((a, b) => a.localId.localeCompare(b.localId));
  const stories = {
    count: storyRows.length,
    entries: storyEntries,
  };

  const previousClosed = ctx.db.sessions.findLastClosedByModule(module.id);
  const staleAfterDays = readStaleThreshold(ctx.projectPath);
  const staleness = previousClosed
    ? computeStaleness(previousClosed.ended_at, staleAfterDays)
    : null;

  // Dig out the curated handoff when the newest close is machine-written.
  // Skipped when previousClosed IS the curated one, which is the common case.
  const curated = resolveCuratedResume(ctx, module.id, previousClosed, staleAfterDays);

  return {
    sessionId: session.id,
    startedAt: session.started_at,
    project: { id: project.id, name: project.name },
    module: {
      id: module.id,
      name: module.name,
      description: module.description,
      status: module.status,
    },
    projectContext: projectCtx,
    moduleContext: moduleCtx,
    stories,
    previousSession: previousClosed
      ? {
          id: previousClosed.id,
          endedAt: previousClosed.ended_at,
          summary: previousClosed.summary,
          nextSession: previousClosed.next_session,
          daysSinceClose: staleness?.days ?? null,
          stale: staleness?.stale ?? false,
          staleAfterDays,
        }
      : null,
    curatedResume: curated ?? undefined,
    autoClosedPrevious: autoClosed
      ? {
          sessionId: autoClosed.sessionId,
          observations: autoClosed.observations,
          durationMinutes: autoClosed.durationMinutes,
          nextSessionSource: autoClosed.nextSessionSource,
        }
      : undefined,
    companions: companions.length > 0 ? companions : undefined,
    hint: autoClosed
      ? `The previous session in "${module.name}" was left open and has just been ` +
        `closed automatically, so previousSession.nextSession is MACHINE-WRITTEN ` +
        `(it starts with "${AUTO_MARKER}"). Read it as a record of what happened, ` +
        `not as an instruction: tell the user it was auto-closed and confirm where ` +
        `things stand before acting on it.` +
        (autoClosed.nextSessionSource === 'project_state'
          ? ' It came from the project living state, which was set deliberately, so it is the most trustworthy source available.'
          : ' It was derived from the last notes, so it may be incomplete.') +
        (curated ? ` ${curatedHint(curated)}` : '')
      : curated
      ? `previousSession.nextSession is MACHINE-WRITTEN (starts with "${AUTO_MARKER}"). ` +
        `${curatedHint(curated)}`
      : previousClosed?.next_session
      ? (staleness?.stale
          ? `⚠ STALE RESUME — previousSession.nextSession is ${staleness.days} day(s) old (closed ${previousClosed.ended_at} UTC, threshold ${staleAfterDays}d). Before assuming it still applies, ask the user: branch state, open PRs, anything that moved since. THEN continue from previousSession.nextSession.`
          : `READ previousSession.nextSession FIRST — that is the canonical "Retomar aquí". Use it to greet the user. The catalog (projectContext, moduleContext, stories) is for on-demand lookup via search/load_module.`)
      : `New module — no previous session. Surface counts (project_context: ${projectCtx.length}, module_context: ${moduleCtx.length}, stories: ${stories.count}) and ask the user where to start.`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// end_session
// ─────────────────────────────────────────────────────────────────────

export const endSessionInputSchema = {
  type: 'object' as const,
  properties: {
    summary: {
      type: 'string' as const,
      description:
        'Retrospective: 1–3 bullet sentences describing what was done. Avoid fluff. ' +
        'Keep it under ~2000 characters: a long summary is what loses next_session ' +
        'in transit, and next_session is the half that matters tomorrow. Put the ' +
        'detail in a save_observation instead.',
    },
    next_session: {
      type: 'string' as const,
      description:
        'Action-oriented "Retomar aquí" text the next session will read. Include open work, branch names, single concrete next step, blockers.',
    },
  },
  required: ['summary', 'next_session'],
};

const endSessionArgsZ = z
  .object({
    summary: z.string().min(1),
    next_session: z.string().min(1),
  })
  .strict();

/**
 * Both fields are required, and the one that goes missing is always
 * `next_session` — never `summary`. The cause is not validation: a long
 * `summary` can get the call's arguments truncated before they reach the
 * server, so the second key never arrives at all. A bare validator error then
 * says "next_session: Required", which reads as if the caller forgot it, and
 * the honest answer ("your summary was too long, the rest was cut off") is
 * nowhere in the message.
 *
 * It cost four retries once and left sessions 464 and 465 with throwaway
 * handoffs, which is the expensive part: the summary is a nice-to-have, the
 * handoff is what the next session actually opens with.
 */
function parseEndSessionArgs(rawArgs: unknown): {
  summary: string;
  next_session: string;
} {
  const parsed = endSessionArgsZ.safeParse(rawArgs);
  if (parsed.success) return parsed.data;

  const received = (rawArgs ?? {}) as Record<string, unknown>;
  const summaryLength =
    typeof received.summary === 'string' ? received.summary.length : 0;
  const nextMissing =
    received.next_session === undefined || received.next_session === '';

  if (nextMissing && summaryLength > 0) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `end_session got a summary of ${summaryLength} characters and no ` +
        `next_session. Both are required, and this is what a truncated call ` +
        `looks like rather than a forgotten argument — a long summary can cut ` +
        `the rest of the arguments off in transit. Retry with a summary under ` +
        `~2000 characters; the detail belongs in a save_observation. Do not ` +
        `settle for a throwaway next_session: it is the line the next session ` +
        `opens with.`,
      { summaryLength, nextSessionMissing: true },
    );
  }

  throw parsed.error;
}

export interface EndSessionResult {
  sessionId: number;
  startedAt: string;
  endedAt: string;
  summary: string;
  nextSession: string;
  module: { id: number; name: string };
  observationsCount: number;
}

export function endSession(
  ctx: ServerContext,
  rawArgs: unknown,
): EndSessionResult {
  const args = parseEndSessionArgs(rawArgs);
  const { sessionId, moduleId } = ctx.requireActiveSession();

  const closed = ctx.db.sessions.end(sessionId, args.summary, args.next_session);
  const module = ctx.db.modules.findById(moduleId)!;
  const observations = ctx.db.observations.listBySession(sessionId);

  ctx.clearActiveSession();

  return {
    sessionId: closed.id,
    startedAt: closed.started_at,
    endedAt: closed.ended_at!,
    summary: closed.summary!,
    nextSession: closed.next_session!,
    module: { id: module.id, name: module.name },
    observationsCount: observations.length,
  };
}

// ─────────────────────────────────────────────────────────────────────
// resume
// ─────────────────────────────────────────────────────────────────────

export const resumeInputSchema = {
  type: 'object' as const,
  properties: {
    module: {
      type: 'string' as const,
      description:
        'Module name to resume from. If omitted, uses the currently active module.',
    },
  },
  required: [],
};

const resumeArgsZ = z.object({ module: z.string().min(1).optional() }).strict();

export interface ResumeResult {
  module: { id: number; name: string };
  hasNextSession: boolean;
  lastSessionEndedAt: string | null;
  summary: string | null;
  nextSession: string | null;
  /** Same contract as in start_session: the last human-written handoff, when
   *  the newest close is machine-written and therefore hides it. */
  curatedResume?: NonNullable<StartSessionResult['curatedResume']>;
  hint?: string;
}

export function resume(ctx: ServerContext, rawArgs: unknown): ResumeResult {
  const args = resumeArgsZ.parse(rawArgs ?? {});

  let moduleRow;
  if (args.module) {
    moduleRow = ctx.requireModule(args.module);
  } else {
    if (ctx.activeModuleId === null) {
      throw new MyJarbisError(
        ErrorType.SESSION_NOT_ACTIVE,
        'No active module. Pass `module` explicitly or call start_session first.',
      );
    }
    moduleRow = ctx.db.modules.findById(ctx.activeModuleId)!;
  }

  const last = ctx.db.sessions.findLastClosedByModule(moduleRow.id);
  const curated = resolveCuratedResume(
    ctx,
    moduleRow.id,
    last,
    readStaleThreshold(ctx.projectPath),
  );

  return {
    module: { id: moduleRow.id, name: moduleRow.name },
    hasNextSession: !!(last && last.next_session),
    lastSessionEndedAt: last?.ended_at ?? null,
    summary: last?.summary ?? null,
    nextSession: last?.next_session ?? null,
    curatedResume: curated ?? undefined,
    hint: curated
      ? curatedHint(curated)
      : last?.next_session
      ? undefined
      : `Module "${moduleRow.name}" has no closed session yet — nothing to resume.`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/** True when this text was written by autoClose rather than by a person. */
function isSynthetic(nextSession: string | null): boolean {
  return !!nextSession && nextSession.startsWith(AUTO_MARKER);
}

/**
 * The curated handoff hiding under one or more machine-written closes.
 *
 * Returns null in the ordinary case — the newest close is the curated one, so
 * `previousSession` already carries it and repeating it would just double the
 * bootstrap payload.
 */
function resolveCuratedResume(
  ctx: ServerContext,
  moduleId: number,
  previousClosed: { id: number; next_session: string | null } | null,
  staleAfterDays: number,
): NonNullable<StartSessionResult['curatedResume']> | null {
  if (!previousClosed || !isSynthetic(previousClosed.next_session)) return null;

  const curated = ctx.db.sessions.findLastCuratedByModule(moduleId);
  if (!curated?.next_session || curated.id === previousClosed.id) return null;

  const staleness = computeStaleness(curated.ended_at, staleAfterDays);
  return {
    sessionId: curated.id,
    endedAt: curated.ended_at,
    summary: curated.summary,
    nextSession: curated.next_session,
    daysSinceClose: staleness?.days ?? null,
    stale: staleness?.stale ?? false,
    buriedUnder: ctx.db.sessions.countClosedAfterInModule(moduleId, curated),
  };
}

/** The instruction that goes with a recovered handoff. */
function curatedHint(
  curated: NonNullable<StartSessionResult['curatedResume']>,
): string {
  const age =
    curated.daysSinceClose === null
      ? ''
      : ` It is ${curated.daysSinceClose} day(s) old${curated.stale ? ' and over the staleness threshold' : ''},` +
        ` which previousSession.daysSinceClose does NOT show because the automatic close reset that clock.`;
  return (
    `The real "Retomar aquí" is in curatedResume (session #${curated.sessionId}, ` +
    `buried under ${curated.buriedUnder} machine-written close(s)) — READ THAT, not ` +
    `previousSession.nextSession.${age} Confirm with the user before acting on it: ` +
    `whatever happened in the sessions that were never written up is not in there.`
  );
}

const EXCERPT_LEN = 240;

function summarizeProjectContext(row: ProjectContextRow): ContextEntrySummary {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    source_path: row.source_path,
    excerpt: makeExcerpt(row.content),
  };
}

function summarizeModuleContext(row: ModuleContextRow): ContextEntrySummary {
  const out: ContextEntrySummary = {
    id: row.id,
    kind: row.kind,
    title: row.title,
    source_path: row.source_path,
    excerpt: makeExcerpt(row.content),
  };
  if (row.progress) out.progress = row.progress;
  return out;
}

function makeExcerpt(content: string): string {
  const normalized = content.trim().replace(/\s+/g, ' ');
  if (normalized.length <= EXCERPT_LEN) return normalized;
  return normalized.slice(0, EXCERPT_LEN - 1) + '…';
}

/** Pulls the story localId from the row. import_json writes
 *  source_path as "<file>#<localId>". Falls back to scanning the title
 *  for an Id-like token if the source_path is missing. */
function extractLocalId(row: ModuleContextRow): string | null {
  if (row.source_path) {
    const hashIdx = row.source_path.lastIndexOf('#');
    if (hashIdx >= 0 && hashIdx < row.source_path.length - 1) {
      return row.source_path.slice(hashIdx + 1);
    }
  }
  const m = row.title.match(/[A-Z]+-S?\d+(?:\.\d+)?/);
  return m ? m[0] : null;
}
