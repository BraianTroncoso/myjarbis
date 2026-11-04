/**
 * The projects registry — the only index of where every project lives.
 *
 * `~/.myjarbis/projects-registry.json` is written by `myjarbis init` and maps
 * a project name to its path. It is what makes cross-project work possible
 * for silo projects: their rows live in their own files, so there is no
 * single table to query, and the registry is how we find the files.
 *
 * It is treated as a hint, not as truth: entries go stale when a project is
 * moved or deleted, so every consumer re-checks the path exists and skips
 * what is gone rather than failing the whole run.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface RegistryEntry {
  name: string;
  path: string;
  framework?: string;
  initialized?: string;
}

/**
 * `MYJARBIS_REGISTRY` overrides the location outright, and a test that needs
 * its own registry needs that: without it a run would share one registry with
 * every other run, and cross-project commands (`org sync`, `migrate --all`)
 * would operate on leftovers from previous ones — the sort of non-hermetic
 * test that stops meaning anything.
 *
 * Otherwise the registry lives under MYJARBIS_HOME, next to the brain, and
 * not next to the install. It used to live next to the install, which is the
 * one place it must not be: that directory is replaced wholesale by an
 * update, and by a package manager that owns it. An installation that has not
 * been updated yet still has the file there, so the old path is read when the
 * new one does not exist — `myjarbis update` is what moves it.
 *
 * Mirrors bin/myjarbis-env.sh. The two have to agree, and the test that holds
 * them to it is tests/v060-state-location.sh.
 */
export function registryPath(): string {
  if (process.env.MYJARBIS_REGISTRY) return path.resolve(process.env.MYJARBIS_REGISTRY);

  const stateDir = process.env.MYJARBIS_HOME || path.join(os.homedir(), '.myjarbis');
  const current = path.join(stateDir, 'projects-registry.json');
  if (fs.existsSync(current)) return current;

  const installDir =
    process.env.MYJARBIS_INSTALL_DIR || path.join(os.homedir(), '.myjarbis-global');
  const legacy = path.join(installDir, 'projects-registry.json');
  if (fs.existsSync(legacy)) return legacy;

  return current;
}

/**
 * Every registered project, including ones whose path is gone.
 *
 * `readRegistry` hides those, which is right for commands that are about
 * to do work in each directory. It is wrong for anything whose job is to
 * report or clean up, because a dead entry is the thing being looked for.
 */
export function readRegistryRaw(): RegistryEntry[] {
  const file = registryPath();
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
  const projects =
    parsed && typeof parsed === 'object'
      ? ((parsed as { projects?: Record<string, RegistryEntry> }).projects ?? {})
      : {};
  return Object.entries(projects)
    .map(([name, v]) => ({ ...v, name: v?.name ?? name }))
    .filter((e): e is RegistryEntry => typeof e.path === 'string' && e.path.length > 0);
}

/** Every registered project whose path still exists. */
export function readRegistry(): RegistryEntry[] {
  const file = registryPath();
  if (!fs.existsSync(file)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    // A corrupt registry must not take down every command that consults it.
    // install.sh validates what it writes; this is the read-side guard.
    return [];
  }
  const projects =
    parsed && typeof parsed === 'object'
      ? ((parsed as { projects?: Record<string, RegistryEntry> }).projects ?? {})
      : {};

  return Object.entries(projects)
    .map(([name, v]) => ({ ...v, name: v?.name ?? name }))
    .filter((e): e is RegistryEntry => typeof e.path === 'string' && e.path.length > 0)
    .filter((e) => fs.existsSync(e.path));
}
