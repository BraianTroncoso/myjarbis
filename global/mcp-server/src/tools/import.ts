/**
 * Bootstrap import tools — import_md, import_json.
 *
 * Read a .md or .json file and insert its content into the schema as
 * project_context or module_context entries. Hash-based idempotency:
 * re-importing the same file with the same content is a no-op; with
 * changed content, an UPDATE.
 *
 * The `target` argument decides where the entries land:
 *   - "project"          → project_context of the active project
 *   - "module:<name>"    → module_context of the named module
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import { ContextKind } from '../db/schema.js';
import { chunkMarkdown } from '../utils/chunk.js';

// ─────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────

const TARGET_REGEX = /^(project|module:[\w\- ]+)$/;

interface ResolvedTarget {
  kind: 'project' | 'module';
  moduleName?: string;
}

function parseTarget(raw: string): ResolvedTarget {
  if (raw === 'project') return { kind: 'project' };
  if (raw.startsWith('module:')) {
    const name = raw.slice('module:'.length).trim();
    if (!name) {
      throw new MyJarbisError(
        ErrorType.INVALID_INPUT,
        'target "module:" requires a module name (e.g., "module:MM").',
      );
    }
    return { kind: 'module', moduleName: name };
  }
  throw new MyJarbisError(
    ErrorType.INVALID_INPUT,
    `Invalid target "${raw}". Use "project" or "module:<name>".`,
  );
}

function resolveImportPath(ctx: ServerContext, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ctx.projectPath, p);
}

function relativeFromProject(ctx: ServerContext, abs: string): string {
  const rel = path.relative(ctx.projectPath, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? abs : rel;
}

function extractTitle(content: string, fallback: string): string {
  // First markdown heading (# Title)
  const m = content.match(/^#\s+(.+?)\s*$/m);
  if (m) return m[1].trim().slice(0, 200);
  // First non-empty line
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (t) return t.slice(0, 200);
  }
  return fallback;
}

// ─────────────────────────────────────────────────────────────────────
// import_md
// ─────────────────────────────────────────────────────────────────────

export const importMdInputSchema = {
  type: 'object' as const,
  properties: {
    path: {
      type: 'string' as const,
      description:
        'Path to the .md file. Absolute, or relative to the project root.',
    },
    target: {
      type: 'string' as const,
      description:
        '"project" → project_context of the active project. ' +
        '"module:<name>" → module_context of the named module.',
    },
    kind: {
      type: 'string' as const,
      description:
        'Kind of context entry: practice | dependency | convention | ' +
        'functional_spec | jira_rules | error_log | design_guideline | ' +
        'workflow | plan | functional_doc | use_cases | acceptance_criteria | ' +
        'story | other.',
    },
    tags: {
      type: 'string' as const,
      description: 'Optional comma-separated tags.',
    },
    title: {
      type: 'string' as const,
      description:
        'Optional title override. If omitted, uses the first # heading of ' +
        'the file, or the filename without extension.',
    },
  },
  required: ['path', 'target', 'kind'],
};

const importMdArgsZ = z
  .object({
    path: z.string().min(1),
    target: z.string().regex(TARGET_REGEX, 'use "project" or "module:<name>"'),
    kind: z.string().min(1).max(40),
    tags: z.string().optional(),
    title: z.string().min(1).max(200).optional(),
  })
  .strict();

export interface ImportResult {
  /** Aggregated status across all chunks: `inserted` if any chunk was
   *  newly created, else `updated` if any chunk changed, else `unchanged`. */
  status: 'inserted' | 'updated' | 'unchanged';
  target: string;
  kind: ContextKind;
  title: string;
  source_path: string;
  bytes: number;
  /** Number of rows written. 1 for short documents (chunking off). */
  chunks: number;
  /** Per-chunk row ids in insertion order. */
  rowIds: number[];
  /** First chunk's row id, kept for back-compat with callers that
   *  expected a single id. */
  rowId: number;
}

function aggregateStatus(
  statuses: Array<'inserted' | 'updated' | 'unchanged'>,
): 'inserted' | 'updated' | 'unchanged' {
  if (statuses.some((s) => s === 'inserted')) return 'inserted';
  if (statuses.some((s) => s === 'updated')) return 'updated';
  return 'unchanged';
}

