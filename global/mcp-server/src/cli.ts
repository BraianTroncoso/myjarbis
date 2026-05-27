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
import { startSession, readStaleThreshold, computeStaleness } from './tools/session.js';
import { applyInteractionStyle, inferCurrent } from './tools/interactionStyle.js';
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
// Pretty printer (matches the blood-red minimal UI of install.sh +
// myjarbis-init). Falls back to plain text when stdout is not a TTY,
// so piping into another tool stays clean.
// ─────────────────────────────────────────────────────────────────────

const ANSI = {
  red: '\x1b[38;5;88m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

function tty(): boolean {
  return Boolean(process.stdout.isTTY);
}

function c(code: string, s: string): string {
  return tty() ? `${code}${s}${ANSI.reset}` : s;
}
const red = (s: string) => c(ANSI.red, s);
const bold = (s: string) => c(ANSI.bold, s);
const dim = (s: string) => c(ANSI.dim, s);

/** Section header in red bold, like install.sh `section()`. */
function ptySection(title: string): void {
  console.log('');
  console.log(red(bold(title)));
}

/** Key/value row with aligned label, like myjarbis-init `note()`. */
function ptyKV(label: string, value: string, labelWidth = 12): void {
  const pad = label.padEnd(labelWidth);
  console.log(`  ${bold(pad)}  ${value}`);
}

function ptyLine(s: string): void {
  console.log(s);
}

function ptyDim(s: string): void {
  console.log(`  ${dim(s)}`);
}

/** Returns true when --json flag is present in the parsed args. */
function wantsJson(flags: Record<string, string | boolean>): boolean {
  return flags.json === true || flags.json === 'true';
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

/** Path to the per-project active-module marker file. Like git's HEAD,
 *  but a single line with the module name. Always git-ignored — even
 *  in shared:true projects, this is per-user state. */
function activeModulePath(projectPath: string): string {
  return path.join(projectPath, '.myjarbis', 'active');
}

function readActiveModule(projectPath: string): string | null {
  try {
    const p = activeModulePath(projectPath);
    if (!fs.existsSync(p)) return null;
    const v = fs.readFileSync(p, 'utf-8').trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function writeActiveModule(projectPath: string, name: string): void {
  const p = activeModulePath(projectPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, name + '\n', 'utf-8');
}

function clearActiveModule(projectPath: string): void {
  const p = activeModulePath(projectPath);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function runModule(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (!sub) {
    fail('Usage: myjarbis module <list|use|current|unset|add|create> [args...]');
  }
  const ctx = ServerContext.initialize();
  try {
    if (sub === 'add' || sub === 'create') {
      const { positional, flags } = parseFlags(rest);
      const name = positional[0];
      if (!name) fail(`Usage: myjarbis module ${sub} <name> [--description=<desc>]`);
      const result = createModule(ctx, {
        name,
        description: flags.description as string | undefined,
      });
      if (wantsJson(flags)) { printJson(result); return; }
      ptySection('MyJarbis · module ' + (result.created ? 'created' : 'already existed'));
      ptyKV('Name', bold(result.module.name));
      if (result.module.description) ptyKV('Description', result.module.description);
      ptyKV('Status', result.module.status);
      if (result.hint) ptyDim(result.hint);
      console.log('');
      return;
    }
    if (sub === 'list') {
      const { flags } = parseFlags(rest);
      const includeStatus =
        typeof flags['include-status'] === 'string'
          ? (flags['include-status'] as string).split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;
      const result = listModules(ctx, includeStatus ? { include_status: includeStatus } : {});
      const active = readActiveModule(ctx.projectPath);
      if (wantsJson(flags)) { printJson({ ...result, active }); return; }
      ptySection('MyJarbis · modules of ' + bold(result.projectName));
      if (result.modules.length === 0) {
        ptyDim('No modules registered. Use `myjarbis module create <name>` to add one.');
        console.log('');
        return;
      }
      for (const m of result.modules) {
        const marker = m.name === active ? red('★') : ' ';
        const tag = m.status !== 'active' ? dim(` (${m.status})`) : '';
        const desc = m.description ? '  ' + dim(m.description) : '';
        console.log(`  ${marker} ${bold(m.name)}${tag}${desc}`);
      }
      console.log('');
      if (active) {
        ptyDim(`Active: ${active}  ·  /jarbis will resume this module.`);
      } else {
        ptyDim('No active module set. Use `myjarbis module use <name>` to pick one.');
      }
      console.log('');
      return;
    }
    if (sub === 'use') {
      const { positional, flags } = parseFlags(rest);
      const name = positional[0];
      if (!name) fail('Usage: myjarbis module use <name>');
      const project = ctx.requireProject();
      const m = ctx.db.modules.findByName(project.id, name);
      if (!m) {
        fail(`Module "${name}" does not exist. Use \`myjarbis module list\` to see available modules, or \`myjarbis module create ${name}\` to create it.`);
      }
      writeActiveModule(ctx.projectPath, m.name);
      if (wantsJson(flags)) {
        printJson({ active: m.name, description: m.description, status: m.status });
        return;
      }
      ptySection('MyJarbis · active module set');
      ptyKV('Active', red(bold(m.name)));
      if (m.description) ptyKV('Description', m.description);
      ptyKV('Status', m.status);
      console.log('');
      ptyDim('Open Claude in this directory — /jarbis will resume this module automatically.');
      console.log('');
      return;
    }
    if (sub === 'current') {
      const { flags } = parseFlags(rest);
      const active = readActiveModule(ctx.projectPath);
      if (wantsJson(flags)) { printJson({ active }); return; }
      if (active) {
        console.log(`${red('★')} ${bold(active)}`);
      } else {
        ptyDim('(no active module — run `myjarbis module use <name>`)');
      }
      return;
    }
    if (sub === 'unset') {
      const { flags } = parseFlags(rest);
      const had = readActiveModule(ctx.projectPath);
      clearActiveModule(ctx.projectPath);
      if (wantsJson(flags)) {
        printJson({ active: null, previously: had });
        return;
      }
      ptySection('MyJarbis · active module cleared');
      if (had) ptyKV('Was', dim(had));
      ptyDim('/jarbis will show the module menu next time.');
      console.log('');
      return;
    }
    fail(`Unknown module subcommand: ${sub}. Use list | use | current | unset | add | create.`);
  } finally {
    ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: config (language / persona / list)
// ─────────────────────────────────────────────────────────────────────

function runConfig(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (!sub) {
    fail('Usage: myjarbis config <list|language|persona> [value]');
  }
  const ctx = ServerContext.initialize();
  try {
    if (sub === 'list') {
      const { flags } = parseFlags(rest);
      const project = ctx.requireProject();
      const settings = readSettingsJson(ctx.projectPath);
      const skill = ctx.db.skills.findByName(project.id, null, 'interaction-style');
      const inferred = inferCurrent(skill?.content ?? null);
      const data = {
        project: { name: project.name, framework: project.framework },
        language: settings.language ?? inferred.language,
        persona: inferred.persona,
        shared: settings.shared ?? false,
        search_default_scope: settings.search_default_scope ?? 'module',
        story_pattern: settings.story_pattern ?? null,
        nudges: settings.nudges ?? null,
      };
      if (wantsJson(flags)) { printJson(data); return; }
      ptySection('MyJarbis · config of ' + bold(project.name));
      ptyKV('Language', red(bold(String(data.language).toUpperCase())));
      ptyKV('Persona', red(bold(data.persona)));
      ptyKV('Shared', data.shared ? red('true') : 'false');
      ptyKV('Scope', data.search_default_scope);
      if (data.story_pattern) ptyKV('Stories', dim(data.story_pattern));
      if (data.nudges && Object.keys(data.nudges).length > 0) {
        ptyKV('Nudges', JSON.stringify(data.nudges));
      }
      console.log('');
      ptyDim('Change with: myjarbis config language <EN|ES|PT> · myjarbis config persona <concise|pair|mentor|reviewer>');
      console.log('');
      return;
    }
    if (sub === 'language' || sub === 'persona') {
      const { positional, flags } = parseFlags(rest);
      const value = positional[0];
      if (!value) fail(`Usage: myjarbis config ${sub} <value>`);
      const args: { language?: string; persona?: string } = {};
      if (sub === 'language') args.language = value;
      else args.persona = value;
      const result = applyInteractionStyle(ctx, args);
      // Also persist language to settings.json for the hook to read
      if (sub === 'language') {
        const settingsPath = path.join(ctx.projectPath, '.myjarbis', 'config', 'settings.json');
        if (fs.existsSync(settingsPath)) {
          const settings = readSettingsJson(ctx.projectPath);
          settings.language = result.language.toLowerCase();
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
        }
      }
      if (wantsJson(flags)) { printJson(result); return; }
      const verb = result.status === 'unchanged' ? 'unchanged' : 'updated';
      ptySection(`MyJarbis · config ${sub} ${verb}`);
      ptyKV('Language', red(bold(result.language)));
      ptyKV('Persona', red(bold(result.persona_label)));
      if (result.status !== 'unchanged') {
        ptyKV('Materialized', result.materialized ? 'yes' : 'no');
      }
      console.log('');
      ptyDim('Change applies from the next agent reply. Reopen Claude to refresh the materialized skill on disk.');
      console.log('');
      return;
    }
    fail(`Unknown config subcommand: ${sub}. Use list | language | persona.`);
  } finally {
    ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: status (git-like overview)
// ─────────────────────────────────────────────────────────────────────

function runStatus(argv: string[]): void {
  const { flags } = parseFlags(argv);
  const ctx = ServerContext.initialize();
  try {
    const project = ctx.project;
    if (!project) {
      if (wantsJson(flags)) {
        printJson({ project: null, path: ctx.projectPath });
        return;
      }
      ptySection('MyJarbis · not initialized');
      ptyKV('Path', dim(ctx.projectPath));
      console.log('');
      ptyDim('Not a MyJarbis project. Run `myjarbis init` from this directory.');
      console.log('');
      return;
    }

    const active = readActiveModule(ctx.projectPath);
    const modules = ctx.db.modules.listByProject(project.id);
    const activeMod = active ? modules.find((m) => m.name === active) : null;

    let lastSession: { ended_at: string | null; next_session: string | null } | null = null;
    if (activeMod) {
      const last = ctx.db.sessions.findLastClosedByModule(activeMod.id);
      if (last) lastSession = { ended_at: last.ended_at, next_session: last.next_session };
    }

    const projCtxCount = (ctx.db.db.prepare('SELECT COUNT(*) AS n FROM project_context WHERE project_id=?').get(project.id) as { n: number }).n;
    const modCtxCounts = ctx.db.db.prepare(
      `SELECT m.name, COUNT(mc.id) AS total,
              SUM(CASE WHEN mc.kind='story' THEN 1 ELSE 0 END) AS stories,
              SUM(CASE WHEN mc.kind='story' AND mc.progress IS NOT NULL THEN 1 ELSE 0 END) AS stories_with_progress
       FROM modules m LEFT JOIN module_context mc ON mc.module_id=m.id
       WHERE m.project_id=? GROUP BY m.id ORDER BY m.name`,
    ).all(project.id) as Array<{ name: string; total: number; stories: number; stories_with_progress: number }>;
    const obsCount = (ctx.db.db.prepare(
      `SELECT COUNT(o.id) AS n FROM observations o JOIN sessions s ON s.id=o.session_id JOIN modules m ON m.id=s.module_id WHERE m.project_id=?`,
    ).get(project.id) as { n: number }).n;
    const skillsCount = (ctx.db.db.prepare('SELECT COUNT(*) AS n FROM skills WHERE project_id=?').get(project.id) as { n: number }).n;
    const sessAgg = ctx.db.db.prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN ended_at IS NOT NULL THEN 1 ELSE 0 END) AS closed
       FROM sessions s JOIN modules m ON m.id=s.module_id WHERE m.project_id=?`,
    ).get(project.id) as { total: number; closed: number };

    let git: { branch: string | null; ahead: number | null } = { branch: null, ahead: null };
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: ctx.projectPath, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      git.branch = branch;
      try {
        const ahead = execSync(`git rev-list --count origin/${branch}..HEAD`, { cwd: ctx.projectPath, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
        git.ahead = parseInt(ahead, 10);
      } catch {
        // No upstream / not pushed — leave ahead null
      }
    } catch {
      // Not a git repo
    }

    const data = {
      project: { name: project.name, path: project.path, framework: project.framework },
      active_module: active,
      active_module_status: activeMod?.status ?? null,
      active_module_description: activeMod?.description ?? null,
      last_session: lastSession
        ? {
            ended_at: lastSession.ended_at,
            next_session_excerpt: lastSession.next_session
              ? lastSession.next_session.slice(0, 200) + (lastSession.next_session.length > 200 ? '…' : '')
              : null,
          }
        : null,
      counts: {
        project_context: projCtxCount,
        modules_total: modules.length,
        module_context: modCtxCounts,
        observations: obsCount,
        skills: skillsCount,
        sessions: sessAgg,
      },
      git,
    };

    if (wantsJson(flags)) {
      printJson(data);
      return;
    }

    // ── Pretty render (matches install.sh blood-red minimal UI) ──
    ptySection('MyJarbis · ' + bold(project.name) + (project.framework ? dim(' (' + project.framework + ')') : ''));
    ptyKV('Path', dim(project.path));
    if (git.branch) {
      const aheadStr = git.ahead === null ? '' : git.ahead > 0 ? ` ${red('· ' + git.ahead + ' ahead of origin')}` : ' · in sync';
      ptyKV('Branch', bold(git.branch) + aheadStr);
    }

    ptySection('Active module');
    if (active && activeMod) {
      ptyKV('Name', red(bold(active)) + (activeMod.status !== 'active' ? dim(` (${activeMod.status})`) : ''));
      if (activeMod.description) ptyKV('About', dim(activeMod.description));
      if (lastSession?.ended_at) {
        ptyKV('Last close', stableDateLabel(lastSession.ended_at) + ' UTC');
        if (data.last_session?.next_session_excerpt) {
          console.log('');
          ptyLine('  ' + dim('"Resume here" excerpt:'));
          // Indent each line of the excerpt for visual grouping
          for (const ln of data.last_session.next_session_excerpt.split('\n').slice(0, 6)) {
            ptyLine('    ' + ln);
          }
        }
      } else {
        ptyKV('Last close', dim('no closed sessions yet'));
      }
    } else {
      ptyDim('(no active module — `myjarbis module use <name>` to set one)');
    }

    ptySection('Counts');
    const totalStories = modCtxCounts.reduce((a, m) => a + m.stories, 0);
    const storiesWithProgress = modCtxCounts.reduce((a, m) => a + m.stories_with_progress, 0);
    ptyKV('Modules', String(modules.length));
    ptyKV('Project ctx', String(projCtxCount) + dim(' entries'));
    ptyKV('Module ctx', `${modCtxCounts.reduce((a, m) => a + m.total, 0)} entries · ${totalStories} stories ${dim(`(${storiesWithProgress} with progress)`)}`);
    ptyKV('Observations', String(obsCount));
    ptyKV('Skills', String(skillsCount) + dim(' baselines materialized'));
    ptyKV('Sessions', `${sessAgg.closed} closed · ${sessAgg.total} total`);

    console.log('');
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
  //    .myjarbis/active is ALWAYS ignored — even with shared=true, it's
  //    per-user state (each developer picks their own active module).
  appendToGitignore(projectPath, ['.myjarbis/active']);
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
    stale_warning: (threshold: number) =>
      `⚠ Esta bitácora tiene más de ${threshold} día(s). Antes de continuar, confirmá con el usuario que el contexto sigue siendo válido (ramas, PRs, decisiones que pudieron cambiar).`,
    memory_contract: '[MyJarbis] Memory: prefer mcp__myjarbis__* tools over ~/.claude/projects/<slug>/memory/*.md (the latter is fallback only).',
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
    stale_warning: (threshold: number) =>
      `⚠ This resume note is more than ${threshold} day(s) old. Before continuing, confirm with the user that the context still applies (branches, PRs, decisions that may have moved).`,
    memory_contract: '[MyJarbis] Memory: prefer mcp__myjarbis__* tools over ~/.claude/projects/<slug>/memory/*.md (the latter is fallback only).',
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
    stale_warning: (threshold: number) =>
      `⚠ Esta nota de retomada tem mais de ${threshold} dia(s). Antes de continuar, confirme com o usuário que o contexto ainda se aplica (branches, PRs, decisões que podem ter mudado).`,
    memory_contract: '[MyJarbis] Memory: prefer mcp__myjarbis__* tools over ~/.claude/projects/<slug>/memory/*.md (the latter is fallback only).',
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

    // Active-module fast path: if `.myjarbis/active` is set (via
    // `myjarbis module use <name>`), auto-start the session for that
    // module and emit the greeting bundle. Skip the menu entirely.
    // The agent's /jarbis prompt then only needs to acknowledge and
    // continue — no tool calls, no menu rendering, no 42s/1000-token
    // overhead.
    const activeName = readActiveModule(ctx.projectPath);
    if (activeName) {
      const target = active.find((m) => m.name === activeName);
      if (target) {
        // Reuse an open session for this module if one exists, to avoid
        // accumulating zombie sessions when the user opens Claude
        // multiple times in a row.
        let openSession = ctx.db.sessions.findActiveByModule(target.id);
        if (!openSession) {
          openSession = ctx.db.sessions.start(target.id);
        }
        ctx.setActiveSession(openSession.id, target.id);
        const mat = materializeSkills(ctx, { module: target.name });
        const last = ctx.db.sessions.findLastClosedByModule(target.id);
        const blocks: string[] = [
          header,
          '',
          `Module: ${target.name}${target.description ? ` — ${target.description}` : ''}`,
          `Session #${openSession.id} ${openSession.started_at === openSession.ended_at ? 'started' : 'resumed'}.`,
          `Skills materialized: ${mat.written.length + mat.unchanged.length} (${mat.written.length} written, ${mat.removed.length} stale removed).`,
        ];
        if (last?.next_session) {
          blocks.push('', t.resume_label(target.name, stableDateLabel(last.ended_at)));
          blocks.push(last.next_session);
          const staleAfter = readStaleThreshold(ctx.projectPath);
          const staleness = computeStaleness(last.ended_at, staleAfter);
          if (staleness?.stale) {
            // The warning copy intentionally uses the threshold (stable per
            // settings) and not the live day count — keeps the hook output
            // byte-stable until the user changes the threshold.
            blocks.push('', t.stale_warning(staleAfter));
          }
        } else {
          blocks.push('', 'No previous session — starting fresh.');
        }
        blocks.push('', t.memory_contract);
        console.log(blocks.join('\n'));
        return;
      }
      // Active module file points to a module that no longer exists —
      // log a warning and fall through to the menu.
      console.error(`[MyJarbis] WARN: .myjarbis/active points to "${activeName}" which is not in the modules table. Falling back to menu.`);
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
      const staleAfter = readStaleThreshold(ctx.projectPath);
      const staleness = computeStaleness(mostRecent.ended_at, staleAfter);
      if (staleness?.stale) {
        lines.push('', t.stale_warning(staleAfter));
      }
    }
    lines.push('', t.memory_contract);
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
  /** Session-related knobs. */
  session?: {
    /** Days after which a previous next_session is considered stale and
     *  the SessionStart hook + start_session response surface a warning.
     *  Default 7. Disable by setting a very large number; 0/negative are
     *  ignored (fall back to default). */
    stale_after_days?: number;
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
// Subcommand: timeline
//
// Chronological feed of sessions + observations for a module. Reading
// the timeline is much faster than `load_module --full` when ramping
// back into a module that's been paused for weeks: you only need to
// know the sequence of decisions/sessions, not the body of every story.
// ─────────────────────────────────────────────────────────────────────

function runTimeline(argv: string[]): void {
  const { positional, flags } = parseFlags(argv);
  let moduleName = positional[0];
  const limit = typeof flags.limit === 'string' ? parseInt(flags.limit, 10) : 100;
  if (Number.isNaN(limit) || limit <= 0) {
    fail('Invalid --limit (must be a positive integer)');
  }

  const ctx = ServerContext.initialize();
  try {
    const project = ctx.project;
    if (!project) {
      fail('Not a MyJarbis project. Run `myjarbis init` first.');
    }

    if (!moduleName) {
      const active = readActiveModule(ctx.projectPath);
      if (active) {
        moduleName = active;
      } else {
        fail(
          'Usage: myjarbis timeline <module> [--limit=N] [--json]\n' +
          '       (no module given and no active module set — try `myjarbis module use <name>` first)',
        );
      }
    }

    const mod = ctx.db.modules.findByName(project.id, moduleName);
    if (!mod) {
      fail(`Module "${moduleName}" not found in project "${project.name}".`);
    }

    const events = ctx.db.timeline(mod.id, { limit });

    if (wantsJson(flags)) {
      printJson({
        project: project.name,
        module: mod.name,
        limit,
        count: events.length,
        events,
      });
      return;
    }

    // Pretty render. Matches install.sh / status palette: blood-red accents
    // on plain white, no boxes. One line per event with timestamp prefix.
    ptySection('MyJarbis · timeline of ' + red(bold(mod.name)) + dim(' (' + project.name + ')'));
    if (events.length === 0) {
      console.log('');
      ptyDim('No events yet — start a session in this module to populate the timeline.');
      console.log('');
      return;
    }
    console.log('');
    for (const ev of events) {
      const ts = stableDateLabel(ev.at) + ' UTC';
      if (ev.type === 'session_start') {
        console.log(`  ${dim(ts)}  ${bold('▶ session #' + ev.sessionId)}  started`);
      } else if (ev.type === 'session_end') {
        const tail = ev.summary ? '  ' + dim(ev.summary.slice(0, 80) + (ev.summary.length > 80 ? '…' : '')) : '';
        console.log(`  ${dim(ts)}  ${bold('■ session #' + ev.sessionId)}  closed · ${ev.observationsCount} obs${tail}`);
      } else {
        const sid = ev.storyLocalId ? ' [' + ev.storyLocalId + ']' : '';
        console.log(`  ${dim(ts)}  ${red('●')} ${bold(ev.kind)}${sid}  ${ev.title}`);
      }
    }
    console.log('');
    ptyDim(`${events.length} event(s) · newest first · limit ${limit}`);
    console.log('');
  } finally {
    ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────────────

export function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  if (!cmd) {
    fail('Usage: cli.js <import|module|skill|stats|cost|hook|init-project|timeline> [args...]');
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
      case 'config':
        return runConfig(rest);
      case 'status':
        return runStatus(rest);
      case 'timeline':
        return runTimeline(rest);
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
