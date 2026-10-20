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
import { MyJarbisDB } from './db/index.js';
import { MyJarbisError } from './types.js';
import { importMd, importJson } from './tools/import.js';
import { listModules, createModule } from './tools/discovery.js';
import { listSkills, addSkill, materializeSkills } from './tools/skills.js';
import { startSession, readStaleThreshold, computeStaleness } from './tools/session.js';
import { applyInteractionStyle, inferCurrent } from './tools/interactionStyle.js';
import { seedNewProject } from './db/migrate.js';
import { ModuleRow, SessionRow, SCHEMA_VERSION } from './db/schema.js';
import {
  composeInteractionStyle,
  parseLanguage,
  parsePersona,
  personaLabel,
} from './personas.js';
import { computeCost, formatTable } from './tools/cost.js';
import { generateModuleDiagram, isDiagramAuto } from './diagram/generate.js';
import { exportBrain, importBrain, brainStatus } from './tools/brain.js';
import { autoCloseAll, AUTO_MARKER, truncate } from './tools/autoClose.js';
import {
  claimSession,
  hasOwnClaim,
  pruneStaleClaims,
  releaseClaim,
  sessionsClaimedByOthers,
} from './sessionOwnership.js';
import {
  clearActiveModules,
  parseModuleList,
  readActiveModules,
  readCompanionModules,
  readPrimaryModule,
  writeActiveModules,
} from './activeModules.js';
import { readPack, applyPack, PackApplyReport } from './org/pack.js';
import { syncOrg } from './org/sync.js';
import { readRegistry, readRegistryRaw } from './org/registry.js';
import {
  CLAUDE_HOOKS,
  HOOK_SCRIPT_DIR,
  hookCommand,
  isMyJarbisHookEntry,
  wiringState,
} from './hooks.js';
import { syncCommands, pendingFiles, CommandStatus } from './commands.js';
import { listContextKinds, migrateKinds } from './tools/kinds.js';
import {
  listWorkflowsTool,
  getWorkflow,
  listProviders,
  setProvider,
} from './tools/workflows.js';
import { getProjectState, setProjectState } from './tools/state.js';
import { upgradeBrain } from './db/upgrade.js';
import { mergeBrain } from './db/merge.js';
import { collectHealth } from './health.js';
import { collectReview, applyReview } from './review.js';
import { BASELINE_SKILLS } from './db/migrate.js';
import { sha256 } from './db/index.js';
import { runGarbageCollect } from './gc.js';
import { globalDbPath, siloDbPath, detectRemote, resolveProject } from './resolve.js';
import { openInVscode } from './diagram/open.js';
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
  green: '\x1b[38;5;65m',
  amber: '\x1b[38;5;136m',
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
// Green and amber exist only for `health`, where the whole point is that a
// number is read as a signal before it is read as a number. Everywhere else
// the palette stays red/bold/dim on purpose.
const green = (s: string) => c(ANSI.green, s);
const amber = (s: string) => c(ANSI.amber, s);

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
  if (!target) fail('--target is required (e.g. --target=project or --target=module:checkout)');
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
// The file now holds a list, primary first — see activeModules.ts for why.
// These wrappers keep the single-module reading that most call sites want:
// "the active module" is the primary, and always was.
function readActiveModule(projectPath: string): string | null {
  return readPrimaryModule(projectPath);
}

function writeActiveModule(projectPath: string, name: string): void {
  writeActiveModules(projectPath, [name]);
}

function clearActiveModule(projectPath: string): void {
  clearActiveModules(projectPath);
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
        ptyDim('No active module set. Use `myjarbis module use <name>` to pick one, or name several — `myjarbis module use cli,server` — to open them together (first = primary).');
      }
      console.log('');
      return;
    }
    if (sub === 'use') {
      const { positional, flags } = parseFlags(rest);
      // Several names, because work does not respect module boundaries. The
      // FIRST one is the primary: the session belongs to it and so does
      // everything that gets written. The rest come along read-only.
      const names = parseModuleList(positional);
      if (names.length === 0) fail('Usage: myjarbis module use <name> [<name>...]');
      const project = ctx.requireProject();

      // Resolve them all before writing anything. A half-applied selection is
      // worse than a rejected one: the hook would open on a primary the user
      // did not mean.
      const resolved: ModuleRow[] = [];
      const unknown: string[] = [];
      for (const name of names) {
        const m = ctx.db.modules.findByName(project.id, name);
        if (m) resolved.push(m);
        else unknown.push(name);
      }
      if (unknown.length > 0) {
        const which =
          unknown.length === 1
            ? `Module "${unknown[0]}" does not exist`
            : `These modules do not exist: ${unknown.join(', ')}`;
        fail(
          `${which}. Use \`myjarbis module list\` to see available modules, ` +
            `or \`myjarbis module create ${unknown[0]}\` to create one.`,
        );
      }

      writeActiveModules(
        ctx.projectPath,
        resolved.map((m) => m.name),
      );
      const [primary, ...companions] = resolved;

      if (wantsJson(flags)) {
        printJson({
          active: primary.name,
          description: primary.description,
          status: primary.status,
          primary: primary.name,
          companions: companions.map((m) => ({
            name: m.name,
            description: m.description,
            status: m.status,
          })),
        });
        return;
      }
      ptySection('MyJarbis · active module set');
      ptyKV('Primary', red(bold(primary.name)));
      if (primary.description) ptyKV('Description', primary.description);
      ptyKV('Status', primary.status);
      if (companions.length > 0) {
        console.log('');
        ptyKV('Also open', companions.map((m) => m.name).join(', '));
        ptyDim('read-only: their context loads and is searchable, nothing is');
        ptyDim(`written to them. Observations and the handoff go to ${primary.name}.`);
      }
      console.log('');
      ptyDim(
        companions.length > 0
          ? 'Open Claude in this directory — /jarbis will resume all of these.'
          : 'Open Claude in this directory — /jarbis will resume this module automatically.',
      );
      console.log('');
      return;
    }
    if (sub === 'current') {
      const { flags } = parseFlags(rest);
      const open = readActiveModules(ctx.projectPath);
      const [active, ...companions] = open;
      if (wantsJson(flags)) {
        // `active` stays the primary so anything reading this field keeps
        // working; `open` is the whole selection in order.
        printJson({ active: active ?? null, primary: active ?? null, companions, open });
        return;
      }
      if (active) {
        console.log(`${red('★')} ${bold(active)}${companions.length > 0 ? dim('  (primary)') : ''}`);
        for (const name of companions) console.log(`  ${dim('·')} ${name}${dim('  (read-only)')}`);
      } else {
        ptyDim('(no active module — run `myjarbis module use <name> [<name>...]`)');
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
      // applyInteractionStyle persists the language to settings.json itself
      // now, so the hook stays in step for every caller. It used to be done
      // here, which is why changing the language from inside Claude only
      // half-applied.
      const result = applyInteractionStyle(ctx, args);
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
    if (sub === 'diagram') {
      const { positional } = parseFlags(rest);
      const value = positional[0];
      const settings = readSettingsJson(ctx.projectPath);
      const current = settings.diagram?.auto === true;
      if (!value) {
        ptySection('MyJarbis · config');
        ptyKV('Diagram', current ? 'on (auto)' : 'off');
        console.log('');
        return;
      }
      const on = value === 'on' || value === 'true' || value === 'enable';
      const off = value === 'off' || value === 'false' || value === 'disable';
      if (!on && !off) fail('Usage: myjarbis config diagram <on|off>');
      const settingsPath = path.join(ctx.projectPath, '.myjarbis', 'config', 'settings.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      const next = { ...settings, diagram: { auto: on } };
      fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2) + '\n', 'utf-8');
      ptySection('MyJarbis · config');
      ptyLine('  ' + `Auto-diagram ${bold(on ? 'enabled' : 'disabled')}`);
      console.log('');
      return;
    }
    fail(`Unknown config subcommand: ${sub}. Use list | language | persona | diagram.`);
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
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN ended_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS closed,
              COALESCE(SUM(CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END), 0) AS open
       FROM sessions s JOIN modules m ON m.id=s.module_id WHERE m.project_id=?`,
    ).get(project.id) as { total: number; closed: number; open: number };

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

    const org = project.org_id === null ? null : ctx.db.orgs.findById(project.org_id);
    const brain = {
      path: ctx.db.dbPath,
      isolation: project.isolation,
      schema_version: ctx.db.schemaVersion,
      expected_schema_version: SCHEMA_VERSION,
      needs_migration: ctx.db.needsMigration,
    };

    const data = {
      project: {
        name: project.name,
        path: project.path,
        framework: project.framework,
        git_remote: project.git_remote,
        resolved_via: ctx.resolvedVia,
      },
      org: org ? { slug: org.slug, name: org.name, pack_rev: org.pack_rev } : null,
      brain,
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
    if (ctx.resolvedVia) {
      // Worth printing: "resolved by remote" vs "by path" is the difference
      // between a project that follows the repo and one pinned to a path.
      ptyKV('Resolved', dim('by ' + ctx.resolvedVia));
    }
    if (org) {
      ptyKV('Org', red(bold(org.slug)) + dim(org.pack_rev ? ` · pack ${org.pack_rev}` : ''));
    }
    ptyKV('Brain', dim(brain.path) + dim(` · ${brain.isolation}`));
    if (brain.needs_migration) {
      ptyKV(
        'Schema',
        red(bold(`v${brain.schema_version}`)) +
          red(` · expected v${brain.expected_schema_version} — run \`myjarbis migrate\``),
      );
    } else {
      ptyKV('Schema', dim(`v${brain.schema_version}`));
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
      ptyDim('(no active module — `myjarbis module use <name> [<name>...]` to set one)');
    }

    ptySection('Counts');
    const totalStories = modCtxCounts.reduce((a, m) => a + m.stories, 0);
    const storiesWithProgress = modCtxCounts.reduce((a, m) => a + m.stories_with_progress, 0);
    ptyKV('Modules', String(modules.length));
    ptyKV('Project ctx', String(projCtxCount) + dim(' entries'));
    ptyKV('Module ctx', `${modCtxCounts.reduce((a, m) => a + m.total, 0)} entries · ${totalStories} stories ${dim(`(${storiesWithProgress} with progress)`)}`);
    ptyKV('Observations', String(obsCount));
    ptyKV('Skills', String(skillsCount) + dim(' in the brain'));
    ptyKV(
      'Sessions',
      `${sessAgg.closed} closed · ${sessAgg.total} total` +
        (sessAgg.open > 0
          ? dim(` · ${sessAgg.open} open`) +
            (sessAgg.open > 1 ? red(' (auto-closed on exit)') : '')
          : ''),
    );

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
      'Usage: myjarbis skill <list|add|edit|delete|enable|disable|materialize|reseed> [args...]',
    );
  }

  // `reseed` is fleet-wide and must not resolve a project first.
  if (sub === 'reseed') return runSkillReseed(rest);

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
        if (!name) {
          fail('Usage: myjarbis skill edit <name> [--module=NAME] [--content-from=FILE]');
        }
        const project = ctx.requireProject();
        const moduleName = flags.module as string | undefined;
        const moduleId = moduleName ? ctx.requireModule(moduleName).id : null;

        const skill = ctx.db.skills.findByName(project.id, moduleId, name);
        if (!skill) fail(`Skill "${name}" not found${moduleName ? ` in module "${moduleName}"` : ' (project-level)'}`);

        // Non-interactive path. Without it `skill edit` always spawns $EDITOR,
        // which makes it unusable from a script or a provisioning run: the
        // editor inherits a non-tty stdin and dies with "Standard input is
        // not a terminal".
        const contentFrom = flags['content-from'] as string | undefined;
        let newContent: string;

        if (contentFrom) {
          if (!fs.existsSync(contentFrom)) fail(`File not found: ${contentFrom}`);
          newContent = fs.readFileSync(contentFrom, 'utf-8');
        } else {
          if (!process.stdin.isTTY) {
            fail(
              'skill edit needs a terminal to open $EDITOR. ' +
                'Pass --content-from=FILE to edit without one.',
            );
          }
          const editor = process.env.EDITOR || process.env.VISUAL || 'nano';
          const tmp = path.join(os.tmpdir(), `myjarbis-skill-${name}-${Date.now()}.md`);
          fs.writeFileSync(tmp, skill.content, 'utf-8');
          try {
            execSync(`${editor} "${tmp}"`, { stdio: 'inherit' });
          } catch {
            fail(`Editor "${editor}" failed`);
          }
          newContent = fs.readFileSync(tmp, 'utf-8');
          fs.unlinkSync(tmp);
        }

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


