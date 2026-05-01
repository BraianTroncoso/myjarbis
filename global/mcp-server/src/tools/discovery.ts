/**
 * Discovery tools — current_project, list_modules, create_module.
 *
 * These three tools are the entry points the agent uses at session
 * start to figure out where it is and what verticals exist. They are
 * the only tools that work BEFORE start_session has been called
 * (because start_session itself depends on knowing which module).
 */

import { z } from 'zod';
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import { ModuleStatus } from '../db/schema.js';

// ─────────────────────────────────────────────────────────────────────
// current_project
// ─────────────────────────────────────────────────────────────────────

export const currentProjectInputSchema = {
  type: 'object' as const,
  properties: {},
  required: [],
};

export interface CurrentProjectResult {
  registered: boolean;
  cwd: string;
  project?: {
    id: number;
    name: string;
    path: string;
    framework: string | null;
    created_at: string;
    moduleCount: number;
  };
  hint?: string;
}

export function currentProject(ctx: ServerContext): CurrentProjectResult {
  const project = ctx.project;
  if (!project) {
    return {
      registered: false,
      cwd: ctx.projectPath,
      hint: `No MyJarbis project registered at ${ctx.projectPath}. Run 'myjarbis init' from the project root.`,
    };
  }
  const modules = ctx.db.modules.listByProject(project.id);
  return {
    registered: true,
    cwd: ctx.projectPath,
    project: {
      id: project.id,
      name: project.name,
      path: project.path,
      framework: project.framework,
      created_at: project.created_at,
      moduleCount: modules.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// list_modules
// ─────────────────────────────────────────────────────────────────────

export const listModulesInputSchema = {
  type: 'object' as const,
  properties: {
    include_status: {
      type: 'array' as const,
      items: { type: 'string' as const, enum: ['active', 'paused', 'done'] },
      description:
        'Filter by status. Default: ["active", "paused"] — done modules are hidden unless requested.',
    },
  },
  required: [],
};

const listModulesArgsZ = z
  .object({
    include_status: z
      .array(z.enum(['active', 'paused', 'done']))
      .optional(),
  })
  .strict();

export interface ListedModule {
  id: number;
  name: string;
  description: string | null;
  status: ModuleStatus;
  created_at: string;
  lastSessionEndedAt: string | null;
  hasNextSession: boolean;
}

export interface ListModulesResult {
  projectName: string;
  count: number;
  modules: ListedModule[];
  hint?: string;
}

export function listModules(
  ctx: ServerContext,
  rawArgs: unknown,
): ListModulesResult {
  const args = listModulesArgsZ.parse(rawArgs ?? {});
  const project = ctx.requireProject();

  const include = new Set<ModuleStatus>(
    (args.include_status ?? ['active', 'paused']) as ModuleStatus[],
  );

  const all = ctx.db.modules.listByProject(project.id);
  const filtered = all.filter((m) => include.has(m.status));

  const enriched: ListedModule[] = filtered.map((m) => {
    const last = ctx.db.sessions.findLastClosedByModule(m.id);
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      status: m.status,
      created_at: m.created_at,
      lastSessionEndedAt: last?.ended_at ?? null,
      hasNextSession: !!(last && last.next_session),
    };
  });

  return {
    projectName: project.name,
    count: enriched.length,
    modules: enriched,
    hint:
      enriched.length === 0
        ? `No modules yet. Use create_module(name) to add the first vertical.`
        : undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────
// create_module
// ─────────────────────────────────────────────────────────────────────

export const createModuleInputSchema = {
  type: 'object' as const,
  properties: {
    name: {
      type: 'string' as const,
      description:
        'Module name. Convention: kebab-case or short identifier matching the vertical (e.g., "MM", "PageBuilder", "Translations").',
    },
    description: {
      type: 'string' as const,
      description: 'Optional one-liner describing what this vertical covers.',
    },
  },
  required: ['name'],
};

const createModuleArgsZ = z
  .object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
  })
  .strict();

export interface CreateModuleResult {
  created: boolean;
  module: {
    id: number;
    name: string;
    description: string | null;
    status: ModuleStatus;
    created_at: string;
  };
  hint?: string;
}

export function createModule(
  ctx: ServerContext,
  rawArgs: unknown,
): CreateModuleResult {
  const args = createModuleArgsZ.parse(rawArgs);
  const project = ctx.requireProject();

  const existing = ctx.db.modules.findByName(project.id, args.name);
  if (existing) {
    throw new MyJarbisError(
      ErrorType.INVALID_INPUT,
      `Module "${args.name}" already exists in project "${project.name}".`,
      { projectName: project.name, moduleName: args.name },
    );
  }

  const created = ctx.db.modules.create(project.id, args.name, args.description);
  return {
    created: true,
    module: {
      id: created.id,
      name: created.name,
      description: created.description,
      status: created.status,
      created_at: created.created_at,
    },
    hint: `Module "${created.name}" created. Use start_session("${created.name}") to begin work.`,
  };
}
