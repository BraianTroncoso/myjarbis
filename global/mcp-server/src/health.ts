/**
 * Fleet health — the view that did not exist.
 *
 * `status` and `doctor` each answer for one project. Nothing answered for
 * the whole machine, and that gap is not academic: v0.3 shipped a shared
 * brain, `project_state` and resolution-by-git-remote, and on a real
 * installation all three were used by exactly zero projects. The suite was
 * green the whole time, because a suite asserts what you thought to ask.
 *
 * So this reports what IS, not what should be: where each brain lives, what
 * schema it is on, which modules nobody has opened, which projects have
 * gone cold, and which shipped features are populated nowhere. A feature
 * with 0% adoption on its author's own machine is the cheapest bug signal
 * there is.
 *
 * Read-only. It opens brains through `openExisting`, which never migrates.
 */

import * as fs from 'fs';
import * as path from 'path';
import { MyJarbisDB } from './db/index.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { globalDbPath, siloDbPath } from './resolve.js';
import { readRegistryRaw } from './org/registry.js';
import { wiringState, WiringState } from './hooks.js';

export interface ProjectHealth {
  name: string;
  path: string;
  pathExists: boolean;
  brain: string | null;
  isolation: string | null;
  schema: number | null;
  schemaCurrent: boolean;
  modules: number;
  modulesUnused: number;
  observations: number;
  lastActivity: string | null;
  daysIdle: number | null;
  sessionsOpen: number;
  sessionsTotal: number;
  hasState: boolean;
  hasRemote: boolean;
  /** Are the hook SCRIPTS the same as the template's? A file copy fixes this. */
  hooks: 'current' | 'stale' | 'missing' | 'unknown';
  /** Are those scripts BOUND to Claude Code's events? Reported separately
   *  from `hooks` because the repair is different — this one needs
   *  `myjarbis hook install claude`, not a copy — and because the two
   *  states are independent: fresh scripts nobody runs is the common case
   *  and used to report as entirely healthy. */
  wiring: WiringState;
  /** Events in CLAUDE_HOOKS with no entry of ours, when wiring != 'wired'. */
  wiringMissing: string[];
}

export interface HealthReport {
  at: string;
  schemaVersion: number;
  sharedBrain: { path: string; exists: boolean; projects: number };
  projects: ProjectHealth[];
  totals: {
    projects: number;
    onCurrentSchema: number;
    modules: number;
    modulesUnused: number;
    observations: number;
    sessionsOpen: number;
    cold60d: number;
    hooksStale: number;
    /** Projects whose scripts may be fine but are bound to nothing. */
    hooksUnwired: number;
  };
  /** Shipped features and how many projects actually use them. */
  adoption: Array<{ feature: string; used: number; of: number; hint: string }>;
  /** Context kinds in use that are not in the catalogue. */
  kindDrift: Array<{ table: string; kind: string; count: number }>;
}

function daysBetween(iso: string, now: number): number {
  // SQLite CURRENT_TIMESTAMP is UTC without a zone marker.
  const t = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return Number.isFinite(t) ? Math.floor((now - t) / 86_400_000) : 0;
}

function hooksState(projectPath: string): ProjectHealth['hooks'] {
  const installDir =
    process.env.MYJARBIS_INSTALL_DIR || path.join(process.env.HOME ?? '', '.myjarbis-global');
  const template = path.join(installDir, 'templates', '.claude-plugin', 'hooks', 'hooks.json');
  const mine = path.join(projectPath, '.claude-plugin', 'hooks', 'hooks.json');
  if (!fs.existsSync(mine)) return 'missing';
  if (!fs.existsSync(template)) return 'unknown';
  try {
    return fs.readFileSync(mine, 'utf-8') === fs.readFileSync(template, 'utf-8')
      ? 'current'
      : 'stale';
  } catch {
    return 'unknown';
  }
}

/** The three hook fields for one project, so the two places that build a
 *  ProjectHealth row cannot disagree about what "healthy hooks" means. */
