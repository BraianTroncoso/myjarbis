#!/usr/bin/env node

/**
 * MyJarbis CLI helper — invoked by bin/myjarbis for subcommands that
 * need access to the MCP toolset directly (import, module, skill, stats).
 *
 * Each subcommand parses its own flags, opens a ServerContext at cwd,
 * runs the relevant tool function, prints the result as pretty JSON,
 * and exits with non-zero on failure.
 *
 * Usage (from bash):
 *   node <build>/cli.js import <path> --target=<...> --kind=<...>
 *   node <build>/cli.js module add <name>
 *   ...
 */

import * as path from 'path';
import { ServerContext } from './context.js';
import { MyJarbisError } from './types.js';
import { importMd, importJson } from './tools/import.js';
import { listModules, createModule } from './tools/discovery.js';
import { listSkills, addSkill, materializeSkills } from './tools/skills.js';
import { seedNewProject } from './db/migrate.js';
import { SCHEMA_VERSION } from './db/schema.js';
import {
  composeInteractionStyle,
  parseLanguage,
  parsePersona,
  personaLabel,
} from './personas.js';
import { computeCost, formatTable } from './tools/cost.js';
import * as fs from 'fs';
import * as os from 'os';
import { execSync } from 'child_process';

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/** Parse CLI flags into { positional, flags }.
 *  Supports `--key=value`, `--key value`, and bare `--flag`. */
