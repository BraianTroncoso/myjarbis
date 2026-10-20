/**
 * MyJarbis v0.3 — ServerContext
 *
 * One MCP server process serves ONE project (the cwd it was launched from).
 * The ServerContext owns:
 *   - the resolved project path (cwd at startup)
 *   - the SQLite connection (MyJarbisDB)
 *   - the loaded ProjectRow (if `myjarbis init` already ran)
 *   - the ACTIVE session: which session_id and module_id are "current"
 *
 * Tools receive this context object and mutate the active session/module
 * fields when start_session / end_session run.
 */

import { MyJarbisDB } from './db/index.js';
import { ProjectRow, ModuleRow } from './db/schema.js';
import { migrateProject } from './db/migrate.js';
import { MyJarbisError, ErrorType } from './types.js';
import { resolveProject, Resolution } from './resolve.js';

export class ServerContext {
  /** The directory the process was launched from. */
  readonly cwd: string;

  /** Root of the resolved project, or cwd when nothing resolved. */
  readonly projectPath: string;

  readonly db: MyJarbisDB;

  /** Which resolution rule matched. Surfaced by `myjarbis status`. */
  readonly resolvedVia: Resolution['via'] | null;

  /** Cached project row; refreshed on demand if it appears mid-session. */
  private _project: ProjectRow | null = null;

  /** Active session set by start_session, cleared by end_session. */
  private _activeSessionId: number | null = null;
  private _activeModuleId: number | null = null;

  /**
   * True once end_session ran in THIS process. It suppresses adopting an open
   * session from the brain, so "close, then save an observation" keeps failing
   * the way it should instead of silently landing the note on some other
   * module's leftover open session.
   */
  private sessionEndedHere = false;

  /**
   * Both read through lazy adoption (see `adoptOpenSessionFromBrain`), which
   * is why they are getters and not plain fields. Eight call sites across the
   * tools read them to decide a default, and `search` is one of them: with the
   * module unresolved it quietly widened `scope="module"` to the whole
   * project. Fixing the getter fixes every reader at once.
   */
  get activeSessionId(): number | null {
    if (this._activeSessionId === null) this.adoptOpenSessionFromBrain();
    return this._activeSessionId;
  }

  get activeModuleId(): number | null {
    if (this._activeModuleId === null) this.adoptOpenSessionFromBrain();
    return this._activeModuleId;
  }

  private constructor(
    cwd: string,
    projectPath: string,
    db: MyJarbisDB,
    project: ProjectRow | null,
    resolvedVia: Resolution['via'] | null,
  ) {
    this.cwd = cwd;
    this.projectPath = projectPath;
    this.db = db;
    this._project = project;
    this.resolvedVia = resolvedVia;
  }

  /**
   * Bootstraps the context for the current process.
   *
   * Nothing here creates a brain. `initialize` used to call
   * `MyJarbisDB.open(cwd)`, which materialises `.myjarbis/memory.db`
   * wherever it is called — so running any command outside a project left
   * a stray empty brain behind, and running one in a subdirectory of a real
   * project registered a second project pointing at the subdirectory.
   *
   * Creation is now `myjarbis init`'s job alone (see initializeForSeed).
   */
  static initialize(opts: { projectName?: string } = {}): ServerContext {
    const cwd = process.cwd();

    // Resolve BEFORE considering a v0.1 migration.
    //
    // `migrateProject` fires on one condition: `.myjarbis/` exists and
    // `.myjarbis/memory.db` does not. That is also the exact shape of a v0.3
    // project whose rows live in the shared brain — init writes
    // `.myjarbis/config/settings.json` for every project regardless of
    // isolation. Running it first therefore treated such a project as a v0.1
    // layout and seeded a fresh silo beside it, which then won resolution
    // permanently. It made the shared brain unusable.
    //
    // Resolution order settles it without needing a version marker (and there
    // is none: v0.3 still writes '0.2.0' into settings.json). A genuine v0.1
    // layout has rows in no brain at all, so it does not resolve and still
    // migrates. A project that lives somewhere resolves, and is left alone.
    let resolution = resolveProject({ cwd, projectName: opts.projectName });

    if (!resolution) {
      const migration = migrateProject(cwd);
      if (migration.migrated) {
        console.error(
          `[MyJarbis] Migrated project v0.1 → v0.2. Backup: ${migration.backupPath}`,
        );
        resolution = resolveProject({ cwd, projectName: opts.projectName });
      }
    }

    if (resolution) {
      return new ServerContext(
        cwd,
        resolution.project.path,
        resolution.db,
        resolution.project,
        resolution.via,
      );
    }

    // Nothing resolved. Hand back a context with an in-memory brain so that
    // `requireProject()` can produce the real error message, instead of
    // crashing on a null db or writing a file nobody asked for.
    const scratch = MyJarbisDB.openAtPath(':memory:');
    scratch.bindScope({ kind: 'all', reason: 'unresolved project: empty scratch brain' });
    return new ServerContext(cwd, cwd, scratch, null, null);
  }

