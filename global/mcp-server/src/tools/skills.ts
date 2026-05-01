/**
 * Skills tools — list_skills, add_skill, materialize_skills.
 *
 * Skills live in the `skills` table:
 *   - project-level: module_id IS NULL  (always loaded for that project)
 *   - module-level:  module_id NOT NULL (only loaded when that module is active)
 *
 * `materialize_skills` writes the relevant set to
 *   <projectPath>/.claude/skills/myjarbis-<name>/SKILL.md
 * and removes any stale `myjarbis-*` skill folders that are no longer in
 * the active set (e.g., when switching modules).
 *
 * The `myjarbis-` prefix marks skill folders we manage, so user-authored
 * skills under .claude/skills/ are never touched.
 */

import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { ServerContext } from '../context.js';
import { MyJarbisError, ErrorType } from '../types.js';
import { SkillRow } from '../db/schema.js';

const MANAGED_PREFIX = 'myjarbis-';

// ─────────────────────────────────────────────────────────────────────
// list_skills
// ─────────────────────────────────────────────────────────────────────

export const listSkillsInputSchema = {
  type: 'object' as const,
  properties: {
    scope: {
      type: 'string' as const,
      enum: ['all', 'project', 'module', 'session'],
      description:
        '"all" (default): every skill of this project. ' +
        '"project": only project-level. ' +
        '"module": skills attached to a specific module (requires `module`). ' +
        '"session": skills the active session would materialize (project-level + active module).',
    },
    module: {
      type: 'string' as const,
      description: 'Module name (used by scope="module").',
    },
    only_enabled: {
      type: 'boolean' as const,
      description: 'If true, hide skills with enabled=0. Default false.',
    },
  },
  required: [],
};

const listSkillsArgsZ = z
  .object({
    scope: z.enum(['all', 'project', 'module', 'session']).optional(),
    module: z.string().min(1).optional(),
    only_enabled: z.boolean().optional(),
  })
  .strict();

export interface ListedSkill {
  id: number;
  name: string;
  description: string | null;
  trigger_pattern: string | null;
  module: string | null; // null = project-level
  enabled: boolean;
  bytes: number;
  updated_at: string;
}

export interface ListSkillsResult {
  scope: string;
  count: number;
  skills: ListedSkill[];
}

export function listSkills(ctx: ServerContext, rawArgs: unknown): ListSkillsResult {
  const args = listSkillsArgsZ.parse(rawArgs ?? {});
  const project = ctx.requireProject();
  const scope = args.scope ?? 'all';

  let rows: SkillRow[];
  switch (scope) {
    case 'all':
      rows = ctx.db.skills.listByProject(project.id);
      break;
    case 'project':
      rows = ctx.db.skills.listByProject(project.id, { onlyProjectLevel: true });
      break;
    case 'module': {
      if (!args.module) {
        throw new MyJarbisError(
          ErrorType.INVALID_INPUT,
          'scope="module" requires a `module` argument.',
        );
      }
      const m = ctx.requireModule(args.module);
      rows = ctx.db.skills.listByModule(m.id);
      break;
    }
    case 'session': {
      if (ctx.activeModuleId === null) {
        throw new MyJarbisError(
          ErrorType.SESSION_NOT_ACTIVE,
          'scope="session" requires an active session.',
        );
      }
      rows = ctx.db.skills.listForSession(project.id, ctx.activeModuleId);
      break;
    }
  }

  if (args.only_enabled) rows = rows.filter((r) => r.enabled === 1);

  const skills: ListedSkill[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    trigger_pattern: r.trigger_pattern,
    module: r.module_id !== null ? ctx.db.modules.findById(r.module_id)?.name ?? null : null,
    enabled: r.enabled === 1,
    bytes: r.content.length,
    updated_at: r.updated_at,
  }));

  return { scope, count: skills.length, skills };
}

// ─────────────────────────────────────────────────────────────────────
// add_skill
// ─────────────────────────────────────────────────────────────────────

export const addSkillInputSchema = {
  type: 'object' as const,
  properties: {
    name: {
      type: 'string' as const,
      description:
        'Skill name. Convention: kebab-case. Used as folder name when ' +
        'materialized: .claude/skills/myjarbis-<name>/SKILL.md',
    },
    content: {
      type: 'string' as const,
      description:
        'Full SKILL.md content. Should start with YAML frontmatter ' +
        '(name + description) so Claude Code can index it.',
    },
    description: {
      type: 'string' as const,
      description:
        'One-liner describing the skill. Used in list_skills and (optionally) ' +
        'mirrored into the frontmatter description.',
    },
    trigger_pattern: {
      type: 'string' as const,
      description: 'Free-form note about when this skill should be loaded.',
    },
    module: {
      type: 'string' as const,
      description:
        'Module name. If provided, the skill is module-level (only active ' +
        'when that module is in session). If omitted, project-level.',
    },
    enabled: {
      type: 'boolean' as const,
      description: 'Default true. Pass false to seed a disabled skill.',
    },
  },
  required: ['name', 'content'],
};

