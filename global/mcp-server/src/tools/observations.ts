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
        'Optional ID linking this observation to a story (e.g., MM-S1.2).',
    },
    files: {
      type: 'string' as const,
      description: 'Optional comma-separated list of file paths touched.',
    },
    tags: {
      type: 'string' as const,
      description: 'Optional comma-separated tags for grouping in search.',
    },
  },
  required: ['kind', 'title', 'content'],
};

const saveObservationArgsZ = z
  .object({
    kind: z.enum(['decision', 'gotcha', 'progress', 'error', 'discovery']),
    title: z.string().min(1).max(200),
    content: z.string().min(1),
    story_local_id: z.string().min(1).max(50).optional(),
    files: z.string().min(1).optional(),
    tags: z.string().min(1).optional(),
  })
  .strict();

export interface SaveObservationResult {
  observationId: number;
  sessionId: number;
  module: { id: number; name: string };
  kind: ObservationKind;
  title: string;
  createdAt: string;
  hint?: string;
}

export function saveObservation(
  ctx: ServerContext,
  rawArgs: unknown,
): SaveObservationResult {
  const args = saveObservationArgsZ.parse(rawArgs);
  const { sessionId, moduleId } = ctx.requireActiveSession();

  const obs = ctx.db.observations.add({
    sessionId,
    kind: args.kind,
    title: args.title,
    content: args.content,
    storyLocalId: args.story_local_id,
    files: args.files,
    tags: args.tags,
  });

  const module = ctx.db.modules.findById(moduleId)!;

  return {
    observationId: obs.id,
    sessionId,
    module: { id: module.id, name: module.name },
    kind: obs.kind,
    title: obs.title,
    createdAt: obs.created_at,
    hint:
      args.kind === 'progress'
        ? 'Tip: pair this with end_session if the story is done.'
        : undefined,
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
        'Story localId (e.g. "MM-S3.6"). Resolves to the module_context row whose source_path ends with "#<localId>" or whose title contains it.',
    },
    row_id: {
      type: 'number' as const,
      description:
        'Numeric module_context.id. Use when local_id resolution is ambiguous or when targeting non-story rows (workflow/plan/etc.).',
    },
    progress: {
      type: 'string' as const,
      description:
        'Free-form markdown describing current status. Examples: "✅ done batch 2 (2026-05-04) · commits 8c75a075,845014ef · smoke OK", "🔄 wip · branch mm-bt-repository", "🔴 blocked · waiting on S3.21 backend". Pass an empty string to clear.',
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
