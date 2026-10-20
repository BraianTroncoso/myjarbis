/**
 * Observation tool — save_observation.
 *
 * Persists a decision / gotcha / progress / error / discovery under the
 * ACTIVE session. Requires start_session to have been called.
 */

import { z } from 'zod';
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import { ObservationKind } from '../db/schema.js';
import { maybeRegenerateDiagram } from '../diagram/generate.js';

export const saveObservationInputSchema = {
  type: 'object' as const,
  properties: {
    kind: {
      type: 'string' as const,
      enum: ['decision', 'gotcha', 'progress', 'error', 'discovery'],
      description:
        'Type of observation. decision = architecture/library/pattern choice. ' +
        'gotcha = non-obvious lesson learned. progress = closed story/milestone. ' +
        'error = open issue. discovery = codebase finding worth remembering.',
    },
    title: {
      type: 'string' as const,
      description: 'Imperative, ≤ 80 chars.',
    },
    content: {
      type: 'string' as const,
      description: 'WHY first, then WHAT, then HOW.',
    },
    story_local_id: {
      type: 'string' as const,
      description:
        'Optional ID linking this observation to a story (e.g., SHOP-S1.2).',
    },
    files: {
      type: 'string' as const,
      description: 'Optional comma-separated list of file paths touched.',
    },
    tags: {
      type: 'string' as const,
      description: 'Optional comma-separated tags for grouping in search.',
    },
    topic_key: {
      type: 'string' as const,
      description:
        'Optional stable identity for the SUBJECT of this note, shaped like a ' +
        'path: "tracker/time-logging", "architecture/auth-model". Saving again ' +
        'with the same topic_key UPDATES that note instead of adding a rival ' +
        'one — use it for anything that has a current value rather than a ' +
        'history. Call suggest_topic_key first to reuse an existing key.',
    },
    keep_history: {
      type: 'boolean' as const,
      description:
        'With topic_key set, keep the previous note and link it via supersedes ' +
        'instead of overwriting it. Default false.',
    },
  },
  required: ['kind', 'title', 'content'],
};

/** A topic key is a slash-separated path of lowercase slugs. Enforced so
 *  keys stay comparable; free-form keys drift into near-duplicates the same
 *  way free-form context kinds did. */
export const TOPIC_KEY_RE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;

const saveObservationArgsZ = z
  .object({
    kind: z.enum(['decision', 'gotcha', 'progress', 'error', 'discovery']),
    title: z.string().min(1).max(200),
    content: z.string().min(1),
    story_local_id: z.string().min(1).max(50).optional(),
    files: z.string().min(1).optional(),
    tags: z.string().min(1).optional(),
    topic_key: z
      .string()
      .min(1)
      .max(120)
      .regex(
        TOPIC_KEY_RE,
        'topic_key must be lowercase slugs separated by "/" (e.g. "tracker/time-logging")',
      )
      .optional(),
    keep_history: z.boolean().optional(),
  })
  .strict();

export interface SaveObservationResult {
  observationId: number;
  sessionId: number;
  module: { id: number; name: string };
  kind: ObservationKind;
  title: string;
  createdAt: string;
  /** 'updated' when an existing topic row was rewritten. */
  status: 'inserted' | 'updated';
  topicKey?: string;
  hint?: string;
}

export function saveObservation(
  ctx: ServerContext,
  rawArgs: unknown,
): SaveObservationResult {
  const args = saveObservationArgsZ.parse(rawArgs);
  const { sessionId, moduleId } = ctx.requireActiveSession();

  const { row: obs, status } = ctx.db.observations.add({
    sessionId,
    kind: args.kind,
    title: args.title,
    content: args.content,
    storyLocalId: args.story_local_id,
    files: args.files,
    tags: args.tags,
    topicKey: args.topic_key ?? null,
    keepHistory: args.keep_history,
  });

  const module = ctx.db.modules.findById(moduleId)!;

  // Keep the living diagram in sync (best-effort; honours the toggle).
  maybeRegenerateDiagram(ctx);

  return {
    observationId: obs.id,
    sessionId,
    module: { id: module.id, name: module.name },
    kind: obs.kind,
    title: obs.title,
    createdAt: obs.created_at,
    status,
    topicKey: obs.topic_key ?? undefined,
    hint:
      status === 'updated'
        ? `Updated the existing note for topic "${obs.topic_key}" instead of adding a second one.`
        : args.kind === 'progress'
          ? 'Tip: pair this with end_session if the story is done.'
          : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────
// suggest_topic_key
//
// Offers the topic keys already in use before a new one is invented.
// Without this step every session coins its own key for the same subject
// and the update-in-place behaviour never actually triggers — the same
// drift that made free-text context kinds useless.
// ─────────────────────────────────────────────────────────────────────

export const suggestTopicKeyInputSchema = {
  type: 'object' as const,
  properties: {
    title: {
      type: 'string' as const,
      description: 'The title you were about to save.',
    },
    content: {
      type: 'string' as const,
      description: 'Optional body, used to improve the match.',
    },
  },
  required: ['title'],
};

const suggestTopicKeyArgsZ = z
  .object({ title: z.string().min(1), content: z.string().optional() })
  .strict();

export interface TopicSuggestion {
  topicKey: string;
  title: string;
  updatedAt: string | null;
  score: number;
}

export interface SuggestTopicKeyResult {
  existing: TopicSuggestion[];
  proposed: string;
  hint: string;
}

/** Word-overlap score in [0,1] between a query and a candidate string. */
function overlapScore(query: string, candidate: string): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2);
  const q = new Set(norm(query));
  const c = new Set(norm(candidate));
  if (q.size === 0 || c.size === 0) return 0;
  let shared = 0;
  for (const w of q) if (c.has(w)) shared++;
  return shared / Math.min(q.size, c.size);
}

