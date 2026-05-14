/**
 * Legacy aliases — backwards compatibility for the v0.1 tool names.
 *
 * Old `.claude/commands/*.md` and any external integrations still call:
 *   - search_code(projectName, query, fileTypes?, caseInsensitive?, maxResults?)
 *   - get_context(projectName, topic, maxSize?)
 *   - update_memory(projectName, title, what, why, how, files?, notes?)
 *
 * v0.2 routes them to the new tools:
 *   search_code   → search   (scope='project')
 *   get_context   → search   (scope='project')  — v0.1 returned a curated
 *                              topic-relevant slice; load_module would dump
 *                              the whole module which is wider than the
 *                              caller wants. search() with FTS5 is closer.
 *   update_memory → save_observation (kind='progress', what/why/how
 *                                     concatenated into content)
 *
 * `projectName` is accepted but ignored — the v0.2 server already knows
 * which project it serves (cwd at startup).
 */

import { z } from 'zod';
import { ServerContext } from '../context.js';
import { search } from './search.js';
import { saveObservation } from './observations.js';

// ─────────────────────────────────────────────────────────────────────
// search_code (legacy alias)
// ─────────────────────────────────────────────────────────────────────

export const searchCodeInputSchema = {
  type: 'object' as const,
  properties: {
    projectName: { type: 'string' as const, description: '(legacy) Ignored — server knows the project from cwd.' },
    query: { type: 'string' as const, description: 'Search text.' },
    fileTypes: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: '(legacy) Not applicable — v0.2 search runs over context, not code grep.',
    },
    caseInsensitive: { type: 'boolean' as const, description: '(legacy) FTS5 is case-insensitive by default.' },
    maxResults: { type: 'number' as const, description: 'Max hits to return. Default 50.' },
  },
  required: ['query'],
};

const searchCodeArgsZ = z
  .object({
    projectName: z.string().optional(),
    query: z.string().min(1),
    fileTypes: z.array(z.string()).optional(),
    caseInsensitive: z.boolean().optional(),
    maxResults: z.number().int().positive().optional(),
  })
  .strict();

export function searchCodeAlias(ctx: ServerContext, rawArgs: unknown) {
  const args = searchCodeArgsZ.parse(rawArgs);
  return {
    legacy: 'search_code → search (scope=project)',
    note:
      'v0.1 search_code grepped source files; v0.2 search() runs FTS5 over ' +
      'context entries (project_context + module_context + observations + skills). ' +
      'For raw code grep, use the Bash/Read tools or wait for a future v0.3 grep tool.',
    result: search(ctx, { query: args.query, scope: 'project', limit: args.maxResults }),
  };
}

// ─────────────────────────────────────────────────────────────────────
// get_context (legacy alias)
// ─────────────────────────────────────────────────────────────────────

export const getContextInputSchema = {
  type: 'object' as const,
  properties: {
    projectName: { type: 'string' as const, description: '(legacy) Ignored — server knows the project from cwd.' },
    topic: { type: 'string' as const, description: 'Topic to retrieve curated context about.' },
    maxSize: { type: 'number' as const, description: '(legacy) Approximate cap on returned bytes; v0.2 caps by hit count instead.' },
  },
  required: ['topic'],
};

const getContextArgsZ = z
  .object({
    projectName: z.string().optional(),
    topic: z.string().min(1),
    maxSize: z.number().int().positive().optional(),
  })
  .strict();

export function getContextAlias(ctx: ServerContext, rawArgs: unknown) {
  const args = getContextArgsZ.parse(rawArgs);
  // Convert maxSize bytes (~) into a hit-count cap. v0.1 default 3KB ≈ 30 hits @100 chars excerpt.
  const limit = args.maxSize ? Math.max(1, Math.min(50, Math.round(args.maxSize / 100))) : 30;
  return {
    legacy: 'get_context → search (scope=project)',
    note:
      'v0.2 returns FTS5 hits with snippets; the agent should cherry-pick what it needs. ' +
      'For the full content of a known module, prefer load_module.',
    result: search(ctx, { query: args.topic, scope: 'project', limit }),
  };
}

// ─────────────────────────────────────────────────────────────────────
// update_memory (legacy alias)
// ─────────────────────────────────────────────────────────────────────

export const updateMemoryInputSchema = {
  type: 'object' as const,
  properties: {
    projectName: { type: 'string' as const, description: '(legacy) Ignored — server knows the project from cwd.' },
    title: { type: 'string' as const, description: 'What was implemented.' },
    what: { type: 'string' as const, description: 'Brief description.' },
    why: { type: 'string' as const, description: 'Rationale.' },
    how: { type: 'string' as const, description: 'Implementation details.' },
    files: { type: 'array' as const, items: { type: 'string' as const }, description: 'Files created/modified.' },
    notes: { type: 'string' as const, description: 'Additional notes.' },
  },
  required: ['title', 'what', 'why', 'how'],
};

const updateMemoryArgsZ = z
  .object({
    projectName: z.string().optional(),
    title: z.string().min(1).max(200),
    what: z.string().min(1),
    why: z.string().min(1),
    how: z.string().min(1),
    files: z.array(z.string()).optional(),
    notes: z.string().optional(),
  })
  .strict();

export function updateMemoryAlias(ctx: ServerContext, rawArgs: unknown) {
  const args = updateMemoryArgsZ.parse(rawArgs);

  const sections: string[] = [
    `**What:** ${args.what}`,
    `**Why:** ${args.why}`,
    `**How:** ${args.how}`,
  ];
  if (args.notes) sections.push(`**Notes:** ${args.notes}`);

  return {
    legacy: 'update_memory → save_observation (kind=progress)',
    note:
      'v0.2 split What/Why/How into a single `content` string. ' +
      'For more granular tracking use save_observation directly with kind=' +
      'decision/gotcha/progress/error/discovery.',
    result: saveObservation(ctx, {
      kind: 'progress',
      title: args.title,
      content: sections.join('\n\n'),
      files: args.files?.join(', '),
    }),
  };
}