  /**
   * Open (creating if needed) the brain for a project being initialised.
   * The one path allowed to bring a DB into existence.
   *
   * `dbPath` is where `seedNewProject` actually put the rows, which is the
   * shared brain when the project was created with `isolation = shared`.
   * Without it this always opened the silo next to the project — so an
   * `--isolation=shared` init seeded the shared brain correctly and then
   * created an empty silo beside it, and since resolution prefers a silo,
   * every later command found the empty one. The flag could not work.
   */
  static initializeForSeed(projectPath: string, dbPath?: string): ServerContext {
    const db = dbPath ? MyJarbisDB.openAtPath(dbPath) : MyJarbisDB.open(projectPath);
    const project = db.projects.findByPath(projectPath);
    if (project) db.bindScope({ kind: 'project', id: project.id });
    return new ServerContext(projectPath, projectPath, db, project, 'path');
  }

  /** Read-only access; refreshes from DB if not cached. */
  get project(): ProjectRow | null {
    return this._project;
  }

  /**
   * Returns the project row, throwing PROJECT_NOT_FOUND if the project
   * has not been registered yet (i.e. `myjarbis init` was never run).
   */
  requireProject(): ProjectRow {
    const p = this.project;
    if (!p) {
      throw new MyJarbisError(
        ErrorType.PROJECT_NOT_FOUND,
        `No MyJarbis project resolved from ${this.cwd}. Tried: explicit --project, ` +
          `the git remote, and every parent directory. Run 'myjarbis init' in the ` +
          `project root to register it.`,
        { cwd: this.cwd },
      );
    }
    return p;
  }

  /**
   * Resolve a module by name in the current project. Throws
   * MODULE_NOT_FOUND if it doesn't exist.
   */
  requireModule(name: string): ModuleRow {
    const project = this.requireProject();
    const m = this.db.modules.findByName(project.id, name);
    if (!m) {
      throw new MyJarbisError(
        ErrorType.MODULE_NOT_FOUND,
        `Module "${name}" not found in project "${project.name}".`,
        { projectName: project.name, requestedModule: name },
      );
    }
    return m;
  }

  /**
   * Validate that there is an active session, returning the ids.
   * Used by save_observation and any tool that requires a live session.
   *
   * Falls back to the brain when this process has no session in memory.
   * It has to: the SessionStart hook opens the session in a short-lived CLI
   * process, while the MCP server is a different, long-lived one. Holding the
   * active session only in memory meant the banner announced a live session
   * that the server could not write to — every `save_observation` as the first
   * call of a session failed with SESSION_NOT_ACTIVE, and recovering with
   * `start_session` auto-closed the hook's session and opened a second one.
   * Sessions 473 and 474 are both three-minute empty automatic closes left by
   * exactly that, and the churn resets the staleness clock that decides
   * whether a human handoff is still shown.
   */
  requireActiveSession(): { sessionId: number; moduleId: number } {
    const sessionId = this.activeSessionId;
    const moduleId = this.activeModuleId;
    if (sessionId === null || moduleId === null) {
      throw new MyJarbisError(
        ErrorType.SESSION_NOT_ACTIVE,
        this.sessionEndedHere
          ? 'The session was closed by end_session. Call start_session(module) to open a new one.'
          : 'No active session, and this project has no open session in the brain ' +
              'to adopt. Call start_session(module) first.',
      );
    }
    return { sessionId, moduleId };
  }

  /**
   * Adopt the newest session this project has left open in the brain.
   *
   * Recency for an open session is (started_at, id), never started_at alone —
   * started_at has one-second granularity, so two sessions opened in the same
   * second tie and the id breaks it. Same rule the closed-session lookups use.
   *
   * Never throws. It is reached from getters that callers treat as plain field
   * reads, so a scope or lookup failure here has to degrade to "no session",
   * not take down the tool that was only asking for a default.
   */
  private adoptOpenSessionFromBrain(): void {
    if (this.sessionEndedHere) return;
    const project = this.project;
    if (!project) return;

    try {
      const open = this.db.sessions.listOpenByProject(project.id);
      if (open.length === 0) return;

      const newest = [...open].sort((a, b) =>
        a.started_at === b.started_at
          ? a.id - b.id
          : a.started_at < b.started_at
            ? -1
            : 1,
      )[open.length - 1];

      this.setActiveSession(newest.id, newest.module_id);
      console.error(
        `[MyJarbis] Adopted open session #${newest.id} from the brain — it was ` +
          `opened outside this process (the startup hook), which does not share ` +
          `memory with the server.`,
      );
    } catch {
      // Degrade to "no active session"; the caller's own error says the rest.
    }
  }

  /** Mark a session active (called from start_session). */
  setActiveSession(sessionId: number, moduleId: number): void {
    this._activeSessionId = sessionId;
    this._activeModuleId = moduleId;
    this.sessionEndedHere = false;
  }

  /** Clear the active session (called from end_session). */
  clearActiveSession(): void {
    this._activeSessionId = null;
    this._activeModuleId = null;
    this.sessionEndedHere = true;
  }

  /** Force re-load of project row from DB. */
  refreshProject(): void {
    const byPath = this.db.projects.findByPath(this.projectPath);
    if (byPath) {
      this._project = byPath;
      if (!this.db.boundScope) this.db.bindScope({ kind: 'project', id: byPath.id });
    }
  }

  close(): void {
    this.db.close();
  }
}