/**
 * Find the pack directory recorded for an org slug.
 *
 * `init --org=x` is normally run in a project that has never seen the pack,
 * so the path has to come from somewhere else: the brain being seeded, then
 * the shared brain, then any registered project. Returns null when the slug
 * is unknown, and the caller warns rather than failing — a project created
 * without its org layer is recoverable, a failed init is not.
 */
function resolvePackPath(ctx: ServerContext, slug: string): string | null {
  const local = ctx.db.orgs.findBySlug(slug);
  if (local?.pack_path && fs.existsSync(local.pack_path)) return local.pack_path;

  const candidates = [globalDbPath(), ...readRegistry().map((e) => siloDbPath(e.path))];
  for (const dbPath of candidates) {
    if (!fs.existsSync(dbPath)) continue;
    const db = MyJarbisDB.openExisting(dbPath);
    if (!db) continue;
    try {
      if (db.schemaVersion < 4) continue;
      const org = db.orgs.findBySlug(slug);
      if (org?.pack_path && fs.existsSync(org.pack_path)) return org.pack_path;
    } finally {
      db.close();
    }
  }
  return null;
}

function runInitProject(argv: string[]): void {
  const { flags } = parseFlags(argv);
  const name = flags.name as string | undefined;
  const framework = flags.framework as string | undefined;
  if (!name) {
    fail(
      'Usage: cli.js init-project --name=<project> [--framework=<fw>] ' +
        '[--shared=true|false] [--language=EN|ES|PT] ' +
        '[--persona=concise|pair|mentor|reviewer] [--org=<slug>] [--pack-path=<dir>] ' +
        '[--isolation=silo|shared]',
    );
  }

  // Validate language + persona early (before any DB write)
  const language = parseLanguage(flags.language as string | undefined);
  const persona = parsePersona(flags.persona as string | undefined);

  const projectPath = process.cwd();

  const isolationRaw = (flags.isolation as string | undefined) ?? 'silo';
  if (isolationRaw !== 'silo' && isolationRaw !== 'shared') {
    fail(`--isolation must be "silo" or "shared" (got "${isolationRaw}")`);
  }
  const isolationMode = isolationRaw as 'silo' | 'shared';

  // 1. seedNewProject (creates memory.db + project + _general module +
  //    10 baseline skills, idempotent)
  //
  // Record the git remote here. Without it `projects.git_remote` stays NULL
  // and the whole resolve-by-remote chain is inert for every new project —
  // it would only ever match projects whose remote some other command had
  // happened to set. The remote is what lets the same repo resolve from a
  // different path on a second machine, which is the case the portable brain
  // dump exists for.
  const detectedRemote = detectRemote(projectPath);
  const seed = seedNewProject(projectPath, {
    name,
    framework,
    gitRemote: detectedRemote,
    // NOTE: distinct from --shared, which decides whether memory.db is
    // git-ignored. This decides WHERE the rows live: its own file, or the
    // global brain. Defaults to 'silo', the pre-v0.3 layout.
    isolation: isolationMode,
  });

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
  //    `seed.dbPath` is where the rows actually went — the shared brain when
  //    isolation is 'shared'. Passing it is what stops init from creating an
  //    empty silo beside a shared project and shadowing it.
  const ctx = ServerContext.initializeForSeed(projectPath, seed.dbPath);
  let materialized;
  let packReport: PackApplyReport | undefined;
  try {
    addSkill(ctx, {
      name: 'interaction-style',
      content: composeInteractionStyle(language, persona),
      description: `Language: ${language} · Persona: ${personaLabel(persona)} (composed at init)`,
      trigger_pattern: 'always loaded; modulates tone, language, brevity',
    });

    // 3b. Apply the org pack, if one was named. This is the whole point of
    //     --org: the organization's skills, taxonomy, workflows and provider
    //     defaults arrive with the project instead of being taught to it
    //     afterwards, which is how two of three real projects ended up
    //     without that layer at all.
    const orgSlug = flags.org as string | undefined;
    if (orgSlug) {
      const packPath = (flags['pack-path'] as string | undefined) ?? resolvePackPath(ctx, orgSlug);
      if (!packPath) {
        console.error(
          `[MyJarbis] WARNING: --org=${orgSlug} given but no pack is registered ` +
            `under that slug and --pack-path was not passed. Project created ` +
            `WITHOUT the org layer; run \`myjarbis org add ${orgSlug} <path>\` to add it.`,
        );
      } else {
        packReport = applyPack(ctx, readPack(packPath), { skipMaterialize: true });
      }
    }

    // 4. Materialize project-level skills (no active session yet) so
    //    .claude/skills/myjarbis-interaction-style/SKILL.md reflects the
    //    composed content immediately. Runs after the pack so overrides
    //    reach disk, not just the database.
    materialized = materializeSkills(ctx, {});
  } finally {
    ctx.close();
  }

  // 4. Append .myjarbis/memory.db + .claude/skills/myjarbis-* to .gitignore
  //    when shared === false. (When true, the user wants them committed.)
  //    .myjarbis/active is ALWAYS ignored — even with shared=true, it's
  //    per-user state (each developer picks their own active module).
  //    settings.local.json is the same kind of thing one level out: it is
  //    the local-override half of Claude Code's settings pair, and it
  //    accumulates absolute paths from this machine. Leaving it untracked
  //    was how a project could commit one developer's allow-list.
  appendToGitignore(projectPath, ['.myjarbis/active', '.claude/settings.local.json']);
  if (settings.shared === false) {
    appendToGitignore(projectPath, [
      '.myjarbis/memory.db',
      '.myjarbis/memory.db-journal',
      '.myjarbis/memory.db-wal',
      '.myjarbis/memory.db-shm',
      // backupBrain() writes `memory.db.<label>.<timestamp>` plus its own
      // -wal/-shm. The four patterns above name the SQLite sidecars
      // exactly, so none of them match a backup.
      '.myjarbis/memory.db.*',
      '.claude/skills/myjarbis-*/',
      // Generated from templates/.claude/commands/<name>.<lang>.md, so they
      // belong with the materialised skills: with shared=true the user is
      // asking for MyJarbis's output to be committed and teammates get the
      // command; with shared=false it is this machine's copy and showed up
      // as untracked noise in every project.
      '.claude/commands/jarbis*.md',
    ]);
  }

  printJson({
    project: {
      id: seed.projectId,
      name,
      framework: framework ?? null,
      path: projectPath,
      git_remote: detectedRemote,
      isolation: isolationMode,
    },
    brain_path: seed.dbPath,
    schema_version: SCHEMA_VERSION,
    seeded: { module_id: seed.moduleId, baseline_skills: seed.skills },
    interaction_style: { language, persona, label: personaLabel(persona) },
    settings_path: settingsPath,
    materialized_skills: {
      written: materialized.written.length,
      unchanged: materialized.unchanged.length,
      removed: materialized.removed.length,
      // What matters is how many the agent can actually see on disk.
      on_disk: materialized.written.length + materialized.unchanged.length,
    },
    org: packReport
      ? {
          slug: packReport.org.slug,
          rev: packReport.org.rev,
          skills: packReport.skills.length,
          context_kinds: packReport.contextKinds.length,
          workflows: packReport.workflows.length,
          providers: packReport.providers.length,
          warnings: packReport.warnings,
        }
      : null,
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
  // The header used to carry a version ("# MyJarbis (v0.2)") and went stale
  // the moment it shipped. Matching on the prefix recognises the old header
  // too, so a project initialised before this keeps one block instead of
  // growing a second one.
  const block =
    (existing && !existing.endsWith('\n') ? '\n' : '') +
    (existing.includes('# MyJarbis') ? '' : '\n# MyJarbis — generated, per-developer state\n') +
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
  if (!event) fail('Usage: cli.js hook <session-start|session-stop|session-end|post-compaction|user-prompt-submit|git-post-commit|install>');

  switch (event) {
    case 'session-start':
      return runHookSessionStart();
    case 'post-compaction':
      return runHookPostCompaction();
    case 'session-stop':
      return runHookSessionStop();
    case 'session-end':
      return runHookSessionEnd();
    case 'user-prompt-submit':
      return runHookUserPromptSubmit(rest);
    case 'git-post-commit':
      return runHookGitPostCommit();
    case 'install':
      return runHookInstall(rest);
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

/**
 * How much of a module's description the menu shows.
 *
 * The menu exists to pick a module, not to read about one. At 19 modules
 * averaging 376 characters, printing the whole field cost 7.1 KB of the
 * 11.2 KB menu — and the agent's documented response to being handed that
 * much was to go re-query the database for what it already had. 100 chars
 * is enough to tell two verticals apart; `load_module` has the rest.
 */
const MENU_DESC_LEN = 100;

/** Localized strings for the SessionStart menu — rendered server-side
 *  so the agent doesn't have to re-format from a markdown spec each
 *  session (saves ~28s of reasoning + the output tokens). */
const HOOK_I18N = {
  es: {
    no_project_title: 'MyJarbis',
    no_project_body: (cwd: string) =>
      `No hay proyecto MyJarbis en ${cwd}.\nCorré \`myjarbis init\` desde este directorio para habilitar memoria persistente.`,
    no_modules_body: (header: string) =>
      `${header}\n\nNo hay módulos registrados todavía.\nCreá uno con: \`myjarbis module add <name>\`\n(Los módulos son verticales: ej. checkout, catalog, Translations.)`,
    modules_label: (n: number) => `Módulos (${n}) · ▸ = último trabajado`,
    paused_tag: ' (en pausa)',
    no_sessions_tag: 'sin sesiones',
    menu_actions:
      'nombre o número → arrancar · varios con coma → multi-módulo (el primero manda) · "nuevo módulo <name>" · "settings"',
    resume_label: (mod: string, ts: string) => `── Última "Retomar aquí" (${mod}, ${ts} UTC) ──`,
    curated_label: (mod: string, ts: string, buried: number) =>
      `── "Retomar aquí" REAL, escrita a mano (${mod}, ${ts} UTC) — estaba tapada por ${buried} cierre(s) automático(s) ──`,
    curated_note:
      'El último cierre del módulo lo escribió la máquina: quedó abierta una sesión y se cerró sola. Lo de abajo es la última bitácora escrita a mano. Es anterior, así que confirmá con el usuario qué pasó en el medio antes de actuar.',
    stale_warning: (threshold: number) =>
      `⚠ Esta bitácora tiene más de ${threshold} día(s). Antes de continuar, confirmá con el usuario que el contexto sigue siendo válido (ramas, PRs, decisiones que pudieron cambiar).`,
    memory_contract: '[MyJarbis] Memory: prefer mcp__myjarbis__* tools over ~/.claude/projects/<slug>/memory/*.md (the latter is fallback only).',
  },
  en: {
    no_project_title: 'MyJarbis',
    no_project_body: (cwd: string) =>
      `No MyJarbis project at ${cwd}.\nRun \`myjarbis init\` from this directory to enable persistent memory.`,
    no_modules_body: (header: string) =>
      `${header}\n\nNo modules registered yet.\nCreate one with: \`myjarbis module add <name>\`\n(Modules are verticals: e.g., checkout, catalog, Translations.)`,
    modules_label: (n: number) => `Modules (${n}) · ▸ = last worked in`,
    paused_tag: ' (paused)',
    no_sessions_tag: 'no sessions',
    menu_actions:
      'name or number → start · several comma-separated → multi-module (first one is primary) · "new module <name>" · "settings"',
    resume_label: (mod: string, ts: string) => `── Last "Resume here" (${mod}, ${ts} UTC) ──`,
    curated_label: (mod: string, ts: string, buried: number) =>
      `── The REAL "Resume here", human-written (${mod}, ${ts} UTC) — it was buried under ${buried} automatic close(s) ──`,
    curated_note:
      'The newest close in this module was machine-written: a session was left open and closed itself. What follows is the last handoff a person wrote. It is older, so confirm with the user what happened in between before acting on it.',
    stale_warning: (threshold: number) =>
      `⚠ This resume note is more than ${threshold} day(s) old. Before continuing, confirm with the user that the context still applies (branches, PRs, decisions that may have moved).`,
    memory_contract: '[MyJarbis] Memory: prefer mcp__myjarbis__* tools over ~/.claude/projects/<slug>/memory/*.md (the latter is fallback only).',
  },
  pt: {
    no_project_title: 'MyJarbis',
    no_project_body: (cwd: string) =>
      `Sem projeto MyJarbis em ${cwd}.\nRode \`myjarbis init\` deste diretório para habilitar memória persistente.`,
    no_modules_body: (header: string) =>
      `${header}\n\nNenhum módulo registrado ainda.\nCrie um com: \`myjarbis module add <name>\`\n(Módulos são verticais: ex. checkout, catalog, Translations.)`,
    modules_label: (n: number) => `Módulos (${n}) · ▸ = último trabalhado`,
    paused_tag: ' (em pausa)',
    no_sessions_tag: 'sem sessões',
    menu_actions:
      'nome ou número → começar · vários com vírgula → multi-módulo (o primeiro manda) · "novo módulo <name>" · "settings"',
    resume_label: (mod: string, ts: string) => `── Última "Retomar aqui" (${mod}, ${ts} UTC) ──`,
    curated_label: (mod: string, ts: string, buried: number) =>
      `── "Retomar aqui" REAL, escrita à mão (${mod}, ${ts} UTC) — estava coberta por ${buried} fechamento(s) automático(s) ──`,
    curated_note:
      'O último fechamento do módulo foi escrito pela máquina: uma sessão ficou aberta e se fechou sozinha. O que vem abaixo é a última retomada escrita por uma pessoa. É anterior, então confirme com o usuário o que aconteceu no meio antes de agir.',
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

/**
 * Claude Code's hook payload, read from stdin.
 *
 * Every hook event gets a JSON object on stdin; the field that matters here is
 * `session_id`, the editor's own identifier for this Claude session. It is the
 * only thing that tells one Claude process from another, which is what
 * sessionOwnership.ts needs to stop an exiting process from closing a session
 * a newly started one just opened.
 *
 * Same guard as runHookUserPromptSubmit: only read when stdin is not a TTY, so
 * a hook invoked by hand does not hang waiting for input. Anything unparseable
 * yields no id, and the callers treat that as "ownership unknown".
 */
function readHookPayload(): { sessionId: string | null } {
  if (process.stdin.isTTY) return { sessionId: null };
  try {
    const raw = fs.readFileSync(0, 'utf-8');
    if (!raw.trim()) return { sessionId: null };
    const parsed = JSON.parse(raw);
    const id = parsed?.session_id;
    return { sessionId: typeof id === 'string' && id ? id : null };
  } catch {
    return { sessionId: null };
  }
}

function runHookSessionStart(): void {
  // Before the context is opened: stdin is only readable once, and the claim
  // written at the end of this function needs the id.
  const { sessionId: claudeSessionId } = readHookPayload();

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
    const activeName = readPrimaryModule(ctx.projectPath);
    if (activeName) {
      const target = active.find((m) => m.name === activeName);
      if (target) {
        // Companions, resolved against the modules table. A name that no
        // longer names a module is dropped with a warning rather than
        // aborting the greeting: the primary still works, and a selection
        // that silently fails is worse than one that says what it skipped.
        const companionRows: ModuleRow[] = [];
        for (const name of readCompanionModules(ctx.projectPath)) {
          const found = active.find((m) => m.name === name);
          if (found) companionRows.push(found);
          else
            console.error(
              `[MyJarbis] WARN: .myjarbis/active lists "${name}", which is not an ` +
                `active module. Skipping it. Fix with: myjarbis module use ${[
                  activeName,
                  ...readCompanionModules(ctx.projectPath).filter((n) => n !== name),
                ].join(',')}`,
            );
        }
        // Reuse an open session for this module if one exists, to avoid
        // accumulating zombie sessions when the user opens Claude
        // multiple times in a row.
        let openSession = ctx.db.sessions.findActiveByModule(target.id);
        // Whether we opened it or adopted one already open. Taken here rather
        // than inferred later from the row: a freshly started session has
        // `ended_at` NULL, so the `started_at === ended_at` test this used to
        // do was false for BOTH cases and the banner announced every session as
        // "resumed" — including the one it had just created. That is not
        // cosmetic. It is the line a session reads to decide whether there is
        // prior context to pick up, and it was wrong every single time.
        const sessionWasCreated = !openSession;
        if (!openSession) {
          openSession = ctx.db.sessions.start(target.id);
        }
        ctx.setActiveSession(openSession.id, target.id);
        // Say out loud that this editor session is using this brain session,
        // so the SessionEnd of a Claude that is still shutting down cannot
        // close it underneath us. See sessionOwnership.ts.
        claimSession(claudeSessionId, project.id, openSession.id);
        pruneStaleClaims();
        // Living diagram: regenerate for this module and pop it open in VS Code.
        if (isDiagramAuto(ctx.projectPath)) {
          try {
            const dia = generateModuleDiagram(ctx, target.name);
            if (dia.ok && dia.path) openInVscode(dia.path, ctx.projectPath);
          } catch {
            /* best-effort: never block session start */
          }
        }
        const mat = materializeSkills(ctx, { module: target.name });
        const last = ctx.db.sessions.findLastClosedByModule(target.id);
        const blocks: string[] = [
          header,
          '',
          `Module: ${target.name}${target.description ? ` — ${target.description}` : ''}` +
            (companionRows.length > 0 ? '  (primary)' : ''),
          `Session #${openSession.id} ${sessionWasCreated ? 'started' : 'resumed'}.`,
          `Skills materialized: ${mat.written.length + mat.unchanged.length} (${mat.written.length} written, ${mat.removed.length} stale removed).`,
        ];

        // Companions: index depth only. The primary's context is what the
        // session is for; a companion is here so its decisions are visible and
        // searchable, and loading its bodies would spend the window before any
        // work starts. Each line carries the one fact that decides whether to
        // go deeper — when it was last worked in — and its handoff is offered
        // as a pointer rather than inlined, for the same reason.
        if (companionRows.length > 0) {
          blocks.push('', `Also open (read-only, index only): ${companionRows.length}`);
          for (const c of companionRows) {
            const total = ctx.db.moduleContext.countByModule(c.id);
            const lastClosed = ctx.db.sessions.findLastClosedByModule(c.id);
            const when = lastClosed?.ended_at
              ? `last worked ${stableDateLabel(lastClosed.ended_at)}`
              : 'no closed session yet';
            blocks.push(
              `  · ${c.name}${c.description ? ` — ${c.description}` : ''}` +
                `  [${total} row(s), ${when}]`,
            );
          }
          blocks.push(
            `  Nothing is written to them: observations, progress and the handoff` +
              ` go to ${target.name}.`,
            `  For a companion's detail: search(query, module="<name>") then` +
              ` load_module(module="<name>", row_ids=[...]).`,
          );
        }
        if (last?.next_session) {
          const staleAfter = readStaleThreshold(ctx.projectPath);
          // When the newest close is machine-written, the handoff a person
          // wrote is underneath it and this is the only place the user would
          // ever see it. Print that one instead: the synthetic text says
          // nothing the agent cannot re-derive, and printing both doubles the
          // block for no gain.
          const curated = last.next_session.startsWith(AUTO_MARKER)
            ? ctx.db.sessions.findLastCuratedByModule(target.id)
            : null;
          const show = curated?.next_session ? curated : last;

          if (curated?.next_session) {
            const buried = ctx.db.sessions.countClosedAfterInModule(target.id, curated);
            blocks.push('', t.curated_note);
            blocks.push(
              '',
              t.curated_label(target.name, stableDateLabel(curated.ended_at), buried),
            );
          } else {
            blocks.push('', t.resume_label(target.name, stableDateLabel(last.ended_at)));
          }
          blocks.push(show.next_session!);

          const staleness = computeStaleness(show.ended_at, staleAfter);
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
    //
    // ONE pass over the modules, not two. The last close of each module is
    // needed twice — for its date tag and to decide which module was worked
    // in most recently — and querying it twice was the shape that let the
    // menu grow without anyone noticing the cost.
    //
    // The module is still picked by the most recent CLOSE, which is the
    // signal for "what was being worked on last" — an automatic close counts
    // as activity. What changes is the text: if that module's newest close is
    // machine-written, the handoff a person wrote lives underneath it, and
    // printing the synthetic one instead tells the user nothing.
    let mostRecent:
      | { mod: string; moduleId: number; ended_at: string; sessionId: number }
      | null = null;
    const rows: { module: (typeof active)[number]; last: SessionRow | null }[] = [];
    for (const m of active) {
      const last = ctx.db.sessions.findLastClosedByModule(m.id);
      if (last?.ended_at && last.next_session) {
        if (!mostRecent || last.ended_at > mostRecent.ended_at) {
          mostRecent = {
            mod: m.name,
            moduleId: m.id,
            ended_at: last.ended_at,
            sessionId: last.id,
          };
        }
      }
      rows.push({ module: m, last });
    }
    const highlight: string | null = mostRecent ? mostRecent.mod : null;

    // The description is CLIPPED. A project with twenty modules carrying a
    // paragraph each turned this menu into 11 KB the model had to read before
    // it could ask a one-word question — and what it does with that is
    // deliberate: it goes and re-queries what it was already handed. One line
    // per module is what picking one actually requires; the full text is a
    // `load_module` away.
    const lines: string[] = [header, '', t.modules_label(active.length)];
    const width = Math.max(...active.map((m) => m.name.length));
    rows.forEach(({ module: m, last }, idx) => {
      // The most recently worked module is marked rather than reordered:
      // alphabetical order is what makes a 19-item list scannable, and
      // hoisting one entry costs that for everyone else.
      const mark = highlight === m.name ? '▸' : ' ';
      const num = `${idx + 1}.`.padStart(3);
      const pausedTag = m.status === 'paused' ? t.paused_tag : '';
      const sessionTag = last?.ended_at
        ? stableDateLabel(last.ended_at).slice(0, 10)
        : t.no_sessions_tag;
      const head = `${mark}${num} ${m.name.padEnd(width)}${pausedTag}  ${sessionTag}`;
      const desc = m.description ? `  ${truncate(m.description, MENU_DESC_LEN)}` : '';
      lines.push(`${head}${desc}`);
    });

    lines.push('', t.menu_actions);
    if (mostRecent) {
      const last = ctx.db.sessions.findById(mostRecent.sessionId)!;
      const curated = last.next_session!.startsWith(AUTO_MARKER)
        ? ctx.db.sessions.findLastCuratedByModule(mostRecent.moduleId)
        : null;
      const show = curated?.next_session ? curated : last;

      if (curated?.next_session) {
        const buried = ctx.db.sessions.countClosedAfterInModule(
          mostRecent.moduleId,
          curated,
        );
        lines.push('', t.curated_note);
        lines.push(
          '',
          t.curated_label(mostRecent.mod, stableDateLabel(curated.ended_at), buried),
        );
      } else {
        lines.push('', t.resume_label(mostRecent.mod, stableDateLabel(mostRecent.ended_at)));
      }
      lines.push(show.next_session!);

      const staleAfter = readStaleThreshold(ctx.projectPath);
      const staleness = computeStaleness(show.ended_at, staleAfter);
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

/**
 * SessionEnd hook — close any open session, by default, without being asked.
 *
 * This is the SessionEnd event, NOT Stop. Stop fires after every single
 * agent turn, so closing there would end the session after the first
 * response. SessionEnd fires when the session actually ends.
 *
 * MyJarbis is installed on top of Claude Code so that this bookkeeping does
 * not depend on the agent having remembered. Opt out with
 * settings.session.auto_close_on_exit = false; it is on by default, because
 * the failure it prevents (a session with no summary, so `resume` returns
 * nothing and module listings lose their ordering signal) is silent.
 */
function runHookSessionEnd(): void {
  // Read before opening the context, same as SessionStart: stdin yields once.
  const { sessionId: claudeSessionId } = readHookPayload();

  const init = safeContext();
  if (!init) return;
  const { ctx } = init;
  try {
    const project = ctx.project;
    if (!project) return;

    const settings = readSettingsJson(ctx.projectPath);
    const enabled = settings.session?.auto_close_on_exit !== false;

    if (enabled) {
      // Sessions another Claude process has claimed are off limits. Without
      // this, the restart sequence — new SessionStart, then old SessionEnd —
      // closed the session the new process had just opened, and stamped it
      // "0m open, 0 observations" over the top of the user's live session.
      const protectedIds = sessionsClaimedByOthers(claudeSessionId, project.id);
      const closed = autoCloseAll(ctx, { skip: protectedIds });
      for (const c of closed) {
        console.error(
          `[MyJarbis hook] auto-closed session #${c.sessionId} in "${c.module}" ` +
            `(${c.observations} observation(s), ${c.durationMinutes}m, ` +
            `resume point from ${c.nextSessionSource}).`,
        );
      }
      if (protectedIds.size > 0) {
        // Logged rather than silent: "nothing to close" and "left someone
        // else's session alone" are different events, and the second one is
        // the one worth seeing when a close seems to be missing.
        console.error(
          `[MyJarbis hook] left ${protectedIds.size} session(s) open — in use by ` +
            `another Claude session (#${[...protectedIds].join(', #')}).`,
        );
        // The one way this fix can misbehave, surfaced instead of hidden: we
        // were given an id, we skipped sessions on the strength of it, and yet
        // no claim carries that id. Either SessionStart opened nothing (normal
        // — the module menu path), or the id is not stable across a session's
        // two hooks, which Claude Code's docs do not actually promise. If this
        // line shows up next to sessions that should have closed, that is the
        // answer. sessionOwnership.ts explains the fallback.
        if (claudeSessionId && !hasOwnClaim(claudeSessionId)) {
          console.error(
            `[MyJarbis hook] no claim of our own (session_id ${claudeSessionId}) — ` +
              `only unclaimed sessions were closed. start_session will close ours later.`,
          );
        }
      }
      if (closed.length === 0 && protectedIds.size === 0) {
        console.error('[MyJarbis hook] no open session to close.');
      }
    }

    // Our claim dies with the editor session that made it, whether or not
    // anything was closed above.
    releaseClaim(claudeSessionId);

    // The dump has to be refreshed AFTER the close, or it ships a brain
    // whose newest session still looks open.
    if (settings.brain?.auto_export_on_session_end) {
      try {
        const res = exportBrain(ctx);
        if (res.changed) {
          console.error(`[MyJarbis hook] brain dump updated (${res.filesWritten.length} file(s)).`);
        }
      } catch (err) {
        console.error(
          `[MyJarbis hook] brain export failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (settings.skills?.cleanup_module_skills_on_session_end) {
      const m = materializeSkills(ctx, {});
      console.error(`[MyJarbis hook] cleanup removed ${m.removed.length} module skill(s).`);
    }
  } catch (err) {
    // A hook must never be the reason a user cannot close their editor.
    console.error(
      `[MyJarbis hook] session-end failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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

    // Living diagram: refresh the active module's diagram as the session ends.
    if (isDiagramAuto(ctx.projectPath)) {
      generateModuleDiagram(ctx);
    }

    // Refresh the NDJSON dump before the open-session check below returns
    // early: even an unclosed session should leave a dump that matches the
    // DB, otherwise the next `git commit` ships a stale brain.
    if (readSettingsJson(ctx.projectPath).brain?.auto_export_on_session_end) {
      try {
        const res = exportBrain(ctx);
        if (res.changed) {
          console.error(`[MyJarbis hook] brain dump updated (${res.filesWritten.length} file(s)).`);
        }
      } catch (err) {
        // Never let a dump failure block the user from closing Claude.
        console.error(
          `[MyJarbis hook] brain export failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // If there's an open session, remind the agent to close it.
    const modules = ctx.db.modules.listByProject(project.id);
    for (const m of modules) {
      const open = ctx.db.sessions.findActiveByModule(m.id);
      if (open) {
        const obs = ctx.db.observations.listBySession(open.id).length;
        console.log(
          `═══ MyJarbis · open session ═══\n` +
          `Session #${open.id} in module "${m.name}" (${obs} observation(s)).\n` +
          `It WILL be closed automatically on exit with a generated summary, so ` +
          `nothing is lost either way.\n` +
          `Calling \`end_session(summary, next_session)\` yourself is still better: ` +
          `the generated one records what happened, it cannot say what you meant ` +
          `to do next.`,
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

// ─────────────────────────────────────────────────────────────────────
// hook git-post-commit
//
// Fired by the per-project .git/hooks/post-commit script (installed by
// `myjarbis hook install`). Reads HEAD, detects a story_local_id via
// the configured story_pattern, finds the active module's open session,
// and persists a `progress` observation tagged "auto,git-post-commit".
//
// Silently exits 0 when MyJarbis isn't initialized, no module is active,
// no session is open, or git produces unexpected output. We never want
// to interfere with the user's commit flow — the hook is best-effort.
// ─────────────────────────────────────────────────────────────────────

function runHookGitPostCommit(): void {
  const init = safeContext();
  if (!init) return;
  const { ctx } = init;
  try {
    const project = ctx.project;
    if (!project) return;

    // Latest commit metadata. Each call is wrapped so a missing git binary
    // or a non-repo cwd silently no-ops.
    const headHash = safeGit(ctx.projectPath, ['rev-parse', 'HEAD']);
    if (!headHash) return;
    const shortHash = headHash.slice(0, 8);
    const fullMessage =
      safeGit(ctx.projectPath, ['log', '-1', '--pretty=%B', 'HEAD']) ?? '';
    const firstLine = fullMessage.split(/\r?\n/, 1)[0] ?? '';
    const branch = safeGit(ctx.projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const filesRaw = safeGit(ctx.projectPath, [
      'diff-tree',
      '--name-only',
      '--no-commit-id',
      '-r',
      'HEAD',
    ]);
    const files = filesRaw
      ? filesRaw
          .split(/\r?\n/)
          .filter((s) => s.length > 0)
          .slice(0, 25) // cap to keep the row small
          .join(',')
      : null;

    // Story detection: branch name first, then commit message. The
    // story_pattern setting is reused as-is for symmetry with the
    // UserPromptSubmit hook.
    const settings = readSettingsJson(ctx.projectPath);
    const storyPattern = settings.story_pattern as string | undefined;
    let storyLocalId: string | null = null;
    if (storyPattern) {
      try {
        const re = new RegExp(storyPattern);
        const fromBranch = branch ? branch.match(re) : null;
        const fromMessage = fullMessage.match(re);
        storyLocalId = fromBranch?.[0] ?? fromMessage?.[0] ?? null;
      } catch {
        // Bad regex — ignore.
      }
    }

    // Find active module + its open session. If either is missing, exit
    // silently — the user just committed; we don't want to spam stderr.
    const activeName = readActiveModule(ctx.projectPath);
    if (!activeName) return;
    const mod = ctx.db.modules.findByName(project.id, activeName);
    if (!mod) return;
    const openSession = ctx.db.sessions.findActiveByModule(mod.id);
    if (!openSession) return;

    // Skip if we already auto-recorded this exact hash (idempotent re-runs
    // of the post-commit hook after `git commit --amend`, etc.). Cheap
    // LIKE on the title column.
    const dup = ctx.db.db
      .prepare(
        `SELECT id FROM observations
          WHERE session_id = ?
            AND kind = 'progress'
            AND title LIKE ?
            AND tags LIKE '%git-post-commit%'
          LIMIT 1`,
      )
      .get(openSession.id, `commit ${shortHash}%`) as { id: number } | undefined;
    if (dup) return;

    ctx.db.observations.add({
      sessionId: openSession.id,
      kind: 'progress',
      title: `commit ${shortHash}${firstLine ? ' · ' + firstLine.slice(0, 60) : ''}`,
      content: fullMessage.trim() || `(commit ${headHash} had an empty message)`,
      storyLocalId: storyLocalId ?? undefined,
      files: files ?? undefined,
      tags: 'auto,git-post-commit',
    });
    // Best-effort log to stderr so a tail -f .git/hooks debugging session
    // sees what happened. The actual git commit output stays clean.
    console.error(
      `[MyJarbis] auto-observation saved for commit ${shortHash}` +
        (storyLocalId ? ` (story ${storyLocalId})` : '') +
        ` in module "${mod.name}".`,
    );
  } catch (err) {
    // Best-effort: never fail the user's commit. Log to stderr so issues
    // surface during debugging without disrupting normal flow.
    console.error(
      '[MyJarbis hook git-post-commit] non-fatal:',
      err instanceof Error ? err.message : err,
    );
  } finally {
    ctx.close();
  }
}

/** Tiny wrapper over execSync that returns trimmed stdout or null on
 *  failure. Used by runHookGitPostCommit so a missing git binary / non
 *  git repo never throws. */
function safeGit(cwd: string, args: string[]): string | null {
  try {
    return execSync('git ' + args.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(' '), {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// hook install claude
//
// Binds the .claude-plugin/scripts/*.sh to Claude Code's lifecycle.
//
// Copying .claude-plugin/ into a project is NOT enough: Claude Code only
// reads a plugin's hooks.json for plugins installed from a marketplace
// (`claude plugin install`), and it never auto-discovers a .claude-plugin/
// directory sitting in the working tree. So a project initialised by
// `myjarbis init` had all four events dead — the greeting, the module
// menu, the pre-compaction snapshot and the auto-close — while the
// scripts themselves worked fine when run by hand.
//
// The fix is to declare the same four events in a settings file Claude
// Code actually reads. We use .claude/settings.local.json because `init`
// already gitignores it as per-developer state (see appendToGitignore
// above), so wiring the hooks leaves nothing to commit in a user's repo.
// ─────────────────────────────────────────────────────────────────────

// CLAUDE_HOOKS, hookCommand and isMyJarbisHookEntry now live in
// ./hooks.js, shared with health.ts so that the writer of the wiring and
// the detector of a missing wiring cannot drift apart. See that file.

interface WireReport {
  file: string;
  /** "SessionStart (startup|resume|clear) → session-start.sh" per bound event. */
  wired: string[];
  /** Our own entries found and rewritten, rather than duplicated. */
  replaced: number;
  /** The user's own hook entries on the same events, left as they were. */
  kept: number;
  /** Scripts named in CLAUDE_HOOKS that are not on disk or not executable. */
  unusable: string[];
  /** False when the file already said exactly this — nothing was written. */
  changed: boolean;
}


function wireClaudeHooks(projectPath: string, dryRun = false): WireReport {
  const file = path.join(projectPath, '.claude', 'settings.local.json');

  let settings: Record<string, unknown> = {};
  let before = '';
  if (fs.existsSync(file)) {
    before = fs.readFileSync(file, 'utf-8');
    try {
      const parsed = JSON.parse(before);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(`${file} is not a JSON object — refusing to overwrite it.`);
      }
      settings = parsed as Record<string, unknown>;
    } catch (err) {
      // Never clobber this file: it carries the user's permission
      // allowlist, and malformed JSON silently disables every setting in
      // it, so a blind rewrite would lose real configuration.
      fail(
        `${file} is not valid JSON (${err instanceof Error ? err.message : err}). ` +
          'Fix it by hand, then re-run — MyJarbis will not overwrite it.'
      );
    }
  }

  const hooksBlock: Record<string, unknown[]> =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? ({ ...(settings.hooks as Record<string, unknown[]>) } as Record<string, unknown[]>)
      : {};

  const report: WireReport = {
    file,
    wired: [],
    replaced: 0,
    kept: 0,
    unusable: [],
    changed: false,
  };

  // Group by event first, so the two SessionStart entries land in one array.
  const byEvent = new Map<string, unknown[]>();
  for (const h of CLAUDE_HOOKS) {
    const script = path.join(projectPath, HOOK_SCRIPT_DIR, h.script);
    try {
      fs.accessSync(script, fs.constants.X_OK);
    } catch {
      report.unusable.push(h.script);
      continue;
    }
    const entry: Record<string, unknown> = {};
    if (h.matcher) entry.matcher = h.matcher;
    entry.hooks = [{ type: 'command', command: hookCommand(h.script), timeout: h.timeout }];

    const list = byEvent.get(h.event) ?? [];
    list.push(entry);
    byEvent.set(h.event, list);
    report.wired.push(`${h.event}${h.matcher ? ` (${h.matcher})` : ''} → ${h.script}`);
  }

  for (const [event, ours] of byEvent) {
    const existing = Array.isArray(hooksBlock[event]) ? hooksBlock[event] : [];
    const foreign = existing.filter((e) => !isMyJarbisHookEntry(e));
    report.replaced += existing.length - foreign.length;
    report.kept += foreign.length;
    // Ours go first so the session greeting is injected before any hook
    // the user added on the same event can write to stdout.
    hooksBlock[event] = [...ours, ...foreign];
  }

  settings.hooks = hooksBlock;
  const after = JSON.stringify(settings, null, 2) + '\n';
  // `changed` means "the file on disk does not already say this", which is
  // what --check reports on without writing anything.
  report.changed = after !== before;
  if (report.changed && !dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, after, 'utf-8');
  }
  return report;
}

// ─────────────────────────────────────────────────────────────────────
// hook install [git-post-commit]
//
// Writes a per-project .git/hooks/post-commit that calls
// `myjarbis hook git-post-commit`. Idempotent: if our marker is already
// in the file, we no-op. If a different hook already exists, we refuse
// and tell the user how to install manually.
// ─────────────────────────────────────────────────────────────────────

const POST_COMMIT_MARKER = '# MyJarbis git-post-commit hook v1';
const POST_COMMIT_SCRIPT = `#!/usr/bin/env bash
${POST_COMMIT_MARKER}
# Saves a 'progress' observation for the latest commit into the active
# module's open session. Silently no-ops when MyJarbis is not set up,
# no module is active, or no session is open.
command -v myjarbis >/dev/null 2>&1 || exit 0
( cd "$(git rev-parse --show-toplevel 2>/dev/null)" && myjarbis hook git-post-commit ) >/dev/null 2>&1 || true
`;

function runHookInstall(rest: string[]): void {
  const which = rest[0] ?? 'git-post-commit';
  if (which === 'claude') {
    return runHookInstallClaude(rest.slice(1));
  }
  if (which !== 'git-post-commit') {
    fail(`Unknown hook to install: ${which}. Supported: 'claude', 'git-post-commit'.`);
  }

  const ctx = ServerContext.initialize();
  try {
    if (!ctx.project) {
      fail('Not a MyJarbis project. Run `myjarbis init` first.');
    }

    const gitDir = path.join(ctx.projectPath, '.git');
    if (!fs.existsSync(gitDir)) {
      fail('No .git directory at ' + ctx.projectPath + ' — initialize a git repo first.');
    }

    const hooksDir = path.join(gitDir, 'hooks');
    if (!fs.existsSync(hooksDir)) {
      fs.mkdirSync(hooksDir, { recursive: true });
    }

    const target = path.join(hooksDir, 'post-commit');
    if (fs.existsSync(target)) {
      const existing = fs.readFileSync(target, 'utf-8');
      if (existing.includes(POST_COMMIT_MARKER)) {
        ptySection('MyJarbis · git-post-commit hook');
        ptyKV('Status', dim('already installed (no changes)'));
        ptyKV('Path', dim(target));
        console.log('');
        return;
      }
      ptySection('MyJarbis · git-post-commit hook');
      ptyKV('Status', red('NOT installed — conflicting hook found'));
      ptyKV('Path', dim(target));
      console.log('');
      ptyDim('A different post-commit hook already exists. To enable MyJarbis,');
      ptyDim('append this single line to that script:');
      console.log('');
      console.log('  ( cd "$(git rev-parse --show-toplevel)" && myjarbis hook git-post-commit ) >/dev/null 2>&1 || true');
      console.log('');
      process.exit(1);
    }

    fs.writeFileSync(target, POST_COMMIT_SCRIPT);
    fs.chmodSync(target, 0o755);

    ptySection('MyJarbis · git-post-commit hook installed');
    ptyKV('Path', dim(target));
    ptyKV('What', 'each commit while a session is open → auto progress observation');
    console.log('');
    ptyDim('To uninstall: rm ' + target);
    console.log('');
  } finally {
    ctx.close();
  }
}

/** Project root for hook wiring, resolved WITHOUT opening the brain.
 *  `init` wires the hooks at step 6, three steps before memory.db is
 *  seeded, so going through ServerContext here would fail on exactly the
 *  run that needs it most. Nothing about writing a settings file needs
 *  the DB anyway, which also lets `doctor` repair a project whose brain
 *  is broken. */
function hookWiringRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (
      fs.existsSync(path.join(dir, '.claude-plugin', 'scripts')) ||
      fs.existsSync(path.join(dir, '.myjarbis')) ||
      fs.existsSync(path.join(dir, '.git'))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      fail(
        'Could not find a project root from ' +
          process.cwd() +
          ' — run this from inside a MyJarbis project.'
      );
    }
    dir = parent;
  }
}

function runHookInstallClaude(rest: string[] = []): void {
  const check = rest.includes('--check');
  const report = wireClaudeHooks(hookWiringRoot(), check);

  // --check is for `doctor`: report without writing, and exit non-zero
  // when something needs doing, so a wrapper can act on it.
  //
  // Two different answers used to share one word. `report.changed` means "the
  // block we would write differs from the one on disk", which is true both
  // when NOTHING is bound and when everything is bound with an older shape —
  // a matcher we have since added, a renamed script. Both printed "NOT WIRED",
  // so a project whose hooks fire perfectly well was told "Claude Code will
  // never run them". That is false, and the alarm is the wrong size: one case
  // means the whole integration is dead, the other means it is a release
  // behind.
  //
  // `wiringState` answers the first question and only the first — it is
  // deliberately lenient about HOW an event is bound (see hooks.ts), which is
  // exactly what makes it the right instrument for "is anything bound at all".
  // Exit codes: 0 current, 1 nothing bound, 2 bound but out of date.
  if (check) {
    for (const s of report.unusable) console.log(`  unusable script: ${s}`);
    if (report.unusable.length > 0) {
      console.log('NOT WIRED');
      process.exit(1);
    }
    if (!report.changed) {
      console.log('WIRED');
      return;
    }
    // `anyBound`, not `state === 'wired'`: since wiringState started checking
    // matchers, a project bound entirely with an older matcher is `partial`
    // rather than `wired` — correctly, because that binding really does not
    // fire for the source we added. But it is still "bound in an older shape",
    // which is the distinction this message exists to make.
    const { bound, missing, anyBound } = wiringState(hookWiringRoot());
    if (anyBound) {
      console.log('STALE WIRING');
      console.log('  bound, but not the way this version writes it');
      if (missing.length > 0) console.log(`  out of date: ${missing.join(', ')}`);
      process.exit(2);
    }
    console.log('NOT WIRED');
    if (bound.length > 0) console.log(`  bound: ${bound.join(', ')}`);
    if (missing.length > 0) console.log(`  missing: ${missing.join(', ')}`);
    process.exit(1);
  }

  ptySection(
    report.changed ? 'MyJarbis · Claude Code hooks wired' : 'MyJarbis · Claude Code hooks'
  );
  ptyKV('File', dim(report.file));
  if (!report.changed) ptyKV('Status', dim('already wired (no changes)'));
  for (const line of report.wired) ptyLine('  ' + line);
  if (report.replaced > 0) ptyKV('Rewired', `${report.replaced} previous MyJarbis entr${report.replaced === 1 ? 'y' : 'ies'}`);
  if (report.kept > 0) ptyKV('Kept', `${report.kept} of your own hook(s) on the same events`);
  if (report.unusable.length > 0) {
    console.log('');
    ptyKV('Skipped', red(report.unusable.join(', ')));
    ptyDim('Those scripts are missing or not executable under .claude-plugin/scripts/.');
    ptyDim('Run `myjarbis init` in this project to restore them, then re-run this.');
  }
  console.log('');
  if (report.changed) {
    ptyDim('Claude Code reads hooks at startup — reopen Claude for these to fire.');
    console.log('');
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
  /** NDJSON brain dump (see tools/brain.ts). Off unless opted in, because
   *  it only makes sense for projects that version the dump instead of
   *  the binary memory.db. */
  brain?: {
    /** Refresh `.myjarbis/brain/*.ndjson` when the Stop hook fires, so the
     *  dump on disk always reflects the DB and `git status` shows real work
     *  to commit without anyone remembering to export by hand. */
    auto_export_on_session_end?: boolean;
  };
  /** Session-related knobs. */
  session?: {
    /** Days after which a previous next_session is considered stale and
     *  the SessionStart hook + start_session response surface a warning.
     *  Default 7. Disable by setting a very large number; 0/negative are
     *  ignored (fall back to default). */
    stale_after_days?: number;
    /**
     * Close an open session automatically when the session ends, writing a
     * generated summary and resume point.
     *
     * Default TRUE — the only setting here that defaults on. The failure it
     * prevents is silent: a session that never closes leaves `resume` with
     * nothing to return and strips `hasNextSession` / `lastSessionEndedAt`
     * from every module, which is the signal used to pick up where you left
     * off and to choose a module. Real projects had summary NULL on 2 of 2
     * and 2 of 10 sessions, and nobody noticed until the data was counted.
     *
     * Set to false to go back to being reminded instead.
     */
    auto_close_on_exit?: boolean;
  };
  /** Living draw.io diagram. `auto` (default false — opt-in) regenerates the
   *  active module's diagram on save_observation/update_progress and on session
   *  hooks, popping it open in VS Code. When off, `myjarbis diagram` still
   *  generates + opens on demand. Toggle with `myjarbis config diagram on|off`. */
  diagram?: {
    auto?: boolean;
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
// Subcommand: diagram — regenerate the (active or named) module's living
// draw.io diagram and open it in VS Code. Also invoked internally by hooks.
// ─────────────────────────────────────────────────────────────────────

function runDiagram(argv: string[]): void {
  const { positional, flags } = parseFlags(argv);
  const moduleName = positional[0];
  const ctx = ServerContext.initialize();
  try {
    const res = generateModuleDiagram(ctx, moduleName);
    if (wantsJson(flags)) {
      printJson(res);
      return;
    }
    ptySection('MyJarbis · diagram');
    if (!res.ok) {
      ptyDim('Could not generate: ' + (res.reason ?? 'unknown'));
      console.log('');
      return;
    }
    ptyKV('Module', bold(res.module ?? '—'));
    ptyKV('File', res.path ?? '—');
    ptyKV('Nodes', String(res.nodeCount ?? 0));
    ptyKV('Status', res.changed ? 'updated' : 'unchanged');
    if (res.path && flags['no-open'] !== true) {
      const opened = openInVscode(res.path, ctx.projectPath);
      ptyDim(opened ? 'Opened in VS Code.' : 'Tip: open it with the draw.io extension.');
    }
    console.log('');
  } finally {
    ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: brain (export / import / status)
// ─────────────────────────────────────────────────────────────────────

function runBrain(argv: string[]): void {
  const { positional, flags } = parseFlags(argv);
  const sub = positional[0];
  if (!sub || !['export', 'import', 'status'].includes(sub)) {
    fail('Usage: myjarbis brain <export|import|status> [--dir=<path>] [--yes] [--json]');
  }

  const dir = flags.dir as string | undefined;
  const json = wantsJson(flags);
  const ctx = ServerContext.initialize();

  try {
    if (sub === 'export') {
      const res = exportBrain(ctx, { dir });
      if (json) return printJson(res);
      ptySection('MyJarbis · brain export');
      ptyKV('Dir', res.dir);
      ptyKV('Rows', Object.entries(res.counts).map(([t, n]) => `${t}=${n}`).join('  '));
      ptyKV('Size', `${(res.bytes / 1024).toFixed(1)} KB`);
      ptyKV('Status', res.changed ? `updated (${res.filesWritten.join(', ')})` : 'unchanged');
      console.log('');
      return;
    }

    if (sub === 'status') {
      const res = brainStatus(ctx, { dir });
      if (json) return printJson(res);
      ptySection('MyJarbis · brain status');
      ptyKV('Dir', res.dir);
      ptyKV('Dump', res.dumpExists ? 'present' : 'missing');
      ptyKV('Status', res.inSync ? 'in sync' : 'DRIFT');
      for (const d of res.drift) ptyDim(d);
      console.log('');
      if (!res.inSync) process.exit(3);
      return;
    }

    // import — destructive: it replaces every row of every tracked table.
    // Requiring --yes keeps a mistyped command from wiping a brain that was
    // never exported, while staying non-interactive for git hooks.
    if (flags.yes !== true) {
      fail(
        "brain import REPLACES the contents of memory.db with the dump. Re-run with --yes if that is what you want.",
      );
    }
    const res = importBrain(ctx, { dir });
    if (json) return printJson(res);
    ptySection('MyJarbis · brain import');
    ptyKV('Dir', res.dir);
    ptyKV('From', `${res.exportedAt} (schema v${res.schemaVersion})`);
    ptyKV('Rows', Object.entries(res.counts).map(([t, n]) => `${t}=${n}`).join('  '));
    if (res.rebasedFrom) ptyKV('Rebased', `${res.rebasedFrom} → ${ctx.projectPath}`);
    console.log('');
  } finally {
    ctx.close();
  }
}

// ─────────────────────────────────────────────────────────────────────
// v0.3 subcommands
// ─────────────────────────────────────────────────────────────────────

/** myjarbis org <add|list|sync|diff> */
function runOrg(argv: string[]): void {
  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case 'add': {
      const { positional } = parseFlags(rest);
      const [slug, packPath] = positional;
      if (!slug || !packPath) {
        fail('Usage: myjarbis org add <slug> <path-to-pack>');
      }
      const pack = readPack(packPath);
      if (pack.slug !== slug) {
        fail(
          `Pack at ${packPath} declares slug "${pack.slug}", not "${slug}". ` +
            'Use the slug from pack.yml so the two cannot drift apart.',
        );
      }
      const ctx = ServerContext.initialize();
      try {
        printJson(applyPack(ctx, pack));
      } finally {
        ctx.close();
      }
      return;
    }

    case 'list': {
      const ctx = ServerContext.initialize();
      try {
        printJson({
          orgs: ctx.db.orgs.list().map((o) => ({
            slug: o.slug,
            name: o.name,
            packPath: o.pack_path,
            packRev: o.pack_rev,
            projects: ctx.db.orgs.projectsOf(o.id).map((p) => p.name),
          })),
        });
      } finally {
        ctx.close();
      }
      return;
    }

    case 'sync':
    case 'diff': {
      const { positional, flags } = parseFlags(rest);
      const slug = positional[0];
      let packPath = positional[1] ?? (flags.pack as string | undefined);
      if (!slug && !packPath) {
        fail('Usage: myjarbis org sync <slug> [path-to-pack]   (diff = dry run)');
      }
      if (!packPath) {
        // Fall back to the pack path recorded when the org was added.
        const ctx = ServerContext.initialize();
        try {
          const org = ctx.db.orgs.findBySlug(slug);
          if (!org?.pack_path) {
            fail(
              `Org "${slug}" has no recorded pack path. Pass it explicitly: ` +
                `myjarbis org ${sub} ${slug} <path-to-pack>`,
            );
          }
          packPath = org!.pack_path!;
        } finally {
          ctx.close();
        }
      }
      printJson(syncOrg(packPath!, { dryRun: sub === 'diff' }));
      return;
    }

    default:
      fail('Usage: myjarbis org <add|list|sync|diff>');
  }
}

/** myjarbis kinds [list|migrate] */
function runKinds(argv: string[]): void {
  const sub = argv[0] ?? 'list';
  const { flags } = parseFlags(argv.slice(1));
  const ctx = ServerContext.initialize();
  try {
    if (sub === 'list') {
      printJson(listContextKinds(ctx));
      return;
    }
    if (sub === 'migrate') {
      printJson(migrateKinds(ctx, { dry_run: truthy(flags['dry-run']) }));
      return;
    }
    fail('Usage: myjarbis kinds <list|migrate> [--dry-run]');
  } finally {
    ctx.close();
  }
}

/** myjarbis workflow <list|show> [slug] */
function runWorkflow(argv: string[]): void {
  const sub = argv[0] ?? 'list';
  const { positional, flags } = parseFlags(argv.slice(1));
  const ctx = ServerContext.initialize();
  try {
    if (sub === 'list') {
      printJson(listWorkflowsTool(ctx));
      return;
    }
    if (sub === 'show') {
      const slug = positional[0];
      if (!slug) fail('Usage: myjarbis workflow show <slug> [--no-evaluate]');
      printJson(getWorkflow(ctx, { slug, evaluate: !truthy(flags['no-evaluate']) }));
      return;
    }
    fail('Usage: myjarbis workflow <list|show>');
  } finally {
    ctx.close();
  }
}

/** myjarbis provider <list|set> */
function runProvider(argv: string[]): void {
  const sub = argv[0] ?? 'list';
  const { positional, flags } = parseFlags(argv.slice(1));
  const ctx = ServerContext.initialize();
  try {
    if (sub === 'list') {
      printJson(listProviders(ctx));
      return;
    }
    if (sub === 'set') {
      const [role, kind] = positional;
      if (!role || !kind) {
        fail('Usage: myjarbis provider set <tracker|forge|ci> <kind> [--config=JSON]');
      }
      printJson(setProvider(ctx, { role, kind, config: flags.config as string | undefined }));
      return;
    }
    fail('Usage: myjarbis provider <list|set>');
  } finally {
    ctx.close();
  }
}

/** myjarbis state <get|set> */
function runState(argv: string[]): void {
  const sub = argv[0] ?? 'get';
  const { positional, flags } = parseFlags(argv.slice(1));
  const ctx = ServerContext.initialize();
  try {
    if (sub === 'get') {
      printJson(getProjectState(ctx));
      return;
    }
    if (sub === 'set') {
      // Accept the body inline, from a file, or on stdin — the last being how
      // a hook or an editor hands over multi-line text.
      let content = positional.join(' ');
      const fromFile = flags['from-file'] as string | undefined;
      if (fromFile) content = fs.readFileSync(fromFile, 'utf-8');
      else if (!content && !process.stdin.isTTY) content = fs.readFileSync(0, 'utf-8');
      if (!content.trim()) {
        fail('Usage: myjarbis state set "<text>" | --from-file=FILE | (text on stdin)');
      }
      printJson(
        setProjectState(ctx, {
          content: content.trim(),
          session_tag: flags.tag as string | undefined,
          force: truthy(flags.force),
        }),
      );
      return;
    }
    fail('Usage: myjarbis state <get|set>');
  } finally {
    ctx.close();
  }
}

/** myjarbis migrate [--dry-run] [--db=PATH] [--all] */
function runMigrate(argv: string[]): void {
  const { flags } = parseFlags(argv);
  const dryRun = truthy(flags['dry-run']);

  // An explicit path wins. Otherwise migrate the brain this directory
  // resolves to, and never more than one unless --all says so: upgrading a
  // file the user did not name is exactly what openExisting stopped doing.
  const targets: string[] = [];
  const explicit = flags.db as string | undefined;

  if (explicit) {
    targets.push(path.resolve(explicit));
  } else if (truthy(flags.all)) {
    if (fs.existsSync(globalDbPath())) targets.push(globalDbPath());
    for (const entry of readRegistry()) {
      const p = siloDbPath(entry.path);
      if (fs.existsSync(p)) targets.push(p);
    }
    if (targets.length === 0) fail('No brains found to migrate.');
  } else {
    const ctx = ServerContext.initialize();
    const p = ctx.db.dbPath;
    ctx.close();
    if (p === ':memory:') {
      fail(
        'No project resolved here, so there is nothing to migrate. Pass --db=PATH ' +
          'for a specific brain, or --all for every registered one.',
      );
    }
    targets.push(p);
  }

  const reports = targets.map((t) => upgradeBrain(t, { dryRun }));

  // Make sure the backup this just wrote is ignored.
  //
  // backupBrain() leaves `memory.db.<label>.<timestamp>` next to the brain,
  // and the ignore patterns `init` writes name the SQLite sidecars exactly
  // — so nothing matches it. Every project initialised before this fix has
  // that gap, and the first `migrate` is what fills it: a full copy of the
  // brain, untracked but visible, one `git add -A` away from being
  // committed. That is precisely the leak the ignore rules exist to
  // prevent, so the command that creates the file is the one that has to
  // cover it, rather than hoping the user notices.
  //
  // Done even when `shared` is true: a shared brain is state the team
  // agreed to commit, but a backup is a local artifact of a migration this
  // machine happened to run, which nobody else wants.
  if (!dryRun) {
    for (const t of targets) {
      // <project>/.myjarbis/memory.db — two levels up is the project. The
      // global brain lives at ~/.myjarbis/memory.db and has no repo, which
      // the .git check below rules out along with non-git projects.
      const projectPath = path.dirname(path.dirname(t));
      if (fs.existsSync(path.join(projectPath, '.git'))) {
        appendToGitignore(projectPath, ['.myjarbis/memory.db.*']);
      }
    }
  }

  printJson({
    dryRun,
    migrated: reports.filter((r) => !r.alreadyCurrent).length,
    alreadyCurrent: reports.filter((r) => r.alreadyCurrent).length,
    reports,
  });
}

/** myjarbis merge --from=PATH [--into=PATH] [--as=NAME] [--dry-run] */
function runMerge(argv: string[]): void {
  const { flags } = parseFlags(argv);
  const from = flags.from as string | undefined;
  if (!from) {
    fail(
      'Usage: myjarbis merge --from=<project>/.myjarbis/memory.db [--into=PATH] ' +
        '[--as=NAME] [--source-project=NAME] [--retire-source] [--dry-run]',
    );
  }
  printJson(
    mergeBrain({
      from: path.resolve(from!),
      into: flags.into ? path.resolve(flags.into as string) : globalDbPath(),
      asName: flags.as as string | undefined,
      sourceProject: flags['source-project'] as string | undefined,
      retireSource: truthy(flags['retire-source']),
      dryRun: truthy(flags['dry-run']),
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: health
//
// `status` and `doctor` answer for one project. This answers for the
// machine, which is the question nobody could ask — and the reason three
// v0.3 features sat at 0% adoption without anyone noticing.
// ─────────────────────────────────────────────────────────────────────

/** A 10-cell bar. Colour carries the verdict so the number is a detail. */
function bar(filled: number, tone: (s: string) => string, width = 10): string {
  const n = Math.max(0, Math.min(width, Math.round(filled * width)));
  return tone('█'.repeat(n)) + dim('░'.repeat(width - n));
}

function idleTone(days: number | null): (s: string) => string {
  if (days === null) return dim;
  if (days > 60) return red;
  if (days > 14) return amber;
  return green;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s.padEnd(n) : s.slice(0, n - 1) + '…';
}

function runHealth(argv: string[]): void {
  const { flags } = parseFlags(argv);
  const r = collectHealth();

  if (wantsJson(flags)) {
    printJson(r);
    return;
  }

  const t = r.totals;
  ptySection('MyJarbis · health');
  ptyKV('Projects', `${t.projects}` + dim(
    t.onCurrentSchema === t.projects
      ? `  ·  all on schema v${r.schemaVersion}`
      : `  ·  ${t.projects - t.onCurrentSchema} not on schema v${r.schemaVersion}`,
  ));
  ptyKV(
    'Brain',
    r.sharedBrain.exists
      ? `${r.sharedBrain.projects} shared` + dim(`  ·  ${r.sharedBrain.path}`)
      : dim('no shared brain — every project is a silo'),
  );
  ptyKV('Notes', `${t.observations}` + dim(`  ·  across ${t.modules} modules`));
  if (t.sessionsOpen) {
    ptyKV('Sessions', `${t.sessionsOpen} open` + dim('  ·  they close themselves on next start'));
  }

  // ── per project ──
  const maxIdle = Math.max(1, ...r.projects.map((p) => p.daysIdle ?? 0));
  ptySection('Projects');
  console.log(
    '  ' +
      dim(
        clip('NAME', 23) +
          ' ' +
          clip('BRAIN', 8) +
          'NOTES'.padStart(6) +
          'MOD'.padStart(5) +
          'OPEN'.padStart(6) +
          '  ACTIVITY',
      ),
  );
  for (const p of r.projects) {
    const tone = idleTone(p.daysIdle);
    const flagsOut: string[] = [];
    if (!p.pathExists) flagsOut.push(red('path gone'));
    if (!p.brain) flagsOut.push(red('no brain'));
    else if (!p.schemaCurrent) flagsOut.push(red(`v${p.schema}`));
    if (p.hooks === 'stale' || p.hooks === 'missing') flagsOut.push(amber(`hooks ${p.hooks}`));
    // Flagged even when the scripts are current, which is the whole point:
    // "scripts fine, bound to nothing" is the state that used to render as
    // a clean row. Red rather than amber — an unwired project has no
    // greeting, no auto-close and no pre-compaction snapshot.
    if (p.pathExists && p.wiring === 'unwired') flagsOut.push(red('unwired'));
    else if (p.wiring === 'partial') {
      flagsOut.push(amber(`${p.wiringMissing.length} event(s) unbound`));
    }

    // The bar shows freshness, not idleness: a full bar is a live project.
    // Filling it as it rots would put the longest bar on the most abandoned
    // thing, which reads as "most", not "worst".
    const fresh = p.daysIdle === null ? 0 : 1 - p.daysIdle / maxIdle;
    console.log(
      '  ' +
        bold(clip(p.name, 23)) +
        ' ' +
        dim(clip(p.isolation ?? '—', 8)) +
        String(p.observations || '').padStart(6) +
        String(p.modules || '').padStart(5) +
        (p.sessionsOpen ? amber(String(p.sessionsOpen).padStart(6)) : ''.padStart(6)) +
        '  ' +
        bar(fresh, tone) +
        ' ' +
        tone(p.daysIdle === null ? '    —' : `${p.daysIdle}d`.padStart(5)) +
        (flagsOut.length ? '  ' + flagsOut.join(' ') : ''),
    );
  }
  if (t.modulesUnused) {
    ptyDim(`${t.modulesUnused} of ${t.modules} modules have never had a session.`);
  }
  if (t.cold60d) {
    ptyDim(`${t.cold60d} project(s) untouched for more than 60 days.`);
  }
  if (t.hooksUnwired) {
    // Named with the command that fixes it, because the one that looks
    // like it should (`myjarbis update --projects`) does not: it only
    // visits projects whose scripts are stale, and these have fresh ones.
    ptyDim(
      `${t.hooksUnwired} project(s) have hooks that are not bound to any event — ` +
        'their scripts never run.',
    );
    ptyDim('  Fix, from inside each one: myjarbis hook install claude');
  }

  // ── adoption ──
  // The number that mattered today: a feature nobody uses is either
  // undiscoverable or broken, and both are worth knowing before shipping
  // the next one.
  ptySection('Shipped, and actually used');
  for (const a of r.adoption) {
    const frac = a.of ? a.used / a.of : 0;
    const tone = frac === 0 ? red : frac < 0.5 ? amber : green;
    console.log(
      '  ' + bold(clip(a.feature, 16)) + bar(frac, tone) + '  ' + tone(`${a.used}/${a.of}`),
    );
    if (frac < 1) ptyDim(`  ${a.hint}`);
  }

  // ── taxonomy ──
  ptySection('Taxonomy');
  if (r.kindDrift.length === 0) {
    ptyDim('Every context kind is in the catalogue.');
  } else {
    // Tallied per table upstream, because that is what `kinds migrate`
    // operates on; collapsed by kind here, because the reader wants to know
    // which labels are loose, not which table each one sits in.
    const byKind = new Map<string, number>();
    for (const k of r.kindDrift) byKind.set(k.kind, (byKind.get(k.kind) ?? 0) + k.count);
    const sorted = [...byKind.entries()].sort((a, b) => b[1] - a[1]);
    const total = r.kindDrift.reduce((s, k) => s + k.count, 0);
    ptyDim(`${sorted.length} kind(s) outside the catalogue, ${total} row(s):`);
    console.log(
      '  ' +
        sorted
          .slice(0, 10)
          .map(([kind, n]) => `${kind}${dim('×' + n)}`)
          .join('  ') +
        (sorted.length > 10 ? dim('  …') : ''),
    );
    ptyDim('Fold them onto the catalogue: myjarbis kinds migrate --dry-run');
  }

  console.log('');
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: gc
// ─────────────────────────────────────────────────────────────────────

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

const GC_LABELS: Record<string, string> = {
  'dead-registry': 'registry entries for directories that are gone',
  'dead-mcp': 'myjarbis registrations in ~/.claude.json for gone directories',
  'old-backup': 'superseded brain backups',
  'dryrun-leftover': '--dry-run copies that outlived their run',
  'orphan-claude-project': 'Claude Code project dirs holding only a generated MEMORY.md',
};

function runGc(argv: string[]): void {
  const { flags } = parseFlags(argv);
  const apply = truthy(flags.apply);
  const olderThanDays = flags['older-than'] ? parseInt(String(flags['older-than']), 10) : 30;
  if (!Number.isFinite(olderThanDays) || olderThanDays < 0) {
    fail('--older-than must be a number of days');
  }

  const r = runGarbageCollect({ apply, olderThanDays });

  if (wantsJson(flags)) {
    printJson(r);
    return;
  }

  ptySection(apply ? 'MyJarbis · gc' : 'MyJarbis · gc (report only)');
  if (r.items.length === 0) {
    ptyDim('Nothing to collect.');
    console.log('');
    return;
  }

  const byKind = new Map<string, typeof r.items>();
  for (const i of r.items) {
    if (!byKind.has(i.kind)) byKind.set(i.kind, []);
    byKind.get(i.kind)!.push(i);
  }

  for (const [kind, items] of byKind) {
    const bytes = items.reduce((a, i) => a + i.bytes, 0);
    console.log('');
    console.log(
      '  ' +
        bold(`${items.length}`) +
        ' ' +
        (GC_LABELS[kind] ?? kind) +
        (bytes ? dim(`  ·  ${human(bytes)}`) : ''),
    );
    for (const i of items.slice(0, 5)) {
      ptyDim(`  ${i.what.replace(os.homedir(), '~')}`);
    }
    if (items.length > 5) ptyDim(`  … and ${items.length - 5} more`);
  }

  console.log('');
  ptyKV('Total', `${r.totals.count} item(s)` + dim(`  ·  ${human(r.totals.bytes)}`));
  if (r.errors.length) {
    for (const e of r.errors) console.log('  ' + red('FAIL') + '  ' + e);
  }
  if (apply) {
    ptyDim('Removed. The registry and ~/.claude.json were backed up next to themselves first.');
  } else {
    ptyDim(`Nothing was removed. Re-run with --apply. Backups newer than ${r.olderThanDays} days are kept.`);
    ptyDim('Rollback copies (.silo-retired-, .merged-) are never collected.');
  }
  console.log('');
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: backfill-remotes
//
// `init` has recorded the remote since v0.3, so only older projects lack
// it — which left resolution-by-remote switched on and matching nothing.
// ─────────────────────────────────────────────────────────────────────

function runBackfillRemotes(argv: string[]): void {
  const { flags } = parseFlags(argv);
  const apply = truthy(flags.apply);

  const updated: Array<{ project: string; remote: string; had: string | null }> = [];
  const skipped: Array<{ project: string; reason: string }> = [];

  for (const entry of readRegistryRaw()) {
    if (!fs.existsSync(entry.path)) {
      skipped.push({ project: entry.name, reason: 'path is gone' });
      continue;
    }
    const remote = detectRemote(entry.path);
    if (!remote) {
      skipped.push({ project: entry.name, reason: 'no git remote' });
      continue;
    }
    const resolution = resolveProject({ cwd: entry.path });
    if (!resolution) {
      skipped.push({ project: entry.name, reason: 'no brain holds this project' });
      continue;
    }
    try {
      const had = resolution.project.git_remote ?? null;
      if (had === remote) {
        skipped.push({ project: entry.name, reason: 'already recorded' });
        continue;
      }
      if (apply) resolution.db.projects.setRemote(resolution.project.id, remote);
      updated.push({ project: entry.name, remote, had });
    } finally {
      resolution.db.close();
    }
  }

  if (wantsJson(flags)) {
    printJson({ applied: apply, updated, skipped });
    return;
  }

  ptySection(apply ? 'MyJarbis · backfill-remotes' : 'MyJarbis · backfill-remotes (report only)');
  if (updated.length === 0) {
    ptyDim('Every project that has a remote already records it.');
  }
  for (const u of updated) {
    console.log(
      '  ' + bold(clip(u.project, 24)) + ' ' + green(u.remote) + (u.had ? dim(`  was ${u.had}`) : ''),
    );
  }
  const reasons = new Map<string, number>();
  for (const s of skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
  if (reasons.size) {
    console.log('');
    for (const [reason, n] of reasons) ptyDim(`${n} skipped — ${reason}`);
  }
  console.log('');
  ptyDim(apply ? 'Recorded.' : 'Nothing was written. Re-run with --apply.');
  console.log('');
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: skill reseed
//
// Baseline skills are seeded per project, and the only writers are `init`
// and the v0.1 migration. So improving a baseline reached new projects
// and nothing else — the same shape of gap as `--isolation` and
// `git_remote` before it. This is the missing path.
// ─────────────────────────────────────────────────────────────────────

/**
 * Baselines that a project is MEANT to diverge from, and which reseeding
 * would therefore destroy.
 *
 * `interaction-style` is composed at init from the chosen language and
 * persona (cli.ts, step 3), and its own text tells the agent the user owns
 * it. Its baseline is a placeholder that init overwrites — so every
 * project legitimately differs from it, and a hash comparison flags all of
 * them as "out of date". Reseeding would have replaced the user's language
 * and persona with the placeholder in every project at once.
 */
const RESEED_EXCLUDED = new Set(['interaction-style']);

function runSkillReseed(argv: string[]): void {
  const { flags } = parseFlags(argv);
  const apply = truthy(flags.apply);
  const all = truthy(flags.all);
  const force = truthy(flags['include-owned']);

  const targets = all
    ? readRegistry().map((e) => e.path)
    : [process.cwd()];

  const results: Array<{
    project: string;
    updated: string[];
    inserted: string[];
    unchanged: number;
    error?: string;
  }> = [];

  for (const dir of targets) {
    const resolution = resolveProject({ cwd: dir });
    if (!resolution) {
      results.push({ project: dir, updated: [], inserted: [], unchanged: 0, error: 'no brain holds this project' });
      continue;
    }
    const { db, project } = resolution;
    const updated: string[] = [];
    const inserted: string[] = [];
    let unchanged = 0;
    try {
      for (const skill of BASELINE_SKILLS) {
        if (RESEED_EXCLUDED.has(skill.name) && !force) {
          unchanged++;
          continue;
        }
        // Dry run compares the hash without writing, so the report is the
        // same list `--apply` would act on.
        const existing = db.skills.findByName(project.id, null, skill.name);
        const same = existing && existing.content_hash === sha256(skill.content);
        if (same) {
          unchanged++;
          continue;
        }
        if (apply) {
          const r = db.skills.upsert({
            projectId: project.id,
            name: skill.name,
            description: skill.description,
            triggerPattern: skill.triggerPattern,
            content: skill.content,
          });
          (r.status === 'inserted' ? inserted : updated).push(skill.name);
        } else {
          (existing ? updated : inserted).push(skill.name);
        }
      }
      results.push({ project: project.name, updated, inserted, unchanged });
    } catch (e) {
      results.push({
        project: project.name,
        updated: [],
        inserted: [],
        unchanged: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      db.close();
    }
  }

  if (wantsJson(flags)) {
    printJson({ applied: apply, results });
    return;
  }

  ptySection(apply ? 'MyJarbis · skill reseed' : 'MyJarbis · skill reseed (report only)');
  let touched = 0;
  for (const r of results) {
    const n = r.updated.length + r.inserted.length;
    if (r.error) {
      console.log('  ' + bold(clip(r.project, 26)) + red(r.error));
      continue;
    }
    if (n === 0) continue;
    touched++;
    console.log(
      '  ' +
        bold(clip(r.project, 26)) +
        (r.updated.length ? amber(`${r.updated.length} updated`) : '') +
        (r.updated.length && r.inserted.length ? '  ' : '') +
        (r.inserted.length ? green(`${r.inserted.length} new`) : '') +
        dim(`  ·  ${r.unchanged} unchanged`),
    );
    for (const s of [...r.updated, ...r.inserted].slice(0, 6)) ptyDim(`  ${s}`);
  }
  console.log('');
  if (touched === 0) {
    ptyDim('Every baseline is already current.');
  } else {
    ptyKV('Projects', `${touched} of ${results.length} out of date`);
    if (!force) {
      ptyDim(`Skipped (the project owns these): ${[...RESEED_EXCLUDED].join(', ')}`);
    }
    ptyDim(
      apply
        ? 'Rewritten. Open Claude in each project to re-materialise .claude/skills/.'
        : 'Nothing was written. Re-run with --apply (add --all for every project).',
    );
  }
  console.log('');
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: commands sync
//
// Same gap as `skill reseed`, one layer out: slash commands are files
// written only by `init`, so a new command reached new projects and
// nothing else. See commands.ts for why `diverged` needs --force.
// ─────────────────────────────────────────────────────────────────────

const COMMAND_STATUS_LABEL: Record<CommandStatus, (s: string) => string> = {
  new: green,
  'other-language': amber,
  // Amber, not red: it is updated without asking, like `other-language`. Red
  // is reserved for the files that need a decision.
  'old-shipped-version': amber,
  diverged: red,
  current: dim,
  'no-template': red,
};

function runCommands(argv: string[]): void {
  const [sub, ...rest] = argv;
  if (sub !== 'sync') {
    fail('Usage: cli.js commands sync [--all] [--apply] [--force]');
  }

  const { flags } = parseFlags(rest);
  const apply = truthy(flags.apply);
  const force = truthy(flags.force);
  const report = syncCommands({ all: truthy(flags.all), apply, force });

  if (wantsJson(flags)) {
    printJson(report);
    return;
  }

  ptySection(apply ? 'MyJarbis · commands sync' : 'MyJarbis · commands sync (report only)');

  let touched = 0;
  let diverged = 0;
  let stale = 0;
  for (const p of report.projects) {
    if (p.error) {
      console.log('  ' + bold(clip(p.project, 26)) + red(p.error));
      continue;
    }
    const pending = pendingFiles(p, force);
    const blocked = p.files.filter((f) => f.status === 'diverged' && !force);
    diverged += blocked.length;
    stale += p.files.filter((f) => f.status === 'old-shipped-version').length;
    if (pending.length === 0 && blocked.length === 0) continue;
    touched++;
    console.log(
      '  ' +
        bold(clip(p.project, 26)) +
        dim(`${p.language}  ·  `) +
        [...pending, ...blocked]
          .map((f) => COMMAND_STATUS_LABEL[f.status](`${f.command} (${f.status})`))
          .join('  '),
    );
  }

  console.log('');
  if (touched === 0) {
    ptyDim('Every project has the current commands.');
    console.log('');
    return;
  }

  ptyKV('Projects', `${touched} of ${report.projects.length} out of date`);
  if (stale > 0) {
    // Worth naming separately: these used to report as `diverged` and sit
    // there until someone forced them, which is how a template fix stayed
    // unpropagated across 23 projects. Now they are just updated.
    ptyDim(`${stale} file(s) are ours from an earlier release — updated, no --force needed.`);
  }
  if (diverged > 0) {
    ptyDim(`${diverged} file(s) match no template we have ever shipped — hand-edited.`);
    ptyDim('Diff one before deciding; --force overwrites them.');
  }
  ptyDim(
    apply
      ? 'Written. The new command is available the next time Claude opens there.'
      : 'Nothing was written. Re-run with --apply (add --all for every project).',
  );
  console.log('');
}

// ─────────────────────────────────────────────────────────────────────
// Subcommand: review
// ─────────────────────────────────────────────────────────────────────

function runReview(argv: string[]): void {
  const { flags } = parseFlags(argv);
  const apply = truthy(flags.apply);
  const ctx = ServerContext.initialize();
  try {
    let report = collectReview(ctx, {
      module: flags.module as string | undefined,
      threshold: flags.threshold ? parseFloat(String(flags.threshold)) : undefined,
    });
    if (apply && report.clusters.length) report = applyReview(ctx, report);

    if (wantsJson(flags)) {
      printJson(report);
      return;
    }

    ptySection(apply ? 'MyJarbis · review' : 'MyJarbis · review (report only)');
    ptyKV('Project', report.project);
    ptyKV('Scanned', `${report.scanned} note(s)` + dim(`  ·  ${report.alreadyKeyed} already grouped`));

    if (report.clusters.length === 0) {
      console.log('');
      ptyDim('No notes look like successive versions of one topic.');
      console.log('');
      return;
    }

    for (const c of report.clusters) {
      console.log('');
      console.log(
        '  ' + bold(c.topicKey) + dim(`  ·  ${c.kind} · ${c.moduleName} · ${c.members.length} notes`),
      );
      for (const m of c.members) {
        const tag = m.role === 'current' ? green('current   ') : dim('superseded');
        console.log(`    ${tag} ${dim(m.createdAt.slice(0, 10))}  ${clip(m.title, 62)}`);
      }
    }

    console.log('');
    const total = report.clusters.reduce((a, c) => a + c.members.length, 0);
    ptyKV('Groups', `${report.clusters.length}` + dim(`  ·  ${total} notes`));
    if (apply) {
      ptyDim('Grouped. Saving under the same topic_key now updates in place.');
    } else {
      ptyDim('Nothing was written. Re-run with --apply to assign topic_key + supersedes.');
      ptyDim('Nothing is ever deleted or merged — only linked.');
    }
    console.log('');
  } finally {
    ctx.close();
  }
}

/** parseFlags yields `true` for a bare flag and a string for --k=v. */
function truthy(v: string | boolean | undefined): boolean {
  return v === true || v === 'true' || v === '1';
}

// ─────────────────────────────────────────────────────────────────────
// Dispatcher
// ─────────────────────────────────────────────────────────────────────

export function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  if (!cmd) {
    fail('Usage: cli.js <import|brain|module|skill|stats|cost|hook|init-project|timeline> [args...]');
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
      case 'health':
        return runHealth(rest);
      case 'review':
        return runReview(rest);
      case 'commands':
        return runCommands(rest);
      case 'gc':
        return runGc(rest);
      case 'backfill-remotes':
        return runBackfillRemotes(rest);
      case 'timeline':
        return runTimeline(rest);
      case 'diagram':
        return runDiagram(rest);
      case 'brain':
        return runBrain(rest);
      case 'hook':
        return runHook(rest);
      case 'init-project':
        return runInitProject(rest);
      case 'org':
        return runOrg(rest);
      case 'kinds':
        return runKinds(rest);
      case 'workflow':
        return runWorkflow(rest);
      case 'provider':
        return runProvider(rest);
      case 'state':
        return runState(rest);
      case 'migrate':
        return runMigrate(rest);
      case 'merge':
        return runMerge(rest);
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
