/**
 * Context tools — load_project_core, load_module.
 *
 * Both return the full row content (not an excerpt) so the agent can
 * use the text as-is. start_session also returns a SUMMARIZED form;
 * these tools are the "give me the real thing" version.
 */

import { z } from 'zod';
import { ServerContext } from '../context.js';
import { ContextKind } from '../db/schema.js';

// ─────────────────────────────────────────────────────────────────────
// load_project_core
// ─────────────────────────────────────────────────────────────────────

export const loadProjectCoreInputSchema = {
  type: 'object' as const,
  properties: {
    kinds: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description:
        'Optional filter: only return entries whose kind is in this list ' +
        '(e.g., ["practice", "convention"]). If omitted, returns all kinds.',
    },
  },
  required: [],
};

const loadProjectCoreArgsZ = z
  .object({ kinds: z.array(z.string()).optional() })
  .strict();

export interface ContextEntry {
  id: number;
  kind: ContextKind;
  title: string;
  content: string;
  tags: string | null;
  source_path: string | null;
  /** Only set on module_context rows. NULL on project_context rows. */
  progress?: string | null;
  updated_at: string;
}

export interface LoadProjectCoreResult {
  project: { id: number; name: string };
  count: number;
  entries: ContextEntry[];
}

export function loadProjectCore(
  ctx: ServerContext,
  rawArgs: unknown,
): LoadProjectCoreResult {
  const args = loadProjectCoreArgsZ.parse(rawArgs ?? {});
  const project = ctx.requireProject();
  const all = ctx.db.projectContext.listByProject(project.id);
  const filtered = args.kinds
    ? all.filter((r) => args.kinds!.includes(r.kind))
    : all;
  return {
    project: { id: project.id, name: project.name },
    count: filtered.length,
    entries: filtered.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      content: r.content,
      tags: r.tags,
      source_path: r.source_path,
      updated_at: r.updated_at,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────
// load_module
// ─────────────────────────────────────────────────────────────────────

export const loadModuleInputSchema = {
  type: 'object' as const,
  properties: {
    module: {
      type: 'string' as const,
      description:
        'Module name. If omitted, uses the active module from the current session.',
    },
    kinds: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description:
        'Filter by kind (e.g. ["workflow","plan"]). Combine with full=false to scan an index.',
    },
    row_ids: {
      type: 'array' as const,
      items: { type: 'number' as const },
      description:
        'Explicit list of module_context row IDs to fetch. When provided, returns FULL content of those rows regardless of `full` flag. Use after a search() or an index call to pull the 1-2 rows you actually need.',
    },
    full: {
      type: 'boolean' as const,
      description:
        'Default false. When false, returns excerpts (~240 chars) per entry — safe for browsing the catalog. When true, returns full content of all matching rows. Avoid full=true with broad `kinds` filters on modules with large docs (PROGRESS/WORKFLOW MDs can be 100KB+).',
    },
    limit: {
      type: 'number' as const,
      description:
        'Max rows to return. Default 30 (catalog mode), no limit when row_ids is given.',
    },
  },
  required: [],
};

const loadModuleArgsZ = z
  .object({
    module: z.string().min(1).optional(),
    kinds: z.array(z.string()).optional(),
    row_ids: z.array(z.number().int().positive()).optional(),
    full: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

const MODULE_EXCERPT_LEN = 240;

interface ContextEntryFull extends ContextEntry {
  content: string;
}
interface ContextEntryExcerpt {
  id: number;
  kind: string;
  title: string;
  source_path: string | null;
  tags: string | null;
  progress?: string | null;
  excerpt: string;
  bytes: number;
  updated_at: string;
  /** Set when the entry collapses N chunks of the same source doc. */
  chunks?: number;
  chunk_ids?: number[];
}

export interface LoadModuleResult {
  project: { id: number; name: string };
  module: { id: number; name: string };
  mode: 'index' | 'full';
  count: number;
  total_in_module: number;
  entries: Array<ContextEntryFull | ContextEntryExcerpt>;
  hint?: string;
}

export function loadModule(
  ctx: ServerContext,
  rawArgs: unknown,
): LoadModuleResult {
  const args = loadModuleArgsZ.parse(rawArgs ?? {});
  const project = ctx.requireProject();

  let mod;
  if (args.module) {
    mod = ctx.requireModule(args.module);
  } else {
    const { moduleId } = ctx.requireActiveSession();
    mod = ctx.db.modules.findById(moduleId)!;
  }

  const all = ctx.db.moduleContext.listByModule(mod.id);

  // row_ids: explicit fetch — always full content, ignore filters
  if (args.row_ids && args.row_ids.length > 0) {
    const want = new Set(args.row_ids);
    const picked = all.filter((r) => want.has(r.id));
    return {
      project: { id: project.id, name: project.name },
      module: { id: mod.id, name: mod.name },
      mode: 'full',
      count: picked.length,
      total_in_module: all.length,
      entries: picked.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        content: r.content,
        tags: r.tags,
        source_path: r.source_path,
        progress: r.progress,
        updated_at: r.updated_at,
      })),
      hint: picked.length < args.row_ids.length
        ? `${args.row_ids.length - picked.length} of the requested row_ids did not exist in this module.`
        : undefined,
    };
  }

  // Otherwise: kinds filter + limit, default to index mode (excerpts)
  const filtered = args.kinds
    ? all.filter((r) => args.kinds!.includes(r.kind))
    : all;
  const limit = args.limit ?? 30;
  const sliced = filtered.slice(0, limit);
  const truncated = filtered.length > limit;

  if (args.full === true) {
    // Bulk full mode is dangerous on big modules — surface a warning.
    const totalBytes = sliced.reduce((a, r) => a + r.content.length, 0);
    return {
      project: { id: project.id, name: project.name },
      module: { id: mod.id, name: mod.name },
      mode: 'full',
      count: sliced.length,
      total_in_module: all.length,
      entries: sliced.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        content: r.content,
        tags: r.tags,
        source_path: r.source_path,
        progress: r.progress,
        updated_at: r.updated_at,
      })),
      hint:
        totalBytes > 50_000
          ? `Returned ${(totalBytes / 1024).toFixed(1)}KB across ${sliced.length} entries — that is a lot of context. Consider load_module(row_ids=[...]) for the 1-2 rows you actually need.`
          : truncated
            ? `${filtered.length - limit} more rows match (use row_ids to fetch specific ones).`
            : undefined,
    };
  }

  // Default: index mode — excerpts only.
  const rawEntries: ContextEntryExcerpt[] = sliced.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    source_path: r.source_path,
    tags: r.tags,
    progress: r.progress,
    excerpt:
      r.content.length > MODULE_EXCERPT_LEN
        ? r.content.slice(0, MODULE_EXCERPT_LEN - 1).replace(/\s+/g, ' ').trim() + '…'
        : r.content.replace(/\s+/g, ' ').trim(),
    bytes: r.content.length,
    updated_at: r.updated_at,
  }));
  const entries = collapseChunkedExcerpts(rawEntries);
  return {
    project: { id: project.id, name: project.name },
    module: { id: mod.id, name: mod.name },
    mode: 'index',
    count: entries.length,
    total_in_module: all.length,
    entries,
    hint: truncated
      ? `Showing first ${limit} of ${filtered.length} matching rows (collapsed into ${entries.length} entries when chunks share a source doc). Use search() to narrow, or load_module(row_ids=[...]) once you know which rows you need.`
      : `Index mode (collapsed). Pull a row's full body via load_module(row_ids=[<id>]); for chunked docs use search() to land on the right chunk.`,
  };
}

