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
        'Optional filter: only return entries whose kind is in this list.',
    },
  },
  required: [],
};

const loadModuleArgsZ = z
  .object({
    module: z.string().min(1).optional(),
    kinds: z.array(z.string()).optional(),
  })
  .strict();

export interface LoadModuleResult {
  project: { id: number; name: string };
  module: { id: number; name: string };
  count: number;
  entries: ContextEntry[];
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
  const filtered = args.kinds
    ? all.filter((r) => args.kinds!.includes(r.kind))
    : all;

  return {
    project: { id: project.id, name: project.name },
    module: { id: mod.id, name: mod.name },
    count: filtered.length,
    entries: filtered.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      content: r.content,
      tags: r.tags,
      source_path: r.source_path,
      progress: r.progress,
      updated_at: r.updated_at,
    })),
  };
}
