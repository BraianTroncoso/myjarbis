/**
 * Refs — typed links out of a note, and the idempotency question.
 *
 * External ids used to be recorded in prose. A real next_session line read:
 * "Do not repeat: comments 4-29337 to 4-29341, work item 167-59119 (75 min)".
 * That is the memory being used as an idempotency ledger while having no
 * structure to be one: answering "did I already post this?" meant re-reading
 * a paragraph and trusting your own scan of five-digit numbers.
 *
 * `find_by_ref` turns that into a row lookup. The git log stays the source
 * of truth for commits — what gets stored is the link, never a copy of the
 * message, so the brain cannot drift out of step with the repository.
 */

import { z } from 'zod';
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import { RefKind } from '../db/schema.js';

const REF_KINDS = ['commit', 'mr', 'ticket', 'comment', 'worklog'] as const;

// ─────────────────────────────────────────────────────────────────────
// add_ref
// ─────────────────────────────────────────────────────────────────────

export const addRefInputSchema = {
  type: 'object' as const,
  properties: {
    observation_id: {
      type: 'number' as const,
      description: 'The note this link belongs to (from save_observation).',
    },
    kind: {
      type: 'string' as const,
      enum: [...REF_KINDS],
      description:
        'commit = a git commit. mr = a merge/pull request. ticket = an issue in ' +
        'the tracker. comment = a comment you posted. worklog = time logged.',
    },
    provider: {
      type: 'string' as const,
      description:
        'Where it lives: "git", or the `kind` of the project provider for that ' +
        'role. Keeps "gotchas across every tracker" and "gotchas in this one" ' +
        'as two separate, answerable questions.',
    },
    external_id: {
      type: 'string' as const,
      description: 'The id as that system writes it. This is what find_by_ref matches on.',
    },
    url: { type: 'string' as const, description: 'Optional direct link.' },
  },
  required: ['observation_id', 'kind', 'provider', 'external_id'],
};

const addRefArgsZ = z
  .object({
    observation_id: z.number().int().positive(),
    kind: z.enum(REF_KINDS),
    provider: z.string().min(1).max(60),
    external_id: z.string().min(1).max(200),
    url: z.string().min(1).max(500).optional(),
  })
  .strict();

export interface AddRefResult {
  refId: number;
  observationId: number;
  kind: RefKind;
  provider: string;
  externalId: string;
  hint: string;
}

