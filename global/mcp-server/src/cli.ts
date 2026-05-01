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
// Dispatcher
// ─────────────────────────────────────────────────────────────────────

export function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  if (!cmd) {
    fail('Usage: cli.js <import|module|skill|stats> [args...]');
  }
  try {
    switch (cmd) {
      case 'import':
        return runImport(rest);
      case 'module':
        return runModule(rest);
      case 'skill':
        return runSkill(rest);
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