export function importMd(ctx: ServerContext, rawArgs: unknown): ImportResult {
  const args = importMdArgsZ.parse(rawArgs);
  const project = ctx.requireProject();

  const abs = resolveImportPath(ctx, args.path);
  if (!fs.existsSync(abs)) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `File not found: ${abs}`,
      { resolvedPath: abs, projectPath: ctx.projectPath },
    );
  }

  const content = fs.readFileSync(abs, 'utf-8');
  const sourcePath = relativeFromProject(ctx, abs);
  const baseName = path.basename(abs, path.extname(abs));
  const baseTitle = args.title ?? extractTitle(content, baseName);
  const kind = args.kind as ContextKind;

  const target = parseTarget(args.target);
  const chunks = chunkMarkdown(content);

  // For short docs the helper returns a single chunk with an empty slug;
  // the row keeps the original source_path and the user-provided (or
  // extracted) title, so the on-disk shape stays identical to pre-chunking.
  const rowIds: number[] = [];
  const statuses: Array<'inserted' | 'updated' | 'unchanged'> = [];

  ctx.db.tx(() => {
    for (const chunk of chunks) {
      const chunkPath = chunk.slug ? `${sourcePath}#${chunk.slug}` : sourcePath;
      const chunkTitle =
        chunk.slug && args.title === undefined ? chunk.title : args.title ?? chunk.title;
      const r =
        target.kind === 'project'
          ? ctx.db.projectContext.upsert({
              projectId: project.id,
              kind,
              title: chunkTitle,
              content: chunk.content,
              tags: args.tags,
              sourcePath: chunkPath,
            })
          : ctx.db.moduleContext.upsert({
              moduleId: ctx.requireModule(target.moduleName!).id,
              kind,
              title: chunkTitle,
              content: chunk.content,
              tags: args.tags,
              sourcePath: chunkPath,
            });
      rowIds.push(r.row.id);
      statuses.push(r.status);
    }
  });

  // Resolve target label after the transaction; for module imports we
  // hit requireModule above but want the canonical name for the output.
  const targetLabel =
    target.kind === 'project'
      ? 'project'
      : `module:${ctx.requireModule(target.moduleName!).name}`;

  return {
    status: aggregateStatus(statuses),
    target: targetLabel,
    kind,
    title: baseTitle,
    source_path: sourcePath,
    bytes: content.length,
    chunks: chunks.length,
    rowIds,
    rowId: rowIds[0],
  };
}

// ─────────────────────────────────────────────────────────────────────
// import_json
// ─────────────────────────────────────────────────────────────────────

export const importJsonInputSchema = {
  type: 'object' as const,
  properties: {
    path: {
      type: 'string' as const,
      description: 'Path to the .json file. Absolute or relative to the project root.',
    },
    target: {
      type: 'string' as const,
      description: '"project" or "module:<name>".',
    },
    kind: {
      type: 'string' as const,
      description:
        'Kind to assign to each generated context entry (e.g., "story" for ' +
        'a Jira bulk export).',
    },
    mapping: {
      type: 'string' as const,
      description:
        'Path-like selector pointing to the array to iterate. Examples: ' +
        '"stories[]" (root.stories[]), "data.items[]" (root.data.items[]). ' +
        'Without "[]" the value is treated as a single object and inserted as one row.',
    },
    id_field: {
      type: 'string' as const,
      description:
        'Field name used as stable identifier for re-import idempotency. ' +
        'If omitted, auto-detects: localId → id → key → name. Falls back to ' +
        'the item index (re-import is brittle if the array order changes).',
    },
    title_field: {
      type: 'string' as const,
      description:
        'Field name to use as the title. If omitted, auto-detects: ' +
        'localId → id → name → title → summary → first key found.',
    },
    tags: {
      type: 'string' as const,
      description: 'Optional comma-separated tags applied to every imported entry.',
    },
  },
  required: ['path', 'target', 'kind', 'mapping'],
};

const importJsonArgsZ = z
  .object({
    path: z.string().min(1),
    target: z.string().regex(TARGET_REGEX),
    kind: z.string().min(1).max(40),
    mapping: z.string().min(1),
    id_field: z.string().min(1).optional(),
    title_field: z.string().min(1).optional(),
    tags: z.string().optional(),
  })
  .strict();

export interface ImportJsonResult {
  target: string;
  kind: ContextKind;
  source_path: string;
  total: number;
  inserted: number;
  updated: number;
  unchanged: number;
  missing_id_count: number;
  sample: Array<{ id: string; title: string; status: 'inserted' | 'updated' | 'unchanged' }>;
}

