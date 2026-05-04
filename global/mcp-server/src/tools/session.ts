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
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import {
  ProjectContextRow,
  ModuleContextRow,
  ContextKind,
} from '../db/schema.js';

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
}

export interface StartSessionResult {
  sessionId: number;
  startedAt: string;
  project: { id: number; name: string };
  module: { id: number; name: string; description: string | null; status: string };
  projectContext: ContextEntrySummary[];
  moduleContext: ContextEntrySummary[];
  /** Stories are listed by localId only (no excerpt) to avoid dumping
   *  hundreds of rows on bootstrap. Use search() or load_module(kinds=['story'])
   *  to pull a specific one when working on it. */
  stories: { count: number; localIds: string[] };
  previousSession: {
    id: number;
    endedAt: string | null;
    summary: string | null;
    nextSession: string | null;
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
  const stories = {
    count: storyRows.length,
    localIds: storyRows
      .map((r) => extractLocalId(r))
      .filter((id): id is string => id !== null)
      .sort(),
  };

  const previousClosed = ctx.db.sessions.findLastClosedByModule(module.id);

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
        }
      : null,
    hint: previousClosed?.next_session
      ? `READ previousSession.nextSession FIRST — that is the canonical "Retomar aquí". Use it to greet the user. The catalog (projectContext, moduleContext, stories) is for on-demand lookup via search/load_module.`
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
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    source_path: row.source_path,
    excerpt: makeExcerpt(row.content),
  };
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
