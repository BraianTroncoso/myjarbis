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