export function importJson(ctx: ServerContext, rawArgs: unknown): ImportJsonResult {
  const args = importJsonArgsZ.parse(rawArgs);
  const project = ctx.requireProject();

  const abs = resolveImportPath(ctx, args.path);
  if (!fs.existsSync(abs)) {
    throw new MyJarbisError(ErrorType.INVALID_INPUT, `File not found: ${abs}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(abs, 'utf-8'));
  } catch (err) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `Invalid JSON in ${abs}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const items = resolveMapping(data, args.mapping);
  const sourcePathBase = relativeFromProject(ctx, abs);
  const target = parseTarget(args.target);
  const kind = args.kind as ContextKind;

  let mod: ReturnType<typeof ctx.requireModule> | undefined;
  if (target.kind === 'module') {
    mod = ctx.requireModule(target.moduleName!);
  }

  const stats = {
    total: items.length,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    missing_id_count: 0,
  };
  const sample: ImportJsonResult['sample'] = [];

  ctx.db.tx(() => {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (typeof item !== 'object' || item === null) continue;

      const obj = item as Record<string, unknown>;
      const id = pickId(obj, args.id_field);
      const title = pickTitle(obj, args.title_field, id ?? `item-${i}`);
      const content = renderItem(obj);
      const finalId = id ?? `index-${i}`;
      if (!id) stats.missing_id_count++;

      const sourcePath = `${sourcePathBase}#${finalId}`;

      const r =
        target.kind === 'project'
          ? ctx.db.projectContext.upsert({
              projectId: project.id,
              kind,
              title,
              content,
              tags: args.tags,
              sourcePath,
            })
          : ctx.db.moduleContext.upsert({
              moduleId: mod!.id,
              kind,
              title,
              content,
              tags: args.tags,
              sourcePath,
            });

      if (r.status === 'inserted') stats.inserted++;
      else if (r.status === 'updated') stats.updated++;
      else stats.unchanged++;

      if (sample.length < 5) {
        sample.push({ id: finalId, title, status: r.status });
      }
    }
  });

  return {
    target: target.kind === 'project' ? 'project' : `module:${mod!.name}`,
    kind,
    source_path: sourcePathBase,
    ...stats,
    sample,
  };
}

// ─────────────────────────────────────────────────────────────────────
// import_json helpers
// ─────────────────────────────────────────────────────────────────────

/** Resolve a "stories[]" or "data.items[]" mapping into the array. */
function resolveMapping(data: unknown, mapping: string): unknown[] {
  const isArrayLike = mapping.endsWith('[]');
  const segPath = isArrayLike ? mapping.slice(0, -2) : mapping;
  const segments = segPath
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  let cur: unknown = data;
  for (const seg of segments) {
    if (cur === null || typeof cur !== 'object') {
      throw new MyJarbisError(
        ErrorType.INVALID_INPUT,
        `Mapping "${mapping}" cannot resolve segment "${seg}" (parent is not an object).`,
      );
    }
    cur = (cur as Record<string, unknown>)[seg];
  }

  if (isArrayLike) {
    if (!Array.isArray(cur)) {
      throw new MyJarbisError(
        ErrorType.INVALID_INPUT,
        `Mapping "${mapping}" expected an array but got ${typeof cur}.`,
      );
    }
    return cur;
  }
  return [cur];
}

const ID_CANDIDATES = ['localId', 'local_id', 'id', 'key', 'name'];

function pickId(obj: Record<string, unknown>, explicit?: string): string | null {
  const probe = (k: string): string | null => {
    const v = obj[k];
    return typeof v === 'string' || typeof v === 'number' ? String(v) : null;
  };
  if (explicit) return probe(explicit);
  for (const k of ID_CANDIDATES) {
    const v = probe(k);
    if (v) return v;
  }
  return null;
}

const TITLE_CANDIDATES = ['title', 'name', 'summary', 'localId', 'local_id', 'id', 'key'];

function pickTitle(obj: Record<string, unknown>, explicit: string | undefined, fallback: string): string {
  const probe = (k: string): string | null => {
    const v = obj[k];
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null;
  };
  if (explicit) {
    const v = probe(explicit);
    if (v) return v;
  }
  for (const k of TITLE_CANDIDATES) {
    const v = probe(k);
    if (v) return v;
  }
  return fallback;
}

/**
 * Render a JSON item as a readable markdown document. Top-level scalar/array
 * fields become "**key:** value" lines; objects become indented JSON for
 * inspectability without being too verbose.
 */
function renderItem(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      // Long strings get a fenced block; short ones inline.
      if (v.length > 200 || v.includes('\n')) {
        lines.push(`**${k}:**\n${v.trim()}`);
      } else {
        lines.push(`**${k}:** ${v}`);
      }
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      lines.push(`**${k}:** ${v}`);
    } else if (Array.isArray(v)) {
      if (v.length === 0) continue;
      if (v.every((e) => typeof e === 'string' || typeof e === 'number')) {
        lines.push(`**${k}:** ${v.join(', ')}`);
      } else {
        lines.push(`**${k}:**\n\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\``);
      }
    } else if (typeof v === 'object') {
      lines.push(`**${k}:**\n\`\`\`json\n${JSON.stringify(v, null, 2)}\n\`\`\``);
    }
  }
  return lines.join('\n\n');
}