function hookFields(
  projectPath: string,
  pathExists: boolean,
): Pick<ProjectHealth, 'hooks' | 'wiring' | 'wiringMissing'> {
  if (!pathExists) return { hooks: 'unknown', wiring: 'unknown', wiringMissing: [] };
  const w = wiringState(projectPath);
  return { hooks: hooksState(projectPath), wiring: w.state, wiringMissing: w.missing };
}

/** One row per project, from whichever brain actually holds it. */
function readFromBrain(db: MyJarbisDB, brainPath: string, onlyPath?: string): ProjectHealth[] {
  const out: ProjectHealth[] = [];
  const now = Date.now();
  const q = <T>(sql: string, ...p: unknown[]): T =>
    db.db.prepare(sql).get(...(p as never[])) as T;

  let projects: Array<{ id: number; name: string; path: string; isolation: string; git_remote: string | null }>;
  try {
    projects = db.db
      .prepare('SELECT id, name, path, isolation, git_remote FROM projects ORDER BY name')
      .all() as typeof projects;
  } catch {
    return out;
  }

  for (const p of projects) {
    if (onlyPath && p.path !== onlyPath) continue;

    const modules = q<{ n: number }>('SELECT count(*) n FROM modules WHERE project_id=?', p.id).n;
    const modulesUnused = q<{ n: number }>(
      `SELECT count(*) n FROM modules m WHERE m.project_id=?
         AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.module_id=m.id)`,
      p.id,
    ).n;
    const obs = q<{ n: number; last: string | null }>(
      'SELECT count(*) n, max(created_at) last FROM observations WHERE project_id=?',
      p.id,
    );
    const sess = q<{ total: number; open: number }>(
      `SELECT count(*) total, COALESCE(SUM(CASE WHEN s.ended_at IS NULL THEN 1 ELSE 0 END),0) open
         FROM sessions s JOIN modules m ON m.id=s.module_id WHERE m.project_id=?`,
      p.id,
    );
    let hasState = false;
    try {
      hasState = q<{ n: number }>('SELECT count(*) n FROM project_state WHERE project_id=?', p.id).n > 0;
    } catch {
      /* table absent on an older schema */
    }

    out.push({
      name: p.name,
      path: p.path,
      pathExists: fs.existsSync(p.path),
      brain: brainPath,
      isolation: p.isolation,
      schema: db.schemaVersion,
      schemaCurrent: db.schemaVersion === SCHEMA_VERSION,
      modules,
      modulesUnused,
      observations: obs.n,
      lastActivity: obs.last,
      daysIdle: obs.last ? daysBetween(obs.last, now) : null,
      sessionsOpen: sess.open,
      sessionsTotal: sess.total,
      hasState,
      hasRemote: Boolean(p.git_remote),
      ...hookFields(p.path, fs.existsSync(p.path)),
    });
  }
  return out;
}

/**
 * Kinds written into context tables that the catalogue does not list.
 *
 * The catalogue is read per brain rather than from a constant: a pack may
 * add kinds, so the authoritative set is the `context_kinds` table, not a
 * union in the source.
 */
function collectKindDrift(dbs: MyJarbisDB[]): HealthReport['kindDrift'] {
  const tally = new Map<string, number>();
  for (const db of dbs) {
    let known: Set<string>;
    try {
      known = new Set(
        (db.db.prepare('SELECT slug FROM context_kinds').all() as Array<{ slug: string }>).map(
          (r) => r.slug,
        ),
      );
    } catch {
      continue; // pre-v4 brain: no catalogue to drift from
    }
    if (known.size === 0) continue;
    for (const table of ['project_context', 'module_context']) {
      let rows: Array<{ kind: string; c: number }> = [];
      try {
        rows = db.db
          .prepare(`SELECT kind, count(*) c FROM ${table} GROUP BY kind`)
          .all() as typeof rows;
      } catch {
        continue;
      }
      for (const r of rows) {
        if (known.has(r.kind)) continue;
        const key = `${table}\t${r.kind}`;
        tally.set(key, (tally.get(key) ?? 0) + r.c);
      }
    }
  }
  return [...tally.entries()]
    .map(([k, count]) => {
      const [table, kind] = k.split('\t');
      return { table, kind, count };
    })
    .sort((a, b) => b.count - a.count);
}