function parseFlags(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function fail(message: string, exitCode = 1): never {
  console.error(`✗ ${message}`);
  process.exit(exitCode);
}

function printJson(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: import
// ─────────────────────────────────────────────────────────────────────

function runImport(argv: string[]): void {
  const { positional, flags } = parseFlags(argv);
  const filePath = positional[0];
  if (!filePath) {
    fail('Usage: myjarbis import <path> --target=<project|module:NAME> --kind=<kind> [--mapping=<jsonpath>] [--tags=<tags>]');
  }

  const target = flags.target as string | undefined;
  const kind = flags.kind as string | undefined;
  if (!target) fail('--target is required (e.g. --target=project or --target=module:MM)');
  if (!kind) fail('--kind is required');

  const ext = path.extname(filePath).toLowerCase();
  const isJson = ext === '.json' || flags.json === true;

  const ctx = ServerContext.initialize();
  try {
    if (isJson) {
      const mapping = flags.mapping as string | undefined;
      if (!mapping) fail('JSON imports require --mapping=<path[]> (e.g., stories[])');
      const result = importJson(ctx, {
        path: filePath,
        target,
        kind,
        mapping,
        id_field: flags['id-field'] as string | undefined,
        title_field: flags['title-field'] as string | undefined,
        tags: flags.tags as string | undefined,
      });
      printJson(result);
    } else {
      const result = importMd(ctx, {
        path: filePath,
        target,
        kind,
        tags: flags.tags as string | undefined,
        title: flags.title as string | undefined,
      });
      printJson(result);
    }
  } finally {
    ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: module
// ─────────────────────────────────────────────────────────────────────

function runModule(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (!sub) {
    fail('Usage: myjarbis module <add|list> [args...]');
  }
  const ctx = ServerContext.initialize();
  try {
    if (sub === 'add') {
      const { positional, flags } = parseFlags(rest);
      const name = positional[0];
      if (!name) fail('Usage: myjarbis module add <name> [--description=<desc>]');
      const result = createModule(ctx, {
        name,
        description: flags.description as string | undefined,
      });
      printJson(result);
      return;
    }
    if (sub === 'list') {
      const { flags } = parseFlags(rest);
      const includeStatus =
        typeof flags['include-status'] === 'string'
          ? (flags['include-status'] as string).split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;
      const result = listModules(ctx, includeStatus ? { include_status: includeStatus } : {});
      printJson(result);
      return;
    }
    fail(`Unknown module subcommand: ${sub}. Use add | list.`);
  } finally {
    ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: skill
// ─────────────────────────────────────────────────────────────────────

function runSkill(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (!sub) {
    fail(
      'Usage: myjarbis skill <list|add|edit|delete|enable|disable|materialize> [args...]',
    );
  }

  const ctx = ServerContext.initialize();
  try {
    switch (sub) {
      case 'list': {
        const { flags } = parseFlags(rest);
        const scope = (flags.scope as string | undefined) ?? 'all';
        const result = listSkills(ctx, {
          scope: scope as 'all' | 'project' | 'module' | 'session',
          module: flags.module as string | undefined,
          only_enabled: flags['only-enabled'] === true,
        });
        printJson(result);
        return;
      }

      case 'add': {
        const { positional, flags } = parseFlags(rest);
        const name = positional[0];
        if (!name) fail('Usage: myjarbis skill add <name> --content-from=<file> [--module=NAME] [--description=<d>] [--trigger=<p>]');

        let content: string;
        if (flags['content-from']) {
          const cf = path.resolve(flags['content-from'] as string);
          if (!fs.existsSync(cf)) fail(`--content-from file not found: ${cf}`);
          content = fs.readFileSync(cf, 'utf-8');
        } else if (!process.stdin.isTTY) {
          // Read content from stdin if piped
          content = fs.readFileSync(0, 'utf-8');
        } else {
          fail('Provide --content-from=<file> or pipe content via stdin');
        }

        const enabled =
          flags.enabled === undefined
            ? undefined
            : String(flags.enabled).toLowerCase() === 'true';

        const result = addSkill(ctx, {
          name,
          content,
          description: flags.description as string | undefined,
          trigger_pattern: flags.trigger as string | undefined,
          module: flags.module as string | undefined,
          enabled,
        });
        printJson(result);
        return;
      }

      case 'edit': {
        const { positional, flags } = parseFlags(rest);
        const name = positional[0];
        if (!name) fail('Usage: myjarbis skill edit <name> [--module=NAME]');
        const project = ctx.requireProject();
        const moduleName = flags.module as string | undefined;
        const moduleId = moduleName ? ctx.requireModule(moduleName).id : null;

        const skill = ctx.db.skills.findByName(project.id, moduleId, name);
        if (!skill) fail(`Skill "${name}" not found${moduleName ? ` in module "${moduleName}"` : ' (project-level)'}`);

        const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
        const tmp = path.join(os.tmpdir(), `myjarbis-skill-${name}-${Date.now()}.md`);
        fs.writeFileSync(tmp, skill.content, 'utf-8');
        try {
          execSync(`${editor} "${tmp}"`, { stdio: 'inherit' });
        } catch {
          fail(`Editor "${editor}" failed`);
        }
        const newContent = fs.readFileSync(tmp, 'utf-8');
        fs.unlinkSync(tmp);

        if (newContent === skill.content) {
          console.error('No changes — skill not updated.');
          return;
        }
        const r = addSkill(ctx, {
          name,
          content: newContent,
          description: skill.description ?? undefined,
          trigger_pattern: skill.trigger_pattern ?? undefined,
          module: moduleName,
          enabled: skill.enabled === 1,
        });
        printJson(r);
        return;
      }

      case 'delete': {
        const { positional, flags } = parseFlags(rest);
        const name = positional[0];
        if (!name) fail('Usage: myjarbis skill delete <name> [--module=NAME]');
        const project = ctx.requireProject();
        const moduleName = flags.module as string | undefined;
        const moduleId = moduleName ? ctx.requireModule(moduleName).id : null;
        const skill = ctx.db.skills.findByName(project.id, moduleId, name);
        if (!skill) fail(`Skill "${name}" not found`);
        ctx.db.skills.delete(skill.id);
        printJson({ deleted: true, id: skill.id, name: skill.name });
        return;
      }

      case 'enable':
      case 'disable': {
        const { positional, flags } = parseFlags(rest);
        const name = positional[0];
        if (!name) fail(`Usage: myjarbis skill ${sub} <name> [--module=NAME]`);
        const project = ctx.requireProject();
        const moduleName = flags.module as string | undefined;
        const moduleId = moduleName ? ctx.requireModule(moduleName).id : null;
        const skill = ctx.db.skills.findByName(project.id, moduleId, name);
        if (!skill) fail(`Skill "${name}" not found`);
        ctx.db.skills.setEnabled(skill.id, sub === 'enable');
        printJson({ id: skill.id, name: skill.name, enabled: sub === 'enable' });
        return;
      }

      case 'materialize': {
        const { flags } = parseFlags(rest);
        const result = materializeSkills(ctx, {
          module: flags.module as string | undefined,
          cleanup_stale: flags['no-cleanup'] !== true,
        });
        printJson(result);
        return;
      }

      default:
        fail(`Unknown skill subcommand: ${sub}`);
    }
  } finally {
    ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: stats
// ─────────────────────────────────────────────────────────────────────

function runStats(_argv: string[]): void {
  const ctx = ServerContext.initialize();
  try {
    const project = ctx.requireProject();
    const sql = (q: string) => ctx.db.db.prepare(q);

    const moduleCounts = sql(
      `SELECT status, COUNT(*) AS n FROM modules WHERE project_id = ? GROUP BY status`,
    ).all(project.id) as Array<{ status: string; n: number }>;
    const moduleTotal = moduleCounts.reduce((a, c) => a + c.n, 0);

    const pcKinds = sql(
      `SELECT kind, COUNT(*) AS n FROM project_context WHERE project_id = ? GROUP BY kind ORDER BY n DESC`,
    ).all(project.id) as Array<{ kind: string; n: number }>;

    const mcKinds = sql(
      `SELECT kind, COUNT(*) AS n FROM module_context mc
        JOIN modules m ON m.id = mc.module_id WHERE m.project_id = ?
        GROUP BY kind ORDER BY n DESC`,
    ).all(project.id) as Array<{ kind: string; n: number }>;

    const mcByModule = sql(
      `SELECT m.name, COUNT(mc.id) AS n FROM modules m
         LEFT JOIN module_context mc ON mc.module_id = m.id
        WHERE m.project_id = ? GROUP BY m.id ORDER BY m.name`,
    ).all(project.id) as Array<{ name: string; n: number }>;

    const skillsTotal = sql(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN module_id IS NULL THEN 1 ELSE 0 END) AS project_level,
         SUM(CASE WHEN module_id IS NOT NULL THEN 1 ELSE 0 END) AS module_level,
         SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS enabled
       FROM skills WHERE project_id = ?`,
    ).get(project.id) as { total: number; project_level: number; module_level: number; enabled: number };

    const sessionsAgg = sql(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END) AS open,
         MAX(ended_at) AS last_ended_at
       FROM sessions s
       JOIN modules m ON m.id = s.module_id
       WHERE m.project_id = ?`,
    ).get(project.id) as { total: number; open: number; last_ended_at: string | null };

    const obsKinds = sql(
      `SELECT o.kind, COUNT(*) AS n FROM observations o
        JOIN sessions s ON s.id = o.session_id
        JOIN modules m  ON m.id = s.module_id
       WHERE m.project_id = ? GROUP BY o.kind ORDER BY n DESC`,
    ).all(project.id) as Array<{ kind: string; n: number }>;
    const obsTotal = obsKinds.reduce((a, c) => a + c.n, 0);

    const result = {
      project: {
        id: project.id,
        name: project.name,
        path: project.path,
        framework: project.framework,
      },
      modules: {
        total: moduleTotal,
        by_status: Object.fromEntries(moduleCounts.map((r) => [r.status, r.n])),
      },
      project_context: {
        total: pcKinds.reduce((a, c) => a + c.n, 0),
        by_kind: Object.fromEntries(pcKinds.map((r) => [r.kind, r.n])),
      },
      module_context: {
        total: mcKinds.reduce((a, c) => a + c.n, 0),
        by_kind: Object.fromEntries(mcKinds.map((r) => [r.kind, r.n])),
        by_module: Object.fromEntries(mcByModule.map((r) => [r.name, r.n])),
      },
      skills: {
        total: skillsTotal.total ?? 0,
        project_level: skillsTotal.project_level ?? 0,
        module_level: skillsTotal.module_level ?? 0,
        enabled: skillsTotal.enabled ?? 0,
      },
      sessions: {
        total: sessionsAgg.total ?? 0,
        open: sessionsAgg.open ?? 0,
        last_ended_at: sessionsAgg.last_ended_at,
      },
      observations: {
        total: obsTotal,
        by_kind: Object.fromEntries(obsKinds.map((r) => [r.kind, r.n])),
      },
    };
    printJson(result);
  } finally {
    ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: cost
//
// Reads ~/.claude/projects/<slug>/*.jsonl (one .jsonl = one Claude
// session) and aggregates per-session and project-wide token usage,
// cost approximation and the cache hit ratio.
// ─────────────────────────────────────────────────────────────────────

function runCost(argv: string[]): void {
  const { flags } = parseFlags(argv);
  const projectPath = (flags.path as string | undefined) ?? process.cwd();
  const lastFlag = flags.last;
  const last = typeof lastFlag === 'string' ? parseInt(lastFlag, 10) : undefined;
  const since = flags.since as string | undefined;

  const report = computeCost(projectPath, {
    last: last && !Number.isNaN(last) ? last : undefined,
    since,
  });

  if (flags.json === true || flags.json === 'true') {
    printJson(report);
    return;
  }
  console.log(formatTable(report));
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: init-project
//
// Called by bin/myjarbis-init AFTER it has prepared .myjarbis/ skeleton.
// This finalizes v0.2 setup: writes settings.json, opens/seeds memory.db,
// inserts the 6 baseline skills, and materializes project-level skills
// to .claude/skills/. Idempotent.
// ─────────────────────────────────────────────────────────────────────

function runInitProject(argv: string[]): void {
  const { flags } = parseFlags(argv);
  const name = flags.name as string | undefined;
  const framework = flags.framework as string | undefined;
  if (!name) fail('Usage: cli.js init-project --name=<project> [--framework=<fw>] [--shared=true|false] [--language=EN|ES|PT] [--persona=concise|pair|mentor|reviewer]');

  // Validate language + persona early (before any DB write)
  const language = parseLanguage(flags.language as string | undefined);
  const persona = parsePersona(flags.persona as string | undefined);

  const projectPath = process.cwd();

  // 1. seedNewProject (creates memory.db + project + _general module +
  //    10 baseline skills, idempotent)
  const seed = seedNewProject(projectPath, { name, framework });

  // 2. Write settings.json v0.2 schema (preserve existing fields if any)
  const myjarbisDir = path.join(projectPath, '.myjarbis');
  const configDir = path.join(myjarbisDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const settingsPath = path.join(configDir, 'settings.json');
  const existing = fs.existsSync(settingsPath)
    ? (() => {
        try {
          return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        } catch {
          return {};
        }
      })()
    : {};
  const sharedFlag = flags.shared === undefined ? false : String(flags.shared).toLowerCase() === 'true';
  const settings = {
    ...existing,
    version: '0.2.0',
    project: { name, framework: framework ?? null },
    shared: existing.shared ?? sharedFlag,
    search_default_scope: existing.search_default_scope ?? 'module',
    story_pattern: existing.story_pattern ?? '[A-Z]+-S?\\d+(\\.\\d+)?',
    auto_module_select_when_single: existing.auto_module_select_when_single ?? true,
    language: existing.language ?? language.toLowerCase(),
    skills: {
      materialize_on_session_start:
        existing.skills?.materialize_on_session_start ?? true,
      cleanup_module_skills_on_session_end:
        existing.skills?.cleanup_module_skills_on_session_end ?? false,
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');

  if (settings.shared === true) {
    // memory.db will be committed to the repo. Anything saved via
    // save_observation goes upstream too — including pasted credentials,
    // tokens, internal URLs, etc. Surface this loudly.
    console.error(
      '\n[MyJarbis] WARNING: shared=true — memory.db is NOT git-ignored.\n' +
        '  Observations you save (decisions, gotchas, errors) will travel\n' +
        '  with the repo. Avoid pasting tokens/keys/URLs into the agent\n' +
        '  while a session is open, or scrub before pushing.\n',
    );
  }

  // 3. Compose interaction-style with the chosen language + persona
  //    (overwrites the placeholder default seeded by seedNewProject).
  const ctx = ServerContext.initialize();
  let materialized;
  try {
    addSkill(ctx, {
      name: 'interaction-style',
      content: composeInteractionStyle(language, persona),
      description: `Language: ${language} · Persona: ${personaLabel(persona)} (composed at init)`,
      trigger_pattern: 'always loaded; modulates tone, language, brevity',
    });

    // 4. Materialize project-level skills (no active session yet) so
    //    .claude/skills/myjarbis-interaction-style/SKILL.md reflects the
    //    composed content immediately.
    materialized = materializeSkills(ctx, {});
  } finally {
    ctx.close();
  }

  // 4. Append .myjarbis/memory.db + .claude/skills/myjarbis-* to .gitignore
  //    when shared === false. (When true, the user wants them committed.)
  if (settings.shared === false) {
    appendToGitignore(projectPath, [
      '.myjarbis/memory.db',
      '.myjarbis/memory.db-journal',
      '.myjarbis/memory.db-wal',
      '.myjarbis/memory.db-shm',
      '.claude/skills/myjarbis-*/',
    ]);
  }

  printJson({
    project: { id: seed.projectId, name, framework: framework ?? null, path: projectPath },
    schema_version: SCHEMA_VERSION,
    seeded: { module_id: seed.moduleId, baseline_skills: seed.skills },
    interaction_style: { language, persona, label: personaLabel(persona) },
    settings_path: settingsPath,
    materialized_skills: {
      written: materialized.written.length,
      unchanged: materialized.unchanged.length,
      removed: materialized.removed.length,
    },
    shared: settings.shared,
  });
}

function appendToGitignore(projectPath: string, patterns: string[]): void {
  const gi = path.join(projectPath, '.gitignore');
  let existing = '';
  try {
    existing = fs.readFileSync(gi, 'utf-8');
  } catch {
    /* may not exist */
  }
  const lines = existing.split('\n');
  const toAdd: string[] = [];
  for (const p of patterns) {
    if (!lines.some((l) => l.trim() === p)) toAdd.push(p);
  }
  if (toAdd.length === 0) return;
  const block =
    (existing && !existing.endsWith('\n') ? '\n' : '') +
    (existing.includes('# MyJarbis (v0.2)') ? '' : '\n# MyJarbis (v0.2)\n') +
    toAdd.join('\n') +
    '\n';
  fs.writeFileSync(gi, existing + block, 'utf-8');
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: hook
//
// Bash hook scripts in .claude-plugin/scripts/ delegate to this helper.
// Each hook prints a single block of context for Claude Code to inject.
// Plain text output → goes into the SessionStart systemMessage.
// We avoid throwing on missing project/modules — hooks must degrade
// gracefully (the user might be in a non-MyJarbis directory).
// ─────────────────────────────────────────────────────────────────────

function runHook(argv: string[]): void {
  const [event, ...rest] = argv;
  if (!event) fail('Usage: cli.js hook <session-start|session-stop|post-compaction|user-prompt-submit>');

  switch (event) {
    case 'session-start':
      return runHookSessionStart();
    case 'post-compaction':
      return runHookPostCompaction();
    case 'session-stop':
      return runHookSessionStop();
    case 'user-prompt-submit':
      return runHookUserPromptSubmit(rest);
    default:
      fail(`Unknown hook event: ${event}`);
  }
}

function safeContext(): { ctx: ServerContext } | null {
  try {
    const ctx = ServerContext.initialize();
    return { ctx };
  } catch (err) {
    console.error('[MyJarbis hook] failed to initialize:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Stable date label for hook output. We deliberately avoid "Xh ago"
 *  because that would invalidate Anthropic's prompt cache every minute. */
function stableDateLabel(iso: string | null): string {
  if (!iso) return 'never';
  // Accept "YYYY-MM-DD HH:MM:SS" or ISO; collapse to "YYYY-MM-DD HH:MM".
  const normalized = iso.replace(' ', 'T');
  const parsed = new Date(normalized.endsWith('Z') ? normalized : normalized + 'Z');
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toISOString().slice(0, 16).replace('T', ' ');
}

/** Localized strings for the SessionStart menu — rendered server-side
 *  so the agent doesn't have to re-format from a markdown spec each
 *  session (saves ~28s of reasoning + the output tokens). */
const HOOK_I18N = {
  es: {
    no_project_title: 'MyJarbis',
    no_project_body: (cwd: string) =>
      `No hay proyecto MyJarbis en ${cwd}.\nCorré \`myjarbis init\` desde este directorio para habilitar memoria persistente.`,
    no_modules_body: (header: string) =>
      `${header}\n\nNo hay módulos registrados todavía.\nCreá uno con: \`myjarbis module add <name>\`\n(Los módulos son verticales: ej. MM, PageBuilder, Translations.)`,
    modules_label: 'Módulos:',
    paused_tag: ' (en pausa)',
    last_session_tag: (ts: string) => `last session ${ts} UTC`,
    no_sessions_tag: 'sin sesiones todavía',
    what_to_do: '¿Qué hacemos?',
    pick_option: (name: string, num: number) =>
      `· "${name}" o "${num}" → arrancar sesión en ese módulo`,
    create_option: '· "nuevo módulo <name>" → create_module + start_session',
    settings_option: '· "settings" → cambiar language / persona',
    resume_label: (mod: string, ts: string) => `── Última "Retomar aquí" (${mod}, ${ts} UTC) ──`,
  },
  en: {
    no_project_title: 'MyJarbis',
    no_project_body: (cwd: string) =>
      `No MyJarbis project at ${cwd}.\nRun \`myjarbis init\` from this directory to enable persistent memory.`,
    no_modules_body: (header: string) =>
      `${header}\n\nNo modules registered yet.\nCreate one with: \`myjarbis module add <name>\`\n(Modules are verticals: e.g., MM, PageBuilder, Translations.)`,
    modules_label: 'Modules:',
    paused_tag: ' (paused)',
    last_session_tag: (ts: string) => `last session ${ts} UTC`,
    no_sessions_tag: 'no sessions yet',
    what_to_do: 'What are we doing?',
    pick_option: (name: string, num: number) =>
      `· "${name}" or "${num}" → start a session on that module`,
    create_option: '· "new module <name>" → create_module + start_session',
    settings_option: '· "settings" → change language / persona',
    resume_label: (mod: string, ts: string) => `── Last "Resume here" (${mod}, ${ts} UTC) ──`,
  },
  pt: {
    no_project_title: 'MyJarbis',
    no_project_body: (cwd: string) =>
      `Sem projeto MyJarbis em ${cwd}.\nRode \`myjarbis init\` deste diretório para habilitar memória persistente.`,
    no_modules_body: (header: string) =>
      `${header}\n\nNenhum módulo registrado ainda.\nCrie um com: \`myjarbis module add <name>\`\n(Módulos são verticais: ex. MM, PageBuilder, Translations.)`,
    modules_label: 'Módulos:',
    paused_tag: ' (em pausa)',
    last_session_tag: (ts: string) => `last session ${ts} UTC`,
    no_sessions_tag: 'sem sessões ainda',
    what_to_do: 'O que vamos fazer?',
    pick_option: (name: string, num: number) =>
      `· "${name}" ou "${num}" → começar sessão nesse módulo`,
    create_option: '· "novo módulo <name>" → create_module + start_session',
    settings_option: '· "settings" → mudar language / persona',
    resume_label: (mod: string, ts: string) => `── Última "Retomar aqui" (${mod}, ${ts} UTC) ──`,
  },
} as const;

type HookLang = keyof typeof HOOK_I18N;

function resolveHookLanguage(settings: ProjectSettings): HookLang {
  const raw = (settings.language ?? 'en').toString().toLowerCase();
  if (raw === 'es' || raw === 'en' || raw === 'pt') return raw;
  return 'en';
}

function runHookSessionStart(): void {
  const init = safeContext();
  if (!init) return;
  const { ctx } = init;

  try {
    const project = ctx.project;
    const settings = project ? readSettingsJson(ctx.projectPath) : {};
    const t = HOOK_I18N[resolveHookLanguage(settings)];

    if (!project) {
      console.log(`═══ ${t.no_project_title} ═══\n${t.no_project_body(ctx.projectPath)}`);
      return;
    }

    const modules = ctx.db.modules.listByProject(project.id);
    const active = modules.filter((m) => m.status === 'active' || m.status === 'paused');

    const header = `═══ MyJarbis · ${project.name}${project.framework ? ` (${project.framework})` : ''} ═══`;

    if (active.length === 0) {
      console.log(t.no_modules_body(header));
      return;
    }

    // Render the FULL menu server-side. The agent must not re-format —
    // jarbis.md instructs it to wait for user input, not echo this.
    const lines: string[] = [header, '', t.modules_label];
    active.forEach((m, idx) => {
      const last = ctx.db.sessions.findLastClosedByModule(m.id);
      const pausedTag = m.status === 'paused' ? t.paused_tag : '';
      const sessionTag = last?.ended_at
        ? t.last_session_tag(stableDateLabel(last.ended_at))
        : t.no_sessions_tag;
      lines.push(`  ${idx + 1}. ${m.name}${pausedTag} — ${sessionTag}`);
      if (m.description) {
        lines.push(`     └ ${m.description}`);
      }
    });

    lines.push('', t.what_to_do);
    active.forEach((m, idx) => {
      lines.push(`  ${t.pick_option(m.name, idx + 1)}`);
    });
    lines.push(`  ${t.create_option}`);
    lines.push(`  ${t.settings_option}`);

    // Surface the most recent next_session, if any (helps remember what
    // was being worked on last).
    let mostRecent: { mod: string; ended_at: string; next: string } | null = null;
    for (const m of active) {
      const last = ctx.db.sessions.findLastClosedByModule(m.id);
      if (last?.ended_at && last.next_session) {
        if (!mostRecent || last.ended_at > mostRecent.ended_at) {
          mostRecent = { mod: m.name, ended_at: last.ended_at, next: last.next_session };
        }
      }
    }
    if (mostRecent) {
      lines.push('', t.resume_label(mostRecent.mod, stableDateLabel(mostRecent.ended_at)));
      lines.push(mostRecent.next);
    }
    console.log(lines.join('\n'));
  } finally {
    ctx.close();
  }
}

function runHookPostCompaction(): void {
  // After compaction, agent's context is summarized. We want it to re-load
  // the active module's context + the previous next_session imperatively,
  // AND surface any pre-compact snapshot the agent left behind via
  // /myjarbis compact (kind=discovery, tags contains 'pre-compact').
  const init = safeContext();
  if (!init) return;
  const { ctx } = init;
  try {
    const project = ctx.project;
    if (!project) return;

    const blocks: string[] = [];

    // 1. Pre-compact snapshot (if /myjarbis compact ran before compact).
    //    Wrapped in try/catch so a malformed query never breaks the hook.
    try {
      const snap = ctx.db.db.prepare(
        `SELECT o.created_at, o.title, o.content, o.tags
           FROM observations o
           JOIN sessions s ON s.id = o.session_id
           JOIN modules  m ON m.id = s.module_id
          WHERE m.project_id = ?
            AND o.kind = 'discovery'
            AND (o.tags LIKE '%pre-compact%')
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT 1`,
      ).get(project.id) as
        | { created_at: string; title: string; content: string; tags: string | null }
        | undefined;

      if (snap) {
        blocks.push(
          `═══ Pre-compact snapshot (${snap.created_at}${snap.tags?.includes('verbatim') ? ', --verbatim' : ''}) ═══`,
          snap.content.trim(),
          '',
        );
      }
    } catch (err) {
      console.error('[MyJarbis hook] snapshot lookup failed (non-fatal):', err instanceof Error ? err.message : err);
    }

    // 2. Recovery imperative (always shown).
    blocks.push(
      '═══ MyJarbis · post-compaction recovery ═══',
      'Context was compacted. To continue coherently:',
      '  1. Call `current_project` to confirm the project.',
      '  2. Call `list_modules` and identify the active one.',
      '  3. Call `start_session(module)` to reload context + previous next_session.',
      '  4. Then continue with the user\'s next message.',
    );

    // If we know which module was likely active (last session not ended),
    // surface it as a hint.
    const modules = ctx.db.modules.listByProject(project.id);
    for (const m of modules) {
      const open = ctx.db.sessions.findActiveByModule(m.id);
      if (open) {
        blocks.push('', `Hint: an open session #${open.id} exists in module "${m.name}".`);
        break;
      }
    }
    console.log(blocks.join('\n'));
  } finally {
    ctx.close();
  }
}

function runHookSessionStop(): void {
  const init = safeContext();
  if (!init) return;
  const { ctx } = init;
  try {
    const project = ctx.project;
    if (!project) return;

    // If there's an open session, remind the agent to close it.
    const modules = ctx.db.modules.listByProject(project.id);
    for (const m of modules) {
      const open = ctx.db.sessions.findActiveByModule(m.id);
      if (open) {
        const obs = ctx.db.observations.listBySession(open.id).length;
        console.log(
          `═══ MyJarbis · session ending ═══\n` +
          `Open session #${open.id} in module "${m.name}" (${obs} observations).\n` +
          `Run \`/complete\` or call \`end_session(summary, next_session)\` before exiting\n` +
          `so the next session can resume coherently.`,
        );
        return;
      }
    }

    // Optional cleanup of module-level skills if configured
    const settings = readSettingsJson(ctx.projectPath);
    if (settings.skills?.cleanup_module_skills_on_session_end) {
      const m = materializeSkills(ctx, {});
      console.error(`[MyJarbis hook] post-stop cleanup removed ${m.removed.length} module skill(s).`);
    }
  } finally {
    ctx.close();
  }
}

function runHookUserPromptSubmit(_rest: string[]): void {
  // Stdin contains the user prompt, per Claude Code hook protocol.
  let prompt = '';
  if (!process.stdin.isTTY) {
    try {
      prompt = fs.readFileSync(0, 'utf-8');
    } catch {
      prompt = '';
    }
  }

  const init = safeContext();
  if (!init) return;
  const { ctx } = init;
  try {
    const project = ctx.project;
    if (!project) return;

    const settings = readSettingsJson(ctx.projectPath);
    const messages: string[] = [];

    // 1. First-message: tell the agent to load the MyJarbis tools via ToolSearch.
    //    State file keyed by project path so re-opens of Claude Code in the
    //    same project re-fire the ToolSearch hint until at least one save
    //    observation lands (proxy for "agent has been productive this session").
    const firstMsgFlag = path.join(
      os.tmpdir(),
      `myjarbis-${path.basename(project.path)}-${project.id}-firstmsg`,
    );
    if (!fs.existsSync(firstMsgFlag)) {
      messages.push(
        `═══ MyJarbis · first message ═══\n` +
        `If you haven't already, load MyJarbis tools via ToolSearch:\n` +
        `  ToolSearch query: "select:current_project,list_modules,start_session,end_session,resume,load_project_core,load_module,search,save_observation,import_md,import_json,list_skills,add_skill,materialize_skills"\n` +
        `Then call \`current_project\` and \`list_modules\` to confirm where you are.`,
      );
      try {
        fs.writeFileSync(firstMsgFlag, String(Date.now()));
      } catch {
        // Best-effort.
      }
    }

    // 2. Story-id detection via configured regex.
    const storyPattern = settings.story_pattern as string | undefined;
    if (storyPattern) {
      try {
        const re = new RegExp(storyPattern);
        const m = prompt.match(re);
        if (m && m[0]) {
          messages.push(
            `═══ MyJarbis · story detected (${m[0]}) ═══\n` +
            `Suggested next step: \`search\` with scope=module looking for "${m[0]}" in module_context kind=story before acting.`,
          );
        }
      } catch {
        // Bad regex in settings — silently ignore.
      }
    }

    // 3. Save-observation nudge — opt-in via settings.nudges.save_reminder_minutes.
    //    Default off: keeps the hook output cache-stable for users who don't
    //    explicitly want this reminder. When enabled, we bucket on the hour
    //    so the nudge state changes at most once per hour (prompt cache lives).
    const nudges = (settings as Record<string, unknown>).nudges as
      | { save_reminder_minutes?: number }
      | undefined;
    const reminderMin = typeof nudges?.save_reminder_minutes === 'number'
      ? nudges.save_reminder_minutes
      : null;
    if (reminderMin !== null && reminderMin > 0) {
      const lastObsRow = ctx.db.db.prepare(
        `SELECT MAX(o.created_at) AS last
           FROM observations o
           JOIN sessions s ON s.id = o.session_id
           JOIN modules m  ON m.id = s.module_id
          WHERE m.project_id = ?`,
      ).get(project.id) as { last: string | null } | undefined;

      const lastIso = lastObsRow?.last ?? null;
      if (lastIso) {
        const lastMs = new Date(lastIso.replace(' ', 'T') + 'Z').getTime();
        // Hour-bucketed threshold: floor(now) to the start of the current
        // hour, then check if last_obs is older than (bucketStart - reminderMin).
        // Stable for the entire hour bucket → cache survives.
        const hourMs = 60 * 60 * 1000;
        const bucketStart = Math.floor(Date.now() / hourMs) * hourMs;
        const cutoff = bucketStart - reminderMin * 60 * 1000;
        if (!Number.isNaN(lastMs) && lastMs < cutoff) {
          messages.push(
            `═══ MyJarbis · save reminder ═══\n` +
            `No save_observation has landed in this project in the last ${reminderMin}+ minutes. ` +
            `Did you make any decisions, fix bugs, or discover something worth persisting?`,
          );
        }
      }
    }

    if (messages.length > 0) {
      console.log(messages.join('\n\n'));
    }
  } finally {
    ctx.close();
  }
}

interface ProjectSettings {
  shared?: boolean;
  search_default_scope?: string;
  story_pattern?: string;
  auto_module_select_when_single?: boolean;
  /** "es" | "en" | "pt" — used by the SessionStart hook to render the
   *  module menu in the user's language without delegating to the
   *  agent. Set by `myjarbis init`; older projects without this field
   *  fall back to "en". */
  language?: string;
  skills?: {
    materialize_on_session_start?: boolean;
    cleanup_module_skills_on_session_end?: boolean;
  };
  /** Optional nudges. All fields default OFF so the hook stays
   *  cache-stable for users who don't explicitly opt in. */
  nudges?: {
    /** When set to N>0, UserPromptSubmit hints to save an observation
     *  if none has landed in the last N+ minutes (bucketed per hour). */
    save_reminder_minutes?: number;
  };
  [k: string]: unknown;
}

function readSettingsJson(projectPath: string): ProjectSettings {
  const p = path.join(projectPath, '.myjarbis', 'config', 'settings.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────────────

export function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  if (!cmd) {
    fail('Usage: cli.js <import|module|skill|stats|cost|hook|init-project> [args...]');
  }
  try {
    switch (cmd) {
      case 'import':
        return runImport(rest);
      case 'module':
        return runModule(rest);
      case 'skill':
        return runSkill(rest);
      case 'stats':
        return runStats(rest);
      case 'cost':
        return runCost(rest);
      case 'hook':
        return runHook(rest);
      case 'init-project':
        return runInitProject(rest);
      default:
        fail(`Unknown subcommand: ${cmd}`);
    }
  } catch (err) {
    if (err instanceof MyJarbisError) {
      console.error(`✗ ${err.type}: ${err.message}`);
      if (err.details) console.error(JSON.stringify(err.details, null, 2));
      process.exit(2);
    }
    if (err instanceof Error) {
      console.error(`✗ ${err.message}`);
    } else {
      console.error(`✗ ${String(err)}`);
    }
    process.exit(1);
  }
}

main(process.argv.slice(2));
