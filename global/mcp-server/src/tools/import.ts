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
  status: 'inserted' | 'updated' | 'unchanged';
  target: string;
  kind: ContextKind;
  title: string;
  source_path: string;
  bytes: number;
  rowId: number;
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
  const title = args.title ?? extractTitle(content, baseName);
  const kind = args.kind as ContextKind;

  const target = parseTarget(args.target);

  if (target.kind === 'project') {
    const r = ctx.db.projectContext.upsert({
      projectId: project.id,
      kind,
      title,
      content,
      tags: args.tags,
      sourcePath,
    });
    return {
      status: r.status,
      target: 'project',
      kind: r.row.kind,
      title: r.row.title,
      source_path: r.row.source_path ?? sourcePath,
      bytes: content.length,
      rowId: r.row.id,
    };
  }

  // module:<name>
  const mod = ctx.requireModule(target.moduleName!);
  const r = ctx.db.moduleContext.upsert({
    moduleId: mod.id,
    kind,
    title,
    content,
    tags: args.tags,
    sourcePath,
  });
  return {
    status: r.status,
    target: `module:${mod.name}`,
    kind: r.row.kind,
    title: r.row.title,
    source_path: r.row.source_path ?? sourcePath,
    bytes: content.length,
    rowId: r.row.id,
  };
}