/** Derive a plausible key from a title, as a starting point for the agent. */
export function proposeTopicKey(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter((w) => w.length > 2)
    .slice(0, 4)
    .join('-');
  return slug || 'misc';
}

export function suggestTopicKey(
  ctx: ServerContext,
  rawArgs: unknown,
): SuggestTopicKeyResult {
  const args = suggestTopicKeyArgsZ.parse(rawArgs);
  const project = ctx.requireProject();
  const haystack = `${args.title} ${args.content ?? ''}`;

  const existing = ctx.db.observations
    .listTopicKeys(project.id)
    .map((r) => ({
      topicKey: r.topic_key,
      title: r.title,
      updatedAt: r.updated_at,
      score: Math.max(
        overlapScore(haystack, r.title),
        overlapScore(haystack, r.topic_key.replace(/[/_-]/g, ' ')),
      ),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return {
    existing,
    proposed: proposeTopicKey(args.title),
    hint:
      existing.length > 0
        ? `Reuse "${existing[0].topicKey}" if this note is about the same subject; ` +
          'saving with an existing key updates that note instead of competing with it.'
        : 'No existing topic covers this. Use `proposed`, or omit topic_key if the ' +
          'note is a one-off event rather than a subject with a current value.',
  };
}

// ─────────────────────────────────────────────────────────────────────
// update_progress
//
// Sets the `progress` field of a module_context row identified by its
// localId (or numeric id). Replaces the role of editing a "Smoke" /
// "Commit" column in PROGRESS.md — the agent calls this when the user
// says things like "marcá S3.6 como done" or "actualizá la docu".
// Free-form markdown content; persisted next to the row it describes.
// ─────────────────────────────────────────────────────────────────────

export const updateProgressInputSchema = {
  type: 'object' as const,
  properties: {
    module: {
      type: 'string' as const,
      description:
        'Module name. If omitted, uses the active session\'s module.',
    },
    local_id: {
      type: 'string' as const,
      description:
        'Story localId (e.g. "SHOP-S3.6"). Resolves to the module_context row whose source_path ends with "#<localId>" or whose title contains it.',
    },
    row_id: {
      type: 'number' as const,
      description:
        'Numeric module_context.id. Use when local_id resolution is ambiguous or when targeting non-story rows (workflow/plan/etc.).',
    },
    progress: {
      type: 'string' as const,
      description:
        'Free-form markdown describing current status. Examples: "✅ done batch 2 (2026-05-04) · commits a1b2c3d4,e5f6a7b8 · smoke OK", "🔄 wip · branch checkout-cart-repository", "🔴 blocked · waiting on S3.21 backend". Pass an empty string to clear.',
    },
  },
  required: ['progress'],
};

const updateProgressArgsZ = z
  .object({
    module: z.string().min(1).optional(),
    local_id: z.string().min(1).optional(),
    row_id: z.number().int().positive().optional(),
    progress: z.string(),
  })
  .strict()
  .refine((v) => !!v.local_id || !!v.row_id, {
    message: 'Either local_id or row_id must be provided.',
  });

export interface UpdateProgressResult {
  rowId: number;
  module: { id: number; name: string };
  resolvedFrom: 'row_id' | 'local_id-source_path' | 'local_id-title';
  title: string;
  kind: string;
  source_path: string | null;
  progress: string | null;
  updatedAt: string;
}

export function updateProgress(
  ctx: ServerContext,
  rawArgs: unknown,
): UpdateProgressResult {
  const args = updateProgressArgsZ.parse(rawArgs);

  // Resolve module: explicit name | active session | fail
  let moduleRow;
  if (args.module) {
    moduleRow = ctx.requireModule(args.module);
  } else {
    const active = ctx.activeModuleId;
    if (active === null) {
      throw new MyJarbisError(
        ErrorType.SESSION_NOT_ACTIVE,
        'No active module. Pass `module` explicitly or call start_session first.',
      );
    }
    moduleRow = ctx.db.modules.findById(active)!;
  }

  // Resolve target row
  let target;
  let resolvedFrom: UpdateProgressResult['resolvedFrom'];
  if (args.row_id) {
    target = ctx.db.moduleContext.findById(args.row_id);
    if (!target || target.module_id !== moduleRow.id) {
      throw new MyJarbisError(
        ErrorType.RESOURCE_NOT_FOUND,
        `Row ${args.row_id} not found in module "${moduleRow.name}".`,
      );
    }
    resolvedFrom = 'row_id';
  } else {
    target = ctx.db.moduleContext.findByLocalId(moduleRow.id, args.local_id!);
    if (!target) {
      throw new MyJarbisError(
        ErrorType.RESOURCE_NOT_FOUND,
        `No module_context row in "${moduleRow.name}" matching local_id "${args.local_id}". Try search() first to confirm the id, or pass row_id directly.`,
      );
    }
    resolvedFrom = target.source_path?.endsWith(`#${args.local_id}`)
      ? 'local_id-source_path'
      : 'local_id-title';
  }

  const updated = ctx.db.moduleContext.setProgress(
    target.id,
    args.progress.length === 0 ? null : args.progress,
  );

  // Keep the living diagram in sync (best-effort; honours the toggle).
  maybeRegenerateDiagram(ctx, moduleRow.name);

  return {
    rowId: updated.id,
    module: { id: moduleRow.id, name: moduleRow.name },
    resolvedFrom,
    title: updated.title,
    kind: updated.kind,
    source_path: updated.source_path,
    progress: updated.progress,
    updatedAt: updated.updated_at,
  };
}
