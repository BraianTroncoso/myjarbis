/**
 * Which modules this project has open, and which one is primary.
 *
 * `.myjarbis/active` used to hold one module name on one line, written by
 * `myjarbis module use <name>` and read by the SessionStart hook to skip the
 * menu. It now holds a LIST, one name per line, and the FIRST line is the
 * primary — the module the session actually belongs to.
 *
 * WHY A LIST
 * ----------
 * Work does not respect module boundaries. Touching the CLI usually means
 * reading what the MCP server does, and a module you cannot see is a module
 * whose decisions you re-make. The old shape forced a choice between carrying
 * the wrong context and switching modules mid-thought, which closes a session
 * and opens another for what is one piece of work.
 *
 * WHY A PRIMARY RATHER THAN EQUALS
 * --------------------------------
 * Everything that WRITES needs exactly one home: `sessions.module_id` is a
 * single column, an observation belongs somewhere specific, and a handoff that
 * exists in three copies is three handoffs to reconcile. So the companions are
 * for READING — their context loads, their rows are searchable, and nothing
 * lands in them unless asked. That also keeps this a file-format change rather
 * than a schema migration.
 *
 * The format stays backward compatible in both directions: a file written by
 * an older version is a one-element list, and a file written by this one still
 * has the primary on line 1 where the old reader looked.
 */

import * as fs from 'fs';
import * as path from 'path';

export function activeModulesPath(projectPath: string): string {
  return path.join(projectPath, '.myjarbis', 'active');
}

/**
 * The open modules, primary first. Empty when nothing is selected.
 *
 * Tolerant on purpose: this file is per-user state a person may well edit by
 * hand, so blank lines and stray whitespace are ignored and duplicates are
 * collapsed rather than reported. A name that no longer exists as a module is
 * NOT filtered here — the caller has the modules table and gives a better
 * error than this layer could.
 */
export function readActiveModules(projectPath: string): string[] {
  try {
    const p = activeModulesPath(projectPath);
    if (!fs.existsSync(p)) return [];
    const names = fs
      .readFileSync(p, 'utf-8')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return [...new Set(names)];
  } catch {
    return [];
  }
}

/** The module a session would belong to, or null. */
export function readPrimaryModule(projectPath: string): string | null {
  return readActiveModules(projectPath)[0] ?? null;
}

/** Everything open except the primary. */
export function readCompanionModules(projectPath: string): string[] {
  return readActiveModules(projectPath).slice(1);
}

/** Replace the selection. First name becomes the primary. */
export function writeActiveModules(projectPath: string, names: string[]): void {
  const unique = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
  const p = activeModulesPath(projectPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, unique.length > 0 ? `${unique.join('\n')}\n` : '', 'utf-8');
}

export function clearActiveModules(projectPath: string): void {
  const p = activeModulesPath(projectPath);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/**
 * Split what a user typed into module names.
 *
 * `module use cli web`, `module use cli,web` and `module use cli, web` all
 * mean the same thing, because all three are what people type. Accepting one
 * and failing on the others would be a quiz.
 */
export function parseModuleList(args: string[]): string[] {
  return [
    ...new Set(
      args
        .flatMap((a) => a.split(','))
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ];
}
