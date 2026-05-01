/**
 * MyJarbis v0.2 — ServerContext
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

export class ServerContext {
  readonly projectPath: string;
  readonly db: MyJarbisDB;

  /** Cached project row; refreshed on demand if it appears mid-session. */
  private _project: ProjectRow | null = null;

  /** Active session set by start_session, cleared by end_session. */
  activeSessionId: number | null = null;
  activeModuleId: number | null = null;

  private constructor(projectPath: string, db: MyJarbisDB) {
    this.projectPath = projectPath;
    this.db = db;
  }

  /**
   * Bootstraps the context for the current MCP server process:
   *   - cwd → projectPath
   *   - migrate v0.1 layout if present (idempotent)
   *   - open .myjarbis/memory.db (creates it if needed)
   *   - resolve the project row, if any
   */
  static initialize(): ServerContext {
    const cwd = process.cwd();

    // Migrate v0.1 layout if applicable. Idempotent + safe when there's
    // nothing to migrate.
    const migration = migrateProject(cwd);
    if (migration.migrated) {
      console.error(
        `[MyJarbis] Migrated project v0.1 → v0.2. Backup: ${migration.backupPath}`,
      );
    }

    const db = MyJarbisDB.open(cwd);
    const ctx = new ServerContext(cwd, db);
    ctx._project = db.projects.findByPath(cwd);
    return ctx;
  }

  /** Read-only access; refreshes from DB if not cached. */
  get project(): ProjectRow | null {
    if (this._project) return this._project;
    this._project = this.db.projects.findByPath(this.projectPath);
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
        `No MyJarbis project at ${this.projectPath}. Run 'myjarbis init' to register it.`,
        { cwd: this.projectPath },
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
   * Validate that there is an active session, returning the cached ids.
   * Used by save_observation and any tool that requires a live session.
   */
  requireActiveSession(): { sessionId: number; moduleId: number } {
    if (this.activeSessionId === null || this.activeModuleId === null) {
      throw new MyJarbisError(
        ErrorType.SESSION_NOT_ACTIVE,
        'No active session. Call start_session(module) first.',
      );
    }
    return { sessionId: this.activeSessionId, moduleId: this.activeModuleId };
  }

  /** Mark a session active (called from start_session). */
  setActiveSession(sessionId: number, moduleId: number): void {
    this.activeSessionId = sessionId;
    this.activeModuleId = moduleId;
  }

  /** Clear the active session (called from end_session). */
  clearActiveSession(): void {
    this.activeSessionId = null;
    this.activeModuleId = null;
  }

  /** Force re-load of project row from DB. */
  refreshProject(): void {
    this._project = this.db.projects.findByPath(this.projectPath);
  }

  close(): void {
    this.db.close();
  }
}
