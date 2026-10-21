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
import fs from 'node:fs';
import path from 'node:path';
import { renderModuleMenu, menuStringsFor } from '../menu.js';

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
  /**
   * The menu, already rendered — print it verbatim.
   *
   * Absent when there are no modules. This is the same block the SessionStart
   * pointer refers to, from the same renderer, so the "show me the modules"
   * path and the "a menu exists" path cannot describe different things.
   */
  display?: string;
  hint?: string;
}


/**
 * The project's configured language, for the menu strings.
 *
 * Read here rather than threaded through: `list_modules` is reachable from
 * the MCP server, where no hook has already resolved it. Any failure falls
 * back to English rather than throwing — a menu in the wrong language still
 * lets someone pick a module.
 */
function readProjectLanguage(projectPath: string): string | undefined {
  try {
    const p = path.join(projectPath, '.myjarbis', 'config', 'settings.json');
    if (!fs.existsSync(p)) return undefined;
    const j = JSON.parse(fs.readFileSync(p, 'utf-8')) as { language?: unknown };
    return typeof j.language === 'string' ? j.language : undefined;
  } catch {
    return undefined;
  }
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

  // The SAME block the SessionStart pointer refers to, from the same
  // renderer. `/jarbis` prints this verbatim instead of rebuilding a menu
  // out of `modules[]` — an agent reformatting a nineteen-row list from
  // structured data is exactly the ~28s of reasoning that rendering
  // server-side was introduced to remove (commit 190aef6).
  //
  // The highlight is the most recently CLOSED module, which is the same
  // signal the hook uses for "what was being worked on last".
  let newest: { name: string; ended_at: string } | null = null;
  for (const m of enriched) {
    if (m.lastSessionEndedAt && (!newest || m.lastSessionEndedAt > newest.ended_at)) {
      newest = { name: m.name, ended_at: m.lastSessionEndedAt };
    }
  }

  const display =
    enriched.length === 0
      ? undefined
      : [
          `═══ MyJarbis · ${project.name} ═══`,
          '',
          renderModuleMenu(
            enriched.map((m) => ({
              name: m.name,
              description: m.description,
              status: m.status,
              lastEndedAt: m.lastSessionEndedAt,
            })),
            menuStringsFor(readProjectLanguage(ctx.projectPath)),
            newest?.name ?? null,
            (iso) => iso.replace(' ', 'T').slice(0, 10),
          ),
        ].join('\n');

  return {
    projectName: project.name,
    count: enriched.length,
    modules: enriched,
    display,
    hint:
      enriched.length === 0
        ? `No modules yet. Use create_module(name) to add the first vertical.`
        : 'Print `display` VERBATIM for the user to pick from — do not rebuild it from `modules[]`.',
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
        'Module name. Convention: kebab-case or short identifier matching the vertical (e.g., "checkout", "catalog", "Translations").',
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
