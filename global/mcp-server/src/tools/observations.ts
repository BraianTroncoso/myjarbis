/**
 * Observation tool — save_observation.
 *
 * Persists a decision / gotcha / progress / error / discovery under the
 * ACTIVE session. Requires start_session to have been called.
 */

import { z } from 'zod';
import { ServerContext } from '../context.js';
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
