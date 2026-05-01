/**
 * Search tool — FTS5 query across project_context, module_context,
 * skills, observations.
 *
 * The scope decides which indexes are queried and how they are filtered:
 *   - module       (default): module_context of active module + project_context
 *   - project      : module_context of all modules + project_context
 *   - module_only  : ONLY the named or active module's module_context
 *   - observations : observations within a module (or whole project)
 *   - skills       : skills (project-level + module-level)
 */

import { z } from 'zod';
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import { SearchScope, SearchHit } from '../db/index.js';

export const searchInputSchema = {
  type: 'object' as const,
  properties: {
    query: {
      type: 'string' as const,
      description:
        'Search text. Treated as a phrase by default (FTS5-quoted). To use ' +
        'FTS5 operators, prefix with "raw:" (TODO v0.3).',
    },
    scope: {
      type: 'string' as const,
      enum: ['module', 'project', 'module_only', 'observations', 'skills'],
      description:
        'Default "module" = active module context + project core. "project" ' +
        'expands to all modules. "module_only" excludes project core. ' +
        '"observations" searches decisions/gotchas/progress. "skills" searches ' +
        'project/module skill content.',
    },
    module: {
      type: 'string' as const,
      description:
        'Override the module to search in (only used by scopes module/' +
        'module_only/observations). If omitted, the active module is used.',
    },
    limit: {
      type: 'number' as const,
      description: 'Max number of hits to return. Default 50.',
    },
  },
  required: ['query'],
};

const searchArgsZ = z
  .object({
    query: z.string().min(1),
    scope: z
      .enum(['module', 'project', 'module_only', 'observations', 'skills'])
      .optional(),
    module: z.string().min(1).optional(),
    limit: z.number().int().positive().max(200).optional(),
  })
  .strict();

export interface SearchResult {
  query: string;
  scope: SearchScope;
  scopeContext: { project: string; module?: string };
  count: number;
  hits: SearchHit[];
}

export function search(ctx: ServerContext, rawArgs: unknown): SearchResult {
  const args = searchArgsZ.parse(rawArgs);
  const project = ctx.requireProject();
  const scope = (args.scope ?? 'module') as SearchScope;

  // Resolve which module the search refers to (if any).
  let moduleId: number | undefined;
  let moduleName: string | undefined;
  const needsModule =
    scope === 'module' || scope === 'module_only' || scope === 'observations';

  if (needsModule) {
    if (args.module) {
      const mod = ctx.requireModule(args.module);
      moduleId = mod.id;
      moduleName = mod.name;
    } else if (ctx.activeModuleId !== null) {
      moduleId = ctx.activeModuleId;
      moduleName = ctx.db.modules.findById(moduleId)?.name;
    } else if (scope === 'module_only') {
      // module_only without active session needs an explicit module.
      throw new MyJarbisError(
        ErrorType.INVALID_INPUT,
        'scope="module_only" requires either an active session or an explicit module argument.',
      );
    } else {
      // module / observations without active session: fall back to project-wide.
      // We still accept the scope but the underlying query won't restrict by module.
    }
  }

  const hits = ctx.db.search(args.query, {
    scope,
    projectId: project.id,
    moduleId,
    limit: args.limit ?? 50,
  });

  return {
    query: args.query,
    scope,
    scopeContext: {
      project: project.name,
      module: moduleName,
    },
    count: hits.length,
    hits,
  };
}