export function collectHealth(): HealthReport {
  const shared = globalDbPath();
  const projects: ProjectHealth[] = [];
  const open: MyJarbisDB[] = [];
  const seen = new Set<string>();

  const sharedDb = MyJarbisDB.openExisting(shared);
  let sharedCount = 0;
  if (sharedDb) {
    open.push(sharedDb);
    const rows = readFromBrain(sharedDb, shared);
    sharedCount = rows.length;
    for (const r of rows) {
      seen.add(r.path);
      projects.push(r);
    }
  }

  // Silos, through the registry. Dead registry entries are surfaced rather
  // than filtered out — a path that no longer exists is something to clean,
  // not something to hide.
  for (const entry of readRegistryRaw()) {
    if (seen.has(entry.path)) continue;
    const dbPath = siloDbPath(entry.path);
    if (!fs.existsSync(dbPath)) {
      projects.push({
        name: entry.name,
        path: entry.path,
        pathExists: fs.existsSync(entry.path),
        brain: null,
        isolation: null,
        schema: null,
        schemaCurrent: false,
        modules: 0,
        modulesUnused: 0,
        observations: 0,
        lastActivity: null,
        daysIdle: null,
        sessionsOpen: 0,
        sessionsTotal: 0,
        hasState: false,
        hasRemote: false,
        ...hookFields(entry.path, fs.existsSync(entry.path)),
      });
      seen.add(entry.path);
      continue;
    }
    const db = MyJarbisDB.openExisting(dbPath);
    if (!db) continue;
    open.push(db);
    for (const r of readFromBrain(db, dbPath, entry.path)) {
      seen.add(r.path);
      projects.push(r);
    }
  }

  const kindDrift = collectKindDrift(open);
  for (const db of open) db.close();

  projects.sort((a, b) => a.name.localeCompare(b.name));

  const withBrain = projects.filter((p) => p.brain);
  const totals = {
    projects: projects.length,
    onCurrentSchema: projects.filter((p) => p.schemaCurrent).length,
    modules: projects.reduce((a, p) => a + p.modules, 0),
    modulesUnused: projects.reduce((a, p) => a + p.modulesUnused, 0),
    observations: projects.reduce((a, p) => a + p.observations, 0),
    sessionsOpen: projects.reduce((a, p) => a + p.sessionsOpen, 0),
    cold60d: projects.filter((p) => p.daysIdle !== null && p.daysIdle > 60).length,
    hooksStale: projects.filter((p) => p.hooks === 'stale' || p.hooks === 'missing').length,
    // Counted only where the path still exists: a registry entry pointing
    // at a deleted directory is a cleanup job, not an unwired project, and
    // folding it in here would inflate the number the repair command acts on.
    hooksUnwired: projects.filter(
      (p) => p.pathExists && (p.wiring === 'unwired' || p.wiring === 'partial'),
    ).length,
  };

  const adoption = [
    {
      feature: 'project_state',
      used: withBrain.filter((p) => p.hasState).length,
      of: withBrain.length,
      hint: 'one row saying where things stand, instead of scanning notes: `myjarbis state set`',
    },
    {
      feature: 'git_remote',
      used: withBrain.filter((p) => p.hasRemote).length,
      of: withBrain.length,
      hint: 'resolution survives a clone to another path: `myjarbis backfill-remotes`',
    },
    {
      feature: 'shared brain',
      used: withBrain.filter((p) => p.isolation === 'shared').length,
      of: withBrain.length,
      hint: 'cross-project questions in one place: `myjarbis merge --retire-source`',
    },
  ];

  return {
    at: new Date().toISOString(),
    schemaVersion: SCHEMA_VERSION,
    sharedBrain: { path: shared, exists: Boolean(sharedDb), projects: sharedCount },
    projects,
    totals,
    adoption,
    kindDrift,
  };
}
