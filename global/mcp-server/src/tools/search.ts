/**
 * Search tool — FTS5 query across project_context, module_context,
 * skills, observations.
 *
 * The scope decides which indexes are queried and how they are filtered:
 *   - module       (default): module_context of the OPEN modules (primary plus
 *                  any companions) + project_context
 *   - project      : module_context of all modules + project_context
 *   - module_only  : ONLY the named or active module's module_context
 *   - observations : observations within the open modules (or whole project)
 *   - skills       : skills (project-level + module-level)
 *
 * "The open modules" is usually one. When the user opened several together
 * (see activeModules.ts) the default scope follows the set, because that set
 * IS what they called the active context — see the comment at the companion
 * resolution below.
 */

import { z } from 'zod';
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import { SearchScope, SearchHit } from '../db/index.js';
import { readCompanionModules } from '../activeModules.js';

export const searchInputSchema = {
  type: 'object' as const,
  properties: {
    query: {
      type: 'string' as const,
      description:
        'Search text. Multiple words are AND-ed (all must appear in the row, ' +
        'in any order or position). Wrap part of the query in double quotes to ' +
        'require an exact phrase. Prefix the whole query with "raw:" to pass ' +
        'FTS5 syntax through verbatim (NEAR, OR, column filters). Accents are ' +
        'folded, so "sangria" and "sangría" are equivalent.',
    },
    scope: {
      type: 'string' as const,
      enum: ['module', 'project', 'module_only', 'observations', 'skills'],
      description:
        'Default "module" = the open modules (primary + any companions) + ' +
        'project core. "project" expands to all modules. "module_only" is one ' +
        'module and excludes project core. "observations" searches ' +
        'decisions/gotchas/progress. "skills" searches project/module skill ' +
        'content. Which modules were actually searched comes back in ' +
        'scopeContext.',
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
  scopeContext: { project: string; module?: string; companions?: string[] };
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

  // Companion modules widen the default scope, and only the default scope.
  //
  // "Default scope = the active module" is the rule that keeps a search from
  // dragging in half the project. When the user opened several modules
  // together, the active context IS the set — a search bounded to the primary
  // would hide exactly the rows they asked to have open, and they would widen
  // to scope="project" instead, which is worse than what they wanted.
  //
  // Deliberately not applied when:
  //   · `module` was passed — an explicit module is an explicit answer;
  //   · scope is `module_only`, whose whole purpose is one module;
  //   · scope is `project`, already wider than this.
  let moduleIds: number[] | undefined;
  let companionNames: string[] = [];
  if ((scope === 'module' || scope === 'observations') && !args.module && moduleId !== undefined) {
    const resolved: number[] = [moduleId];
    for (const name of readCompanionModules(ctx.projectPath)) {
      const m = ctx.db.modules.findByName(project.id, name);
      // A stale name in `.myjarbis/active` is ignored rather than fatal: the
      // session-start hook already warns about it, and a search is the wrong
      // place to relitigate the selection.
      if (m && m.id !== moduleId) {
        resolved.push(m.id);
        companionNames.push(m.name);
      }
    }
    if (resolved.length > 1) moduleIds = resolved;
  }

  // No projectId here on purpose: the tenant filter lives on the
  // connection (see MyJarbisDB.bindScope), so it cannot be omitted.
  const hits = ctx.db.search(args.query, {
    scope,
    moduleId,
    moduleIds,
    limit: args.limit ?? 50,
  });

  return {
    query: args.query,
    scope,
    scopeContext: {
      project: project.name,
      module: moduleName,
      // Named in the response so a hit from a companion is explainable rather
      // than surprising: the agent can say which modules were searched.
      companions: companionNames.length > 0 ? companionNames : undefined,
    },
    count: hits.length,
    hits,
  };
}