/** Group chunks of the same source doc into one entry — same logic as
 *  collapseChunkedSummaries() in session.ts. Reads source_path before
 *  the `#` anchor, picks the first chunk's id as the representative,
 *  and lists every chunk id under `chunk_ids`. */
function collapseChunkedExcerpts(
  rows: ContextEntryExcerpt[],
): ContextEntryExcerpt[] {
  const groups = new Map<string, ContextEntryExcerpt[]>();
  const passthrough: ContextEntryExcerpt[] = [];
  for (const r of rows) {
    if (!r.source_path || !r.source_path.includes('#')) {
      passthrough.push(r);
      continue;
    }
    const prefix = r.source_path.slice(0, r.source_path.indexOf('#'));
    const key = `${prefix} ${r.kind}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(r);
    groups.set(key, bucket);
  }
  const collapsed: ContextEntryExcerpt[] = [];
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => a.id - b.id);
    if (bucket.length === 1) {
      collapsed.push(bucket[0]);
      continue;
    }
    const first = bucket[0];
    const totalBytes = bucket.reduce((acc, b) => acc + b.bytes, 0);
    const progressed = bucket.find((b) => b.progress);
    const baseTitle = first.title.includes(' / ')
      ? first.title.slice(0, first.title.indexOf(' / '))
      : first.title;
    const sourcePath = first.source_path!.slice(
      0,
      first.source_path!.indexOf('#'),
    );
    const out: ContextEntryExcerpt = {
      id: first.id,
      kind: first.kind,
      title: baseTitle,
      source_path: sourcePath,
      tags: first.tags,
      excerpt: first.excerpt,
      bytes: totalBytes,
      updated_at: first.updated_at,
      chunks: bucket.length,
      chunk_ids: bucket.map((b) => b.id),
    };
    if (progressed?.progress) out.progress = progressed.progress;
    collapsed.push(out);
  }
  return [...passthrough, ...collapsed].sort((a, b) => a.id - b.id);
}