export function addRef(ctx: ServerContext, rawArgs: unknown): AddRefResult {
  const args = addRefArgsZ.parse(rawArgs);
  ctx.requireProject();

  const obs = ctx.db.observations.findById(args.observation_id);
  if (!obs) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `No observation ${args.observation_id} in this project.`,
    );
  }

  const row = ctx.db.refs.add({
    observationId: args.observation_id,
    kind: args.kind,
    provider: args.provider.toLowerCase(),
    externalId: args.external_id,
    url: args.url ?? null,
  });

  return {
    refId: row.id,
    observationId: row.observation_id,
    kind: row.kind,
    provider: row.provider,
    externalId: row.external_id,
    hint:
      `Linked to "${obs.title}". Before doing this again, call find_by_ref ` +
      `with the same provider and external_id — that is what makes the action idempotent.`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// find_by_ref
// ─────────────────────────────────────────────────────────────────────

export const findByRefInputSchema = {
  type: 'object' as const,
  properties: {
    provider: { type: 'string' as const, description: 'As passed to add_ref.' },
    external_id: { type: 'string' as const, description: 'The id to look for.' },
    kind: {
      type: 'string' as const,
      enum: [...REF_KINDS],
      description: 'Optional, to narrow the match.',
    },
  },
  required: ['provider', 'external_id'],
};

const findByRefArgsZ = z
  .object({
    provider: z.string().min(1),
    external_id: z.string().min(1),
    kind: z.enum(REF_KINDS).optional(),
  })
  .strict();

export interface FindByRefResult {
  /** The answer to "did I already do this?", as a boolean. */
  found: boolean;
  matches: Array<{
    refId: number;
    kind: RefKind;
    observationId: number;
    observationTitle: string;
    url: string | null;
    createdAt: string;
  }>;
  hint: string;
}

export function findByRef(ctx: ServerContext, rawArgs: unknown): FindByRefResult {
  const args = findByRefArgsZ.parse(rawArgs);
  ctx.requireProject();

  const rows = ctx.db.refs.find({
    provider: args.provider.toLowerCase(),
    kind: args.kind,
    externalId: args.external_id,
  });

  return {
    found: rows.length > 0,
    matches: rows.map((r) => ({
      refId: r.id,
      kind: r.kind,
      observationId: r.observation_id,
      observationTitle: r.observation_title,
      url: r.url,
      createdAt: r.created_at,
    })),
    hint:
      rows.length > 0
        ? `Already recorded — do NOT repeat it. See observation ${rows[0].observation_id}: "${rows[0].observation_title}".`
        : 'No record of this. Safe to proceed, then add_ref so the next session knows.',
  };
}

// ─────────────────────────────────────────────────────────────────────
// update_observation
// ─────────────────────────────────────────────────────────────────────

export const updateObservationInputSchema = {
  type: 'object' as const,
  properties: {
    observation_id: {
      type: 'number' as const,
      description: 'Which note to correct. Alternatively pass topic_key.',
    },
    topic_key: {
      type: 'string' as const,
      description: 'Resolve the note by its topic instead of by id.',
    },
    title: { type: 'string' as const, description: 'Replacement title.' },
    content: { type: 'string' as const, description: 'Replacement body.' },
    tags: { type: 'string' as const, description: 'Replacement comma-separated tags.' },
    files: {
      type: 'string' as const,
      description:
        'Replacement comma-separated list of file paths touched. Omit to keep ' +
        'the paths already stored; pass an empty string to clear them.',
    },
    story_local_id: {
      type: 'string' as const,
      description:
        'Re-file the note under a different story (e.g. SHOP-S1.4). Omit to ' +
        'keep the current one; pass an empty string to unfile it.',
    },
    kind: {
      type: 'string' as const,
      enum: ['decision', 'gotcha', 'progress', 'error', 'discovery'],
      description: 'Re-type the note.',
    },
  },
};

const updateObservationArgsZ = z
  .object({
    observation_id: z.number().int().positive().optional(),
    topic_key: z.string().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
    content: z.string().min(1).optional(),
    tags: z.string().optional(),
    // `save_observation` takes files as `z.string().min(1)`: there, an empty
    // value and an absent one mean the same thing, so min(1) costs nothing.
    // Here they must differ — see the `files` handling below — so the floor is
    // dropped and the empty string is given a meaning instead of rejected.
    files: z.string().optional(),
    // Same empty-means-clear channel as `files`: a note filed against the
    // wrong story is as wrong as one with the wrong paths, and both were
    // uncorrectable for the same reason.
    story_local_id: z.string().optional(),
    kind: z.enum(['decision', 'gotcha', 'progress', 'error', 'discovery']).optional(),
  })
  .strict()
  .refine((a) => a.observation_id !== undefined || a.topic_key !== undefined, {
    message: 'pass either observation_id or topic_key',
  })
  .refine(
    (a) =>
      a.title !== undefined ||
      a.content !== undefined ||
      a.tags !== undefined ||
      a.files !== undefined ||
      a.story_local_id !== undefined ||
      a.kind !== undefined,
    { message: 'nothing to update' },
  );

export interface UpdateObservationResult {
  observationId: number;
  title: string;
  /** Echoed back because nothing else in the tool surface shows it: a wrong
   *  `files` value is invisible until something reads the row directly, which
   *  is how one came to be wrong for a whole project's lifetime. */
  files: string | null;
  /** Echoed for the same reason as `files`: a note filed against the wrong
   *  story is invisible until something queries by story. */
  storyLocalId: string | null;
  updatedAt: string | null;
  hint: string;
}

/**
 * Correct a note in place.
 *
 * The alternative, which is what actually happened for lack of this tool,
 * is a new note whose title carries the correction: "CORRECTS note 80",
 * "DEFINITIVE — supersedes 80 and 81", "RESUME HERE — replaces all previous
 * ones". Six of those were found in one brain. Each one leaves a competing
 * version in place and pushes the reconciliation onto whoever reads next.
 *
 * `files` was missing from this tool for a release, so a note saved with the
 * wrong paths stayed wrong: the only remedy was to spell the right paths out
 * in the prose and leave the column lying. A column nobody can correct is
 * worse than no column — it reads as authoritative.
 */
export function updateObservation(
  ctx: ServerContext,
  rawArgs: unknown,
): UpdateObservationResult {
  const args = updateObservationArgsZ.parse(rawArgs);
  const project = ctx.requireProject();

  const existing =
    args.observation_id !== undefined
      ? ctx.db.observations.findById(args.observation_id)
      : ctx.db.observations.findByTopic(project.id, args.topic_key!);

  if (!existing) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      args.observation_id !== undefined
        ? `No observation ${args.observation_id} in this project.`
        : `No observation with topic_key "${args.topic_key}". Call suggest_topic_key ` +
            `to see which topics exist.`,
    );
  }

  // Omitted vs. empty, decided here rather than left to the DB layer:
  //
  //   omitted      → preserve. Every other field of this tool works that way,
  //                  and `files` is the one correcting a title should never
  //                  touch. Treating absence as "clear" would turn the routine
  //                  fix of a typo into silent path loss.
  //   empty string → clear, stored as NULL. `save_observation` writes NULL for
  //                  "no paths", so clearing must land on NULL too or the
  //                  column ends up with two different kinds of nothing; the
  //                  precedent is update_progress, which clears the same way.
  //
  // Paths are stored verbatim, exactly as `save_observation` stores them — the
  // readers that care (diagram generation) split on "," and trim themselves,
  // and normalising on only one of the two write paths would make the same
  // input produce two different rows.
  //
  // `topic_key` stays read-only, and that is a decision rather than an
  // omission: it is UNIQUE per project, and `save_observation` already treats
  // writing an existing topic_key as "update that note". So "re-key this note
  // to a topic that exists" has two defensible meanings — merge into the other
  // note, or refuse — and picking one silently is how two notes become one
  // without anybody asking. Until that is designed, re-keying is a
  // `save_observation` with the target key.
  const row = ctx.db.observations.update(existing.id, {
    title: args.title,
    content: args.content,
    tags: args.tags,
    kind: args.kind,
    files: args.files === undefined ? undefined : args.files.length === 0 ? null : args.files,
    story_local_id:
      args.story_local_id === undefined
        ? undefined
        : args.story_local_id.length === 0
          ? null
          : args.story_local_id,
  });

  return {
    observationId: row.id,
    title: row.title,
    files: row.files,
    storyLocalId: row.story_local_id,
    updatedAt: row.updated_at,
    hint:
      'Corrected in place. No second note was created, so there is nothing for ' +
      'the next session to reconcile.',
  };
}