const addSkillArgsZ = z
  .object({
    name: z.string().min(1).max(80).regex(/^[\w-]+$/, 'kebab/snake-case only'),
    content: z.string().min(1),
    description: z.string().max(500).optional(),
    trigger_pattern: z.string().max(500).optional(),
    module: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export interface AddSkillResult {
  status: 'inserted' | 'updated' | 'unchanged';
  skill: {
    id: number;
    name: string;
    module: string | null;
    enabled: boolean;
    updated_at: string;
  };
}

export function addSkill(ctx: ServerContext, rawArgs: unknown): AddSkillResult {
  const args = addSkillArgsZ.parse(rawArgs);
  const project = ctx.requireProject();

  let moduleId: number | null = null;
  let moduleName: string | null = null;
  if (args.module) {
    const m = ctx.requireModule(args.module);
    moduleId = m.id;
    moduleName = m.name;
  }

  const r = ctx.db.skills.upsert({
    projectId: project.id,
    moduleId,
    name: args.name,
    description: args.description,
    triggerPattern: args.trigger_pattern,
    content: args.content,
    enabled: args.enabled,
  });

  return {
    status: r.status,
    skill: {
      id: r.row.id,
      name: r.row.name,
      module: moduleName,
      enabled: r.row.enabled === 1,
      updated_at: r.row.updated_at,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// materialize_skills
// ─────────────────────────────────────────────────────────────────────

export const materializeSkillsInputSchema = {
  type: 'object' as const,
  properties: {
    module: {
      type: 'string' as const,
      description:
        'Module name. If omitted, uses the active session\'s module. If no ' +
        'session and no module, materializes ONLY project-level skills.',
    },
    cleanup_stale: {
      type: 'boolean' as const,
      description:
        'Default true. If true, removes any myjarbis-* skill folders under ' +
        '<project>/.claude/skills/ whose name is not in the active set.',
    },
  },
  required: [],
};

const materializeSkillsArgsZ = z
  .object({
    module: z.string().min(1).optional(),
    cleanup_stale: z.boolean().optional(),
  })
  .strict();

export interface MaterializeResult {
  skills_dir: string;
  module: string | null;
  written: string[];
  unchanged: string[];
  removed: string[];
}

export function materializeSkills(
  ctx: ServerContext,
  rawArgs: unknown,
): MaterializeResult {
  const args = materializeSkillsArgsZ.parse(rawArgs ?? {});
  const project = ctx.requireProject();

  let moduleRow = null;
  if (args.module) {
    moduleRow = ctx.requireModule(args.module);
  } else if (ctx.activeModuleId !== null) {
    moduleRow = ctx.db.modules.findById(ctx.activeModuleId);
  }

  // Skills to materialize:
  //   - module given/active: listForSession (project-level + that module)
  //   - no module:            project-level only
  const skills = moduleRow
    ? ctx.db.skills.listForSession(project.id, moduleRow.id)
    : ctx.db.skills
        .listByProject(project.id, { onlyProjectLevel: true })
        .filter((s) => s.enabled === 1);

  const skillsDir = path.join(ctx.projectPath, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  const desiredFolders = new Set<string>();
  const written: string[] = [];
  const unchanged: string[] = [];

  for (const skill of skills) {
    const folder = `${MANAGED_PREFIX}${skill.name}`;
    desiredFolders.add(folder);

    const dir = path.join(skillsDir, folder);
    const filePath = path.join(dir, 'SKILL.md');
    fs.mkdirSync(dir, { recursive: true });

    const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : null;
    if (previous === skill.content) {
      unchanged.push(skill.name);
    } else {
      fs.writeFileSync(filePath, skill.content, 'utf-8');
      written.push(skill.name);
    }
  }

  // Cleanup stale myjarbis-* folders.
  const removed: string[] = [];
  if (args.cleanup_stale !== false) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith(MANAGED_PREFIX)) continue;
      if (desiredFolders.has(entry.name)) continue;
      const dir = path.join(skillsDir, entry.name);
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(entry.name.slice(MANAGED_PREFIX.length));
    }
  }

  return {
    skills_dir: skillsDir,
    module: moduleRow ? moduleRow.name : null,
    written,
    unchanged,
    removed,
  };
}
