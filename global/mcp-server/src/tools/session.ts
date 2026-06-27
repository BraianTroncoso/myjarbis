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
        'Name of the module to work on. Must exist (use create_module first if not).',
    },
  },
  required: ['module'],
};

const startSessionArgsZ = z.object({ module: z.string().min(1) }).strict();

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
  hint?: string;
}

export function startSession(
  ctx: ServerContext,
  rawArgs: unknown,
): StartSessionResult {
  const args = startSessionArgsZ.parse(rawArgs);
  const project = ctx.requireProject();
  const module = ctx.requireModule(args.module);

  const session = ctx.db.sessions.start(module.id);
  ctx.setActiveSession(session.id, module.id);

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
    hint: previousClosed?.next_session
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
        'Retrospective: 1–3 bullet sentences describing what was done. Avoid fluff.',
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
  const args = endSessionArgsZ.parse(rawArgs);
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
  return {
    module: { id: moduleRow.id, name: moduleRow.name },
    hasNextSession: !!(last && last.next_session),
    lastSessionEndedAt: last?.ended_at ?? null,
    summary: last?.summary ?? null,
    nextSession: last?.next_session ?? null,
    hint: last?.next_session
      ? undefined
      : `Module "${moduleRow.name}" has no closed session yet — nothing to resume.`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

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
