/**
 * MyJarbis v0.3 — better-sqlite3 wrapper
 *
 * Owns the connection to .myjarbis/memory.db and exposes prepared
 * statements grouped by domain. Statements are compiled lazily on
 * first use and cached for the lifetime of the connection.
 *
 * Use:
 *   const db = MyJarbisDB.open(projectPath);
 *   db.projects.findByPath(projectPath);
 *   db.search('autenticación', { scope: 'module', moduleId: 1 });
 *   db.close();
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  MIGRATIONS,
  SCHEMA_SQL,
  SCHEMA_VERSION,
  ProjectRow,
  ProjectContextRow,
  ModuleRow,
  ModuleStatus,
  ModuleContextRow,
  SkillRow,
  SessionRow,
  ObservationRow,
  ContextKind,
  ObservationKind,
  OrgRow,
  Isolation,
  ContextKindRow,
  RefRow,
  RefKind,
  ProjectStateRow,
  WorkflowRow,
  WorkflowScope,
  WorkflowStepRow,
  StepGate,
  ProviderRow,
  ProviderRole,
  AUTO_MARKER,
} from './schema.js';
import { MyJarbisError, ErrorType } from '../types.js';

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

/** Apply SCHEMA_SQL (creates fresh DB or no-op on existing) then walk
 *  any pending MIGRATIONS in version order. SCHEMA_SQL contains
 *  CREATE TABLE IF NOT EXISTS, so pre-existing rows survive. ALTER
 *  TABLE inside MIGRATIONS is wrapped in try/catch in case the column
 *  was already added (idempotent re-runs). */
function applySchemaAndMigrations(db: Database.Database): void {
  db.exec(SCHEMA_SQL);

  // Read current version (may be < SCHEMA_VERSION on existing DBs)
  const row = db.prepare(
    `SELECT value FROM meta WHERE key = 'schema_version'`,
  ).get() as { value: string } | undefined;
  const currentVersion = row ? parseInt(row.value, 10) : 0;

  for (let v = currentVersion + 1; v <= SCHEMA_VERSION; v++) {
    const statements = MIGRATIONS[v];
    if (!statements) continue;

    // One statement at a time. Passing the whole step to `exec` meant a
    // single already-applied ALTER aborted every statement after it, while
    // the version still got bumped — leaving a DB that claims to be
    // migrated but is missing columns. Per-statement application lets us
    // skip exactly what is already satisfied.
    for (const sql of statements) {
      try {
        db.exec(sql);
      } catch (err) {
        if (
          err instanceof Error &&
          /duplicate column|already exists/i.test(err.message)
        ) {
          continue;
        }
        throw err;
      }
    }
  }

  db.prepare(
    `INSERT INTO meta(key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(SCHEMA_VERSION));
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
}

/**
 * Which scope transitions a live connection may make.
 *
 * The rule is "never end up able to see more than you could before":
 *   all     → project    allowed — strictly narrowing, cannot leak anything
 *   project → same       allowed — idempotent, so callers need not track it
 *   project → other      REFUSED — a tenant switch, the exact failure mode
 *   project → all        REFUSED — widening; open a new connection, with a
 *                                  reason, so the widening is visible
 *   all     → all        allowed
 *
 * Narrowing has to be allowed or a tool that legitimately opens a brain
 * across projects (merge, org sync, a fixture) can never then work inside
 * one of them, which would push callers toward juggling two connections
 * over the same file — strictly worse.
 */
function isAllowedScopeChange(from: Scope, to: Scope): boolean {
  if (from.kind === 'all') return true;
  return to.kind === 'project' && to.id === from.id;
}

/**
 * Which tenant's rows a connection is allowed to touch.
 *
 * Before v0.3 isolation was a property of the filesystem: one DB file per
 * project, so a query simply could not reach another project's rows. The
 * shared DB removes that guarantee, and "pass project_id to every query"
 * does not replace it — one forgotten parameter silently widens a read
 * across every client in the file. That is the classic way multi-tenant
 * tools leak.
 *
 * So scope is bound to the connection, not passed per call: read methods
 * take their filter from here and offer no parameter to override it. The
 * 'all' variant carries a `reason` so that widening a read is a deliberate,
 * nameable act that shows up in logs rather than an empty argument.
 */
export type Scope =
  | { kind: 'project'; id: number }
  | { kind: 'all'; reason: string };

export type SearchScope =
  | 'module'        // active module context + project core (default)
  | 'project'       // all module contexts of project + project core
  | 'module_only'   // only the given module context
  | 'observations'  // observations in module sessions
  | 'skills';       // skills (project + module-level)

/** Chronological event in a module's timeline (sessions + observations).
 *  Ordered newest first by `at` when returned from `MyJarbisDB.timeline`. */
export type TimelineEvent =
  | { type: 'session_start'; at: string; sessionId: number }
  | {
      type: 'session_end';
      at: string;
      sessionId: number;
      summary: string | null;
      nextSession: string | null;
      observationsCount: number;
    }
  | {
      type: 'observation';
      at: string;
      sessionId: number;
      observationId: number;
      kind: ObservationKind;
      title: string;
      storyLocalId: string | null;
    };

export interface SearchHit {
  source: 'project_context' | 'module_context' | 'observation' | 'skill';
  rowid: number;
  title: string;
  snippet: string;
  rank: number;
  meta: Record<string, unknown>;
}

// ───────────────────────────────────────────────────────────────────
// Wrapper
// ───────────────────────────────────────────────────────────────────

export class MyJarbisDB {
  readonly db: Database.Database;
  readonly dbPath: string;

  /** Lazy statement cache keyed by the SQL text. */
  private stmtCache = new Map<string, Database.Statement>();

  /** Null until bindScope() runs. Scoped reads throw while it is null. */
  private _scope: Scope | null = null;

  private constructor(db: Database.Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /**
   * Open or create memory.db at <projectPath>/.myjarbis/memory.db.
   * Applies the schema (idempotent) and bumps meta.schema_version.
   *
   * Only `myjarbis init` should ever create a DB. Everything else goes
   * through openExisting(), because a command run in an unrelated
   * directory used to leave a stray empty brain behind.
   */
  static open(projectPath: string): MyJarbisDB {
    const myjarbisDir = path.join(projectPath, '.myjarbis');
    if (!fs.existsSync(myjarbisDir)) {
      fs.mkdirSync(myjarbisDir, { recursive: true });
    }
    const dbPath = path.join(myjarbisDir, 'memory.db');

    const db = new Database(dbPath);
    applySchemaAndMigrations(db);
    return new MyJarbisDB(db, dbPath);
  }

  /**
   * Open an existing DB without creating anything AND without migrating it.
   *
   * Both halves matter. Returning null for a missing file lets the caller
   * fall through the resolution chain instead of materialising an empty
   * brain in whatever directory the user is standing in. And not migrating
   * means merely *looking* for a project never rewrites someone's schema:
   * resolution touches every candidate brain, including the shared one, so
   * an implicit migration here would upgrade a file the user never named,
   * with no backup and no way to say no. Schema changes belong to
   * `myjarbis migrate`, which backs up first.
   *
   * A DB below SCHEMA_VERSION opens fine and keeps working with the
   * features it has; `schemaVersion` tells callers to suggest migrating.
   */
  static openExisting(dbPath: string): MyJarbisDB | null {
    if (!fs.existsSync(dbPath)) return null;
    const db = new Database(dbPath);
    return new MyJarbisDB(db, dbPath);
  }

  /** Open against an explicit path (used by tests / migrations). */
  static openAtPath(dbPath: string): MyJarbisDB {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const db = new Database(dbPath);
    applySchemaAndMigrations(db);
    return new MyJarbisDB(db, dbPath);
  }

  close(): void {
    this.db.close();
  }

  /** Apply pending migrations to an already-open connection. Only
   *  `myjarbis migrate` and `init` call this; see openExisting(). */
  migrateInPlace(): void {
    applySchemaAndMigrations(this.db);
    this.stmtCache.clear();
    this._schemaVersion = undefined;
  }

  private _schemaVersion?: number;

  /** The schema version recorded in the file. 0 for a DB with no meta row. */
  get schemaVersion(): number {
    if (this._schemaVersion === undefined) {
      try {
        const row = this.db
          .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
          .get() as { value: string } | undefined;
        this._schemaVersion = row ? parseInt(row.value, 10) : 0;
      } catch {
        this._schemaVersion = 0;
      }
    }
    return this._schemaVersion;
  }

  /** True when this file is behind the code and should be migrated. */
  get needsMigration(): boolean {
    return this.schemaVersion < SCHEMA_VERSION;
  }

  // ─────────────────────────────────────────────────────────────────
  // Scope
  // ─────────────────────────────────────────────────────────────────

  /**
   * Bind the tenant scope for this connection. Called once, by whoever
   * resolved which project we are in. Rebinding to a different project is
   * rejected: a long-lived connection quietly changing tenants mid-process
   * is the failure mode this whole mechanism exists to prevent.
   */
  bindScope(scope: Scope): void {
    const from = this._scope;
    if (from && !isAllowedScopeChange(from, scope)) {
      throw new MyJarbisError(
        ErrorType.OUT_OF_SCOPE,
        from.kind === 'project' && scope.kind === 'project'
          ? 'Refusing to switch this connection to another project. Open a new one.'
          : 'Refusing to widen an already-pinned connection to every project. ' +
            'Open a new one with { kind: "all", reason }.',
        { from, to: scope },
      );
    }
    this._scope = scope;
  }

  get boundScope(): Scope | null {
    return this._scope;
  }

  /** The bound scope, or a hard failure. Every scoped read goes through here. */
  private get scope(): Scope {
    if (!this._scope) {
      throw new MyJarbisError(
        ErrorType.SCOPE_NOT_RESOLVED,
        'No scope bound to this connection. A read cannot default to every ' +
          'project: resolve the project first, or bind { kind: "all", reason } ' +
          'to cross projects on purpose.',
        { dbPath: this.dbPath },
      );
    }
    return this._scope;
  }

  /** The project id this connection is pinned to, or null under 'all'. */
  get scopedProjectId(): number | null {
    const s = this.scope;
    return s.kind === 'project' ? s.id : null;
  }

  /**
   * SQL fragment restricting `<alias>.project_id` to the bound scope,
   * plus the parameters it needs. Under 'all' it contributes nothing,
   * which is the only way a cross-project read can happen.
   */
  private scopeFilter(column: string): { sql: string; params: number[] } {
    const s = this.scope;
    if (s.kind === 'all') return { sql: '', params: [] };
    return { sql: ` AND ${column} = ?`, params: [s.id] };
  }

  /** Throw unless `projectId` is inside the bound scope. */
  private assertInScope(projectId: number | null, what: string): void {
    const s = this.scope;
    if (s.kind === 'all') return;
    if (projectId !== s.id) {
      throw new MyJarbisError(
        ErrorType.OUT_OF_SCOPE,
        `${what} belongs to project ${projectId}, but this connection is scoped to project ${s.id}.`,
        { requested: projectId, scopedTo: s.id },
      );
    }
  }

  /** Resolve the owning project of a module, for scope checks. */
  private projectIdOfModule(moduleId: number): number | null {
    const row = this.prep('SELECT project_id FROM modules WHERE id = ?').get(moduleId) as
      | { project_id: number }
      | undefined;
    return row?.project_id ?? null;
  }

  private prep(sql: string): Database.Statement {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  /** Run inside an immediate transaction. */
  tx<T>(fn: () => T): T {
    const wrapped = this.db.transaction(fn);
    return wrapped();
  }

  // ─────────────────────────────────────────────────────────────────
  // meta
  // ─────────────────────────────────────────────────────────────────
  meta = {
    get: (key: string): string | null => {
      const row = this.prep('SELECT value FROM meta WHERE key = ?').get(key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },
    set: (key: string, value: string): void => {
      this.prep(
        `INSERT INTO meta(key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(key, value);
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // projects
  // ─────────────────────────────────────────────────────────────────
  // The `projects` accessors are the one family that runs BEFORE a scope
  // exists — they are how the scope gets resolved in the first place. They
  // are therefore deliberately unscoped, and deliberately limited to
  // lookups by an identifier the caller already holds (path, remote, name,
  // id). The only listing that can enumerate tenants is `listAll`, which
  // demands a reason.
  projects = {
    create: (params: {
      name: string;
      path: string;
      framework?: string;
      orgId?: number | null;
      gitRemote?: string | null;
      isolation?: Isolation;
    }): ProjectRow => {
      const info = this.prep(
        `INSERT INTO projects(name, path, framework, org_id, git_remote, isolation)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        params.name,
        params.path,
        params.framework ?? null,
        params.orgId ?? null,
        params.gitRemote ?? null,
        params.isolation ?? 'silo',
      );
      return this.projects.findById(Number(info.lastInsertRowid))!;
    },

    upsertByPath: (params: {
      name: string;
      path: string;
      framework?: string;
      orgId?: number | null;
      gitRemote?: string | null;
      isolation?: Isolation;
    }): ProjectRow => {
      const existing = this.projects.findByPath(params.path);
      if (existing) return existing;
      return this.projects.create(params);
    },

    findById: (id: number): ProjectRow | null =>
      (this.prep('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined) ?? null,

    findByName: (name: string): ProjectRow | null =>
      (this.prep('SELECT * FROM projects WHERE name = ?').get(name) as ProjectRow | undefined) ?? null,

    findByPath: (projectPath: string): ProjectRow | null =>
      (this.prep('SELECT * FROM projects WHERE path = ?').get(projectPath) as
        | ProjectRow
        | undefined) ?? null,

    /**
     * Resolve by normalised git remote. See resolve.ts for normalisation.
     *
     * Returns null on a pre-v4 file rather than throwing: `git_remote` does
     * not exist there, and an un-migrated project must keep resolving the
     * way it always did (by path) instead of failing to open at all.
     */
    findByRemote: (remote: string): ProjectRow | null => {
      if (this.schemaVersion < 4) return null;
      return (
        (this.prep('SELECT * FROM projects WHERE git_remote = ?').get(remote) as
          | ProjectRow
          | undefined) ?? null
      );
    },

    /** The projects visible under the bound scope: one, or all under 'all'. */
    list: (): ProjectRow[] => {
      const s = this.scope;
      if (s.kind === 'project') {
        const row = this.projects.findById(s.id);
        return row ? [row] : [];
      }
      return this.prep('SELECT * FROM projects ORDER BY name').all() as ProjectRow[];
    },

    /**
     * Enumerate every project regardless of scope. Takes a reason because
     * this is the one query that sees across tenants, and a caller that
     * cannot say why it needs that probably does not.
     */
    listAll: (reason: string): ProjectRow[] => {
      if (!reason || !reason.trim()) {
        throw new MyJarbisError(
          ErrorType.SCOPE_NOT_RESOLVED,
          'listAll() requires a reason describing why the read crosses projects.',
        );
      }
      return this.prep('SELECT * FROM projects ORDER BY name').all() as ProjectRow[];
    },

    setOrg: (id: number, orgId: number | null): void => {
      this.prep('UPDATE projects SET org_id = ? WHERE id = ?').run(orgId, id);
    },

    setRemote: (id: number, remote: string | null): void => {
      this.prep('UPDATE projects SET git_remote = ? WHERE id = ?').run(remote, id);
    },

    setIsolation: (id: number, isolation: Isolation): void => {
      this.prep('UPDATE projects SET isolation = ? WHERE id = ?').run(isolation, id);
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // orgs
  // ─────────────────────────────────────────────────────────────────
  orgs = {
    upsert: (params: {
      slug: string;
      name: string;
      packPath?: string | null;
      packRev?: string | null;
    }): OrgRow => {
      const existing = this.orgs.findBySlug(params.slug);
      if (existing) {
        this.prep(
          'UPDATE orgs SET name = ?, pack_path = ?, pack_rev = ? WHERE id = ?',
        ).run(params.name, params.packPath ?? null, params.packRev ?? null, existing.id);
        return this.orgs.findBySlug(params.slug)!;
      }
      this.prep(
        'INSERT INTO orgs(slug, name, pack_path, pack_rev) VALUES (?, ?, ?, ?)',
      ).run(params.slug, params.name, params.packPath ?? null, params.packRev ?? null);
      return this.orgs.findBySlug(params.slug)!;
    },

    findBySlug: (slug: string): OrgRow | null =>
      (this.prep('SELECT * FROM orgs WHERE slug = ?').get(slug) as OrgRow | undefined) ?? null,

    findById: (id: number): OrgRow | null =>
      (this.prep('SELECT * FROM orgs WHERE id = ?').get(id) as OrgRow | undefined) ?? null,

    list: (): OrgRow[] => this.prep('SELECT * FROM orgs ORDER BY slug').all() as OrgRow[],

    setRev: (id: number, rev: string | null): void => {
      this.prep('UPDATE orgs SET pack_rev = ? WHERE id = ?').run(rev, id);
    },

    /** Projects belonging to an org. Used by `org sync`, which is by
     *  definition a cross-project operation, so it needs the 'all' scope. */
    projectsOf: (orgId: number): ProjectRow[] => {
      const s = this.scope;
      if (s.kind === 'project') {
        return this.prep('SELECT * FROM projects WHERE org_id = ? AND id = ? ORDER BY name').all(
          orgId,
          s.id,
        ) as ProjectRow[];
      }
      return this.prep('SELECT * FROM projects WHERE org_id = ? ORDER BY name').all(
        orgId,
      ) as ProjectRow[];
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // context_kinds — the taxonomy catalogue
  // ─────────────────────────────────────────────────────────────────
  contextKinds = {
    list: (orgId?: number | null): ContextKindRow[] =>
      this.prep(
        `SELECT * FROM context_kinds
          WHERE org_id IS NULL ${orgId == null ? '' : 'OR org_id = ?'}
          ORDER BY position, slug`,
      ).all(...(orgId == null ? [] : [orgId])) as ContextKindRow[],

    exists: (slug: string, orgId?: number | null): boolean => {
      const row = this.prep(
        `SELECT 1 AS ok FROM context_kinds
          WHERE slug = ? AND (org_id IS NULL ${orgId == null ? '' : 'OR org_id = ?'})`,
      ).get(...(orgId == null ? [slug] : [slug, orgId])) as { ok: number } | undefined;
      return !!row;
    },

    upsert: (params: {
      slug: string;
      label: string;
      description?: string | null;
      orgId?: number | null;
      position?: number;
    }): ContextKindRow => {
      this.prep(
        `INSERT INTO context_kinds(slug, label, description, org_id, position)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           label = excluded.label,
           description = excluded.description,
           org_id = excluded.org_id,
           position = excluded.position`,
      ).run(
        params.slug,
        params.label,
        params.description ?? null,
        params.orgId ?? null,
        params.position ?? 100,
      );
      return this.prep('SELECT * FROM context_kinds WHERE slug = ?').get(
        params.slug,
      ) as ContextKindRow;
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // project_context
  // ─────────────────────────────────────────────────────────────────
  projectContext = {
    /**
     * Idempotent upsert keyed by (project_id, source_path, kind).
     * Returns 'inserted' | 'updated' | 'unchanged' according to hash.
     */
    upsert: (params: {
      projectId: number;
      kind: ContextKind;
      title: string;
      content: string;
      tags?: string;
      sourcePath?: string;
    }): { row: ProjectContextRow; status: 'inserted' | 'updated' | 'unchanged' } => {
      this.assertInScope(params.projectId, 'project_context row');
      const hash = sha256(params.content);

      const existing = params.sourcePath
        ? (this.prep(
            'SELECT * FROM project_context WHERE project_id = ? AND source_path = ? AND kind = ?',
          ).get(params.projectId, params.sourcePath, params.kind) as
            | ProjectContextRow
            | undefined)
        : undefined;

      if (existing) {
        if (existing.content_hash === hash) {
          return { row: existing, status: 'unchanged' };
        }
        this.prep(
          `UPDATE project_context
              SET title = ?, content = ?, tags = ?, content_hash = ?, updated_at = datetime('now')
            WHERE id = ?`,
        ).run(params.title, params.content, params.tags ?? null, hash, existing.id);
        return {
          row: this.projectContext.findById(existing.id)!,
          status: 'updated',
        };
      }

      const info = this.prep(
        `INSERT INTO project_context(project_id, kind, title, content, tags, source_path, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        params.projectId,
        params.kind,
        params.title,
        params.content,
        params.tags ?? null,
        params.sourcePath ?? null,
        hash,
      );
      return {
        row: this.projectContext.findById(Number(info.lastInsertRowid))!,
        status: 'inserted',
      };
    },

    findById: (id: number): ProjectContextRow | null => {
      const row =
        (this.prep('SELECT * FROM project_context WHERE id = ?').get(id) as
          | ProjectContextRow
          | undefined) ?? null;
      if (row) this.assertInScope(row.project_id, `project_context row ${id}`);
      return row;
    },

    /** Same lookup as findById but returns null for out-of-scope rows
     *  instead of throwing. For callers probing an id they did not choose. */
    findByIdInScope: (id: number): ProjectContextRow | null => {
      const row =
        (this.prep('SELECT * FROM project_context WHERE id = ?').get(id) as
          | ProjectContextRow
          | undefined) ?? null;
      if (!row) return null;
      const s = this.scope;
      if (s.kind === 'project' && row.project_id !== s.id) return null;
      return row;
    },

    listByProject: (projectId: number): ProjectContextRow[] => {
      this.assertInScope(projectId, 'project_context listing');
      return this.prep(
        'SELECT * FROM project_context WHERE project_id = ? ORDER BY kind, title',
      ).all(projectId) as ProjectContextRow[];
    },

    findByTopic: (projectId: number, topicKey: string): ProjectContextRow | null => {
      this.assertInScope(projectId, 'project_context lookup');
      return (
        (this.prep(
          'SELECT * FROM project_context WHERE project_id = ? AND topic_key = ?',
        ).get(projectId, topicKey) as ProjectContextRow | undefined) ?? null
      );
    },

    setTopicKey: (id: number, topicKey: string | null): void => {
      const row = this.projectContext.findById(id);
      if (!row) return;
      this.prep('UPDATE project_context SET topic_key = ? WHERE id = ?').run(topicKey, id);
    },

    /** Rewrite a row's kind. Used by the taxonomy migration, which reports
     *  every change it makes rather than rewriting silently. */
    setKind: (id: number, kind: ContextKind): void => {
      this.prep(
        `UPDATE project_context SET kind = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(kind, id);
    },

    /** Distinct kinds in use, for the migration's dry run. */
    distinctKinds: (projectId: number): Array<{ kind: string; n: number }> => {
      this.assertInScope(projectId, 'project_context listing');
      return this.prep(
        `SELECT kind, COUNT(*) AS n FROM project_context
          WHERE project_id = ? GROUP BY kind ORDER BY n DESC`,
      ).all(projectId) as Array<{ kind: string; n: number }>;
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // modules
  // ─────────────────────────────────────────────────────────────────
  modules = {
    create: (projectId: number, name: string, description?: string): ModuleRow => {
      this.assertInScope(projectId, 'module');
      const info = this.prep(
        'INSERT INTO modules(project_id, name, description) VALUES (?, ?, ?)',
      ).run(projectId, name, description ?? null);
      return this.modules.findById(Number(info.lastInsertRowid))!;
    },

    upsertByName: (projectId: number, name: string, description?: string): ModuleRow => {
      const existing = this.modules.findByName(projectId, name);
      if (existing) return existing;
      return this.modules.create(projectId, name, description);
    },

    findById: (id: number): ModuleRow | null => {
      const row =
        (this.prep('SELECT * FROM modules WHERE id = ?').get(id) as ModuleRow | undefined) ?? null;
      if (row) this.assertInScope(row.project_id, `module ${id}`);
      return row;
    },

    findByName: (projectId: number, name: string): ModuleRow | null => {
      this.assertInScope(projectId, 'module lookup');
      return (
        (this.prep('SELECT * FROM modules WHERE project_id = ? AND name = ?').get(
          projectId,
          name,
        ) as ModuleRow | undefined) ?? null
      );
    },

    listByProject: (projectId: number): ModuleRow[] => {
      this.assertInScope(projectId, 'module listing');
      return this.prep('SELECT * FROM modules WHERE project_id = ? ORDER BY name').all(
        projectId,
      ) as ModuleRow[];
    },

    setStatus: (id: number, status: ModuleStatus): void => {
      this.modules.findById(id); // scope check
      this.prep('UPDATE modules SET status = ? WHERE id = ?').run(status, id);
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // module_context
  // ─────────────────────────────────────────────────────────────────
  moduleContext = {
    upsert: (params: {
      moduleId: number;
      kind: ContextKind;
      title: string;
      content: string;
      tags?: string;
      sourcePath?: string;
    }): { row: ModuleContextRow; status: 'inserted' | 'updated' | 'unchanged' } => {
      this.assertInScope(this.projectIdOfModule(params.moduleId), 'module_context row');
      const hash = sha256(params.content);

      const existing = params.sourcePath
        ? (this.prep(
            'SELECT * FROM module_context WHERE module_id = ? AND source_path = ? AND kind = ? AND title = ?',
          ).get(params.moduleId, params.sourcePath, params.kind, params.title) as
            | ModuleContextRow
            | undefined)
        : undefined;

      if (existing) {
        if (existing.content_hash === hash) {
          return { row: existing, status: 'unchanged' };
        }
        this.prep(
          `UPDATE module_context
              SET content = ?, tags = ?, content_hash = ?, updated_at = datetime('now')
            WHERE id = ?`,
        ).run(params.content, params.tags ?? null, hash, existing.id);
        return {
          row: this.moduleContext.findById(existing.id)!,
          status: 'updated',
        };
      }

      const info = this.prep(
        `INSERT INTO module_context(module_id, kind, title, content, tags, source_path, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        params.moduleId,
        params.kind,
        params.title,
        params.content,
        params.tags ?? null,
        params.sourcePath ?? null,
        hash,
      );
      return {
        row: this.moduleContext.findById(Number(info.lastInsertRowid))!,
        status: 'inserted',
      };
    },

    findById: (id: number): ModuleContextRow | null => {
      const row =
        (this.prep('SELECT * FROM module_context WHERE id = ?').get(id) as
          | ModuleContextRow
          | undefined) ?? null;
      if (row) {
        this.assertInScope(this.projectIdOfModule(row.module_id), `module_context row ${id}`);
      }
      return row;
    },

    listByModule: (moduleId: number): ModuleContextRow[] => {
      this.assertInScope(this.projectIdOfModule(moduleId), 'module_context listing');
      return this.prep(
        'SELECT * FROM module_context WHERE module_id = ? ORDER BY kind, title',
      ).all(moduleId) as ModuleContextRow[];
    },

    /** How many rows a module holds, without reading their bodies. Used to
     *  describe a companion module at session start: the whole point there is
     *  not to load what we are only counting. */
    countByModule: (moduleId: number): number => {
      this.assertInScope(this.projectIdOfModule(moduleId), 'module_context count');
      const row = this.prep(
        'SELECT COUNT(*) AS n FROM module_context WHERE module_id = ?',
      ).get(moduleId) as { n: number };
      return row.n;
    },

    setKind: (id: number, kind: ContextKind): void => {
      this.prep(
        `UPDATE module_context SET kind = ?, updated_at = datetime('now') WHERE id = ?`,
      ).run(kind, id);
    },

    distinctKinds: (moduleId: number): Array<{ kind: string; n: number }> => {
      this.assertInScope(this.projectIdOfModule(moduleId), 'module_context listing');
      return this.prep(
        `SELECT kind, COUNT(*) AS n FROM module_context
          WHERE module_id = ? GROUP BY kind ORDER BY n DESC`,
      ).all(moduleId) as Array<{ kind: string; n: number }>;
    },

    /** Resolve a story-style row by its localId. import_json writes
     *  source_path as "<file>#<localId>"; we also tolerate localId
     *  appearing inside the title for hand-imported entries. */
    findByLocalId: (moduleId: number, localId: string): ModuleContextRow | null => {
      const hashRow = this.prep(
        `SELECT * FROM module_context
          WHERE module_id = ?
            AND source_path LIKE ?
          ORDER BY id DESC LIMIT 1`,
      ).get(moduleId, `%#${localId}`) as ModuleContextRow | undefined;
      if (hashRow) return hashRow;
      return (this.prep(
        `SELECT * FROM module_context
          WHERE module_id = ?
            AND title LIKE ?
          ORDER BY id DESC LIMIT 1`,
      ).get(moduleId, `%${localId}%`) as ModuleContextRow | undefined) ?? null;
    },

    setProgress: (id: number, progress: string | null): ModuleContextRow => {
      this.prep(
        `UPDATE module_context
            SET progress = ?, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(progress, id);
      return this.moduleContext.findById(id)!;
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // skills
  // ─────────────────────────────────────────────────────────────────
  skills = {
    upsert: (params: {
      projectId: number;
      moduleId?: number | null;
      name: string;
      description?: string;
      triggerPattern?: string;
      content: string;
      enabled?: boolean;
    }): { row: SkillRow; status: 'inserted' | 'updated' | 'unchanged' } => {
      this.assertInScope(params.projectId, 'skill');
      const hash = sha256(params.content);
      const moduleId = params.moduleId ?? null;

      const existing = this.skills.findByName(params.projectId, moduleId, params.name);
      if (existing) {
        if (existing.content_hash === hash && existing.enabled === (params.enabled === false ? 0 : 1)) {
          return { row: existing, status: 'unchanged' };
        }
        this.prep(
          `UPDATE skills
              SET description = ?, trigger_pattern = ?, content = ?,
                  content_hash = ?, enabled = ?, updated_at = datetime('now')
            WHERE id = ?`,
        ).run(
          params.description ?? null,
          params.triggerPattern ?? null,
          params.content,
          hash,
          params.enabled === false ? 0 : 1,
          existing.id,
        );
        return { row: this.skills.findById(existing.id)!, status: 'updated' };
      }

      const info = this.prep(
        `INSERT INTO skills(project_id, module_id, name, description, trigger_pattern, content, content_hash, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        params.projectId,
        moduleId,
        params.name,
        params.description ?? null,
        params.triggerPattern ?? null,
        params.content,
        hash,
        params.enabled === false ? 0 : 1,
      );
      return { row: this.skills.findById(Number(info.lastInsertRowid))!, status: 'inserted' };
    },

    findById: (id: number): SkillRow | null => {
      const row =
        (this.prep('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined) ?? null;
      if (row) this.assertInScope(row.project_id, `skill ${id}`);
      return row;
    },

    findByName: (projectId: number, moduleId: number | null, name: string): SkillRow | null => {
      this.assertInScope(projectId, 'skill lookup');
      return (
        (this.prep(
          moduleId === null
            ? 'SELECT * FROM skills WHERE project_id = ? AND module_id IS NULL AND name = ?'
            : 'SELECT * FROM skills WHERE project_id = ? AND module_id = ? AND name = ?',
        ).get(...(moduleId === null ? [projectId, name] : [projectId, moduleId, name])) as
          | SkillRow
          | undefined) ?? null
      );
    },

    /** Skills that should be loaded for a session in `moduleId`:
     *  project-level (module_id IS NULL) + module-level for that module.
     *  Both filtered by enabled = 1.
     */
    listForSession: (projectId: number, moduleId: number): SkillRow[] => {
      this.assertInScope(projectId, 'skill listing');
      return this.prep(
        `SELECT * FROM skills
          WHERE project_id = ? AND enabled = 1
            AND (module_id IS NULL OR module_id = ?)
          ORDER BY module_id IS NOT NULL, name`,
      ).all(projectId, moduleId) as SkillRow[];
    },

    listByProject: (projectId: number, opts: { onlyProjectLevel?: boolean } = {}): SkillRow[] => {
      this.assertInScope(projectId, 'skill listing');
      return this.prep(
        opts.onlyProjectLevel
          ? 'SELECT * FROM skills WHERE project_id = ? AND module_id IS NULL ORDER BY name'
          : 'SELECT * FROM skills WHERE project_id = ? ORDER BY module_id IS NOT NULL, name',
      ).all(projectId) as SkillRow[];
    },

    listByModule: (moduleId: number): SkillRow[] => {
      this.assertInScope(this.projectIdOfModule(moduleId), 'skill listing');
      return this.prep('SELECT * FROM skills WHERE module_id = ? ORDER BY name').all(
        moduleId,
      ) as SkillRow[];
    },

    setEnabled: (id: number, enabled: boolean): void => {
      this.skills.findById(id); // scope check
      this.prep('UPDATE skills SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    },

    delete: (id: number): void => {
      this.skills.findById(id); // scope check
      this.prep('DELETE FROM skills WHERE id = ?').run(id);
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // sessions
  // ─────────────────────────────────────────────────────────────────
  sessions = {
    start: (moduleId: number): SessionRow => {
      this.assertInScope(this.projectIdOfModule(moduleId), 'session');
      const info = this.prep('INSERT INTO sessions(module_id) VALUES (?)').run(moduleId);
      return this.sessions.findById(Number(info.lastInsertRowid))!;
    },

    /**
     * Close a session, with an `ended_at` that cannot go backwards.
     *
     * `ended_at` is the sole ordering key for "which close is newest" (see
     * findLastClosedByModule), and `datetime('now')` is a wall clock. A wall
     * clock is not monotonic: on the WSL2/Hyper-V machine this was found on,
     * CLOCK_REALTIME steps BACKWARD about 0.8s every 32s as the guest
     * re-anchors to the host, measured directly:
     *
     *   1792508437074 -> 1792508436270   -804ms
     *   1792508468768 -> 1792508467967   -801ms
     *
     * When such a step lands between two closes, the one that happened LATER
     * gets the EARLIER timestamp, and every "newest close" lookup then
     * correctly returns the wrong session. The id tie-break below covers
     * timestamps that are EQUAL, not ones that are inverted.
     *
     * It is not hypothetical and it is not only a test problem: an auto-close
     * written a second "after" a curated close outranks it, which hands the
     * next session a machine-written "[auto] nothing was recorded" instead of
     * the handoff a person wrote. That is the one failure this part of the
     * system exists to prevent.
     *
     * So the close is clamped to be at least one second after the newest close
     * already in this module. The cost is a timestamp up to a few seconds
     * ahead of the wall clock after a backward step, bounded by the number of
     * closes; the gain is that close order is a fact rather than a hope. The
     * clamp is per module because that is the scope every recency lookup uses.
     */
    end: (id: number, summary: string, nextSession: string | null): SessionRow => {
      const row = this.sessions.findById(id); // scope check
      this.prep(
        `UPDATE sessions
            SET ended_at = MAX(
                  datetime('now'),
                  COALESCE(
                    (SELECT datetime(MAX(ended_at), '+1 second') FROM sessions
                      WHERE module_id = ? AND ended_at IS NOT NULL AND id != ?),
                    datetime('now')
                  )
                ),
                summary = ?, next_session = ?
          WHERE id = ?`,
      ).run(row?.module_id ?? -1, id, summary, nextSession, id);
      return this.sessions.findById(id)!;
    },

    findById: (id: number): SessionRow | null => {
      const row =
        (this.prep('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined) ??
        null;
      if (row) this.assertInScope(this.projectIdOfModule(row.module_id), `session ${id}`);
      return row;
    },

    /** Latest session of a module, regardless of ended_at. */
    findLastByModule: (moduleId: number): SessionRow | null => {
      this.assertInScope(this.projectIdOfModule(moduleId), 'session lookup');
      return (
        (this.prep(
          'SELECT * FROM sessions WHERE module_id = ? ORDER BY started_at DESC, id DESC LIMIT 1',
        ).get(moduleId) as SessionRow | undefined) ?? null
      );
    },

    /**
     * Latest CLOSED session (has next_session) for the "resume here" lookup.
     *
     * Tie-broken by id, which matters more than it looks: `ended_at` has
     * one-second granularity, so two sessions closed in the same second
     * compare equal and SQLite is free to return either. Automatic closing
     * makes that collision ordinary rather than rare — a stale session gets
     * closed in the same second the new one opens — and the wrong pick
     * means the agent resumes from the session BEFORE the one it should.
     * Ids are monotonic, so they are the real recency order.
     */
    findLastClosedByModule: (moduleId: number): SessionRow | null => {
      this.assertInScope(this.projectIdOfModule(moduleId), 'session lookup');
      return (
        (this.prep(
          `SELECT * FROM sessions
            WHERE module_id = ? AND ended_at IS NOT NULL AND next_session IS NOT NULL
            ORDER BY ended_at DESC, id DESC LIMIT 1`,
        ).get(moduleId) as SessionRow | undefined) ?? null
      );
    },

    /**
     * Latest closed session whose next_session a HUMAN wrote — the real
     * "Retomar aquí", skipping any machine-written ones on top of it.
     *
     * Needed because automatic closing competes with the curated handoff
     * instead of replacing it. Observed in a real module: a curated close
     * (3538 chars of handoff), then two sessions left open on later days,
     * each auto-closed with a synthetic next_session of 292 and 124 chars.
     * `findLastClosedByModule` correctly returns the most recent — which is
     * the emptiest of the three — and the handoff sits two links down where
     * nothing surfaces it. Every extra auto-close buries it one level more.
     *
     * `substr` rather than `NOT LIKE '[auto]%'`: SQLite does not treat `[` as
     * a wildcard, but the next reader of this line should not have to know
     * that to be sure it is right.
     */
    findLastCuratedByModule: (moduleId: number): SessionRow | null => {
      this.assertInScope(this.projectIdOfModule(moduleId), 'session lookup');
      return (
        (this.prep(
          `SELECT * FROM sessions
            WHERE module_id = ? AND ended_at IS NOT NULL AND next_session IS NOT NULL
              AND substr(next_session, 1, ?) <> ?
            ORDER BY ended_at DESC, id DESC LIMIT 1`,
        ).get(moduleId, AUTO_MARKER.length, AUTO_MARKER) as SessionRow | undefined) ?? null
      );
    },

    /**
     * How many closed sessions sit on top of `session` in this module — i.e.
     * how deep a curated handoff has been buried.
     *
     * Ordered by `(ended_at, id)`, matching `findLastCuratedByModule`, and
     * NOT by id alone. Id order is not burial order: a session started months
     * ago and auto-closed today has a LOW id and a RECENT ended_at, so it
     * buries a handoff whose id is higher than its own. Counting by id
     * reported "buried under 0" for handoffs that were demonstrably buried —
     * seen across 12 projects right after closing 54 abandoned sessions.
     */
    countClosedAfterInModule: (moduleId: number, session: SessionRow): number => {
      this.assertInScope(this.projectIdOfModule(moduleId), 'session lookup');
      const row = this.prep(
        `SELECT COUNT(*) AS n FROM sessions
          WHERE module_id = ? AND ended_at IS NOT NULL
            AND next_session IS NOT NULL
            AND (ended_at > ? OR (ended_at = ? AND id > ?))`,
      ).get(moduleId, session.ended_at, session.ended_at, session.id) as { n: number };
      return row.n;
    },

    /** Currently-open session (no ended_at) for a module, if any. */
    findActiveByModule: (moduleId: number): SessionRow | null => {
      this.assertInScope(this.projectIdOfModule(moduleId), 'session lookup');
      return (
        (this.prep(
          'SELECT * FROM sessions WHERE module_id = ? AND ended_at IS NULL ORDER BY started_at DESC, id DESC LIMIT 1',
        ).get(moduleId) as SessionRow | undefined) ?? null
      );
    },

    /** Sessions left open across the whole project. Feeds the automatic
     *  close in the stop hook: `summary` came back NULL on a third of real
     *  sessions, which is the brain quietly losing a day's work. */
    listOpenByProject: (projectId: number): SessionRow[] => {
      this.assertInScope(projectId, 'session listing');
      return this.prep(
        `SELECT s.* FROM sessions s
           JOIN modules m ON m.id = s.module_id
          WHERE m.project_id = ? AND s.ended_at IS NULL
          ORDER BY s.started_at`,
      ).all(projectId) as SessionRow[];
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // observations
  // ─────────────────────────────────────────────────────────────────
  observations = {
    /**
     * Insert a note, or update the one that already covers this topic.
     *
     * With `topicKey` set this is an upsert: the existing row for that
     * topic is rewritten in place and `updated_at` is stamped. That is the
     * whole point of topic identity — the agent used to express it by
     * titling a new note "DEFINITIVE — supersedes notes 80 and 81", which
     * left the reader to work out which version won.
     */
    add: (params: {
      sessionId: number;
      kind: ObservationKind;
      title: string;
      content: string;
      storyLocalId?: string;
      files?: string;
      tags?: string;
      topicKey?: string | null;
      /** Keep the previous row and point at it instead of overwriting. */
      keepHistory?: boolean;
    }): { row: ObservationRow; status: 'inserted' | 'updated' } => {
      const session = this.sessions.findById(params.sessionId);
      if (!session) {
        throw new MyJarbisError(
          ErrorType.SESSION_NOT_ACTIVE,
          `Session ${params.sessionId} not found.`,
        );
      }
      const projectId = this.projectIdOfModule(session.module_id);
      this.assertInScope(projectId, 'observation');

      const topicKey = params.topicKey ?? null;
      const existing =
        topicKey && projectId !== null
          ? ((this.prep(
              'SELECT * FROM observations WHERE project_id = ? AND topic_key = ?',
            ).get(projectId, topicKey) as ObservationRow | undefined) ?? null)
          : null;

      if (existing && !params.keepHistory) {
        this.prep(
          `UPDATE observations
              SET session_id = ?, kind = ?, title = ?, content = ?,
                  story_local_id = ?, files = ?, tags = ?,
                  updated_at = datetime('now')
            WHERE id = ?`,
        ).run(
          params.sessionId,
          params.kind,
          params.title,
          params.content,
          params.storyLocalId ?? null,
          params.files ?? null,
          params.tags ?? null,
          existing.id,
        );
        return { row: this.observations.findById(existing.id)!, status: 'updated' };
      }

      // keepHistory: free the unique topic slot on the old row first, then
      // insert the new one pointing back at it. Without releasing it the
      // partial unique index rejects the insert.
      if (existing && params.keepHistory) {
        this.prep('UPDATE observations SET topic_key = NULL WHERE id = ?').run(existing.id);
      }

      const info = this.prep(
        `INSERT INTO observations(
           session_id, project_id, kind, title, content,
           story_local_id, files, tags, topic_key, supersedes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        params.sessionId,
        projectId,
        params.kind,
        params.title,
        params.content,
        params.storyLocalId ?? null,
        params.files ?? null,
        params.tags ?? null,
        topicKey,
        existing && params.keepHistory ? existing.id : null,
      );
      return {
        row: this.observations.findById(Number(info.lastInsertRowid))!,
        status: 'inserted',
      };
    },

    /**
     * Patch a note in place. An absent key means "leave this column alone",
     * which is why every field is read back off `row` as its own default
     * rather than defaulting to NULL — a partial patch must never blank the
     * columns it did not mention.
     *
     * `files` is nullable on purpose: `undefined` preserves, an explicit
     * `null` clears. Without the explicit-null channel a wrong `files` value
     * could only ever be replaced by another wrong one.
     */
    update: (
      id: number,
      patch: {
        title?: string;
        content?: string;
        tags?: string | null;
        kind?: ObservationKind;
        files?: string | null;
        story_local_id?: string | null;
      },
    ): ObservationRow => {
      const row = this.observations.findById(id);
      if (!row) {
        throw new MyJarbisError(ErrorType.INVALID_INPUT, `Observation ${id} not found.`);
      }
      this.prep(
        `UPDATE observations
            SET title = ?, content = ?, tags = ?, kind = ?, files = ?,
                story_local_id = ?, updated_at = datetime('now')
          WHERE id = ?`,
      ).run(
        patch.title ?? row.title,
        patch.content ?? row.content,
        patch.tags === undefined ? row.tags : patch.tags,
        patch.kind ?? row.kind,
        patch.files === undefined ? row.files : patch.files,
        patch.story_local_id === undefined ? row.story_local_id : patch.story_local_id,
        id,
      );
      return this.observations.findById(id)!;
    },

    findById: (id: number): ObservationRow | null => {
      const row =
        (this.prep('SELECT * FROM observations WHERE id = ?').get(id) as
          | ObservationRow
          | undefined) ?? null;
      if (row) this.assertInScope(row.project_id, `observation ${id}`);
      return row;
    },

    findByTopic: (projectId: number, topicKey: string): ObservationRow | null => {
      this.assertInScope(projectId, 'observation lookup');
      return (
        (this.prep(
          'SELECT * FROM observations WHERE project_id = ? AND topic_key = ?',
        ).get(projectId, topicKey) as ObservationRow | undefined) ?? null
      );
    },

    /** Every topic key in use, so the agent can reuse one instead of
     *  inventing a near-duplicate. Without this, topic keys drift the same
     *  way free-text kinds did. */
    listTopicKeys: (projectId: number): Array<{ topic_key: string; title: string; updated_at: string | null }> => {
      this.assertInScope(projectId, 'observation listing');
      return this.prep(
        `SELECT topic_key, title, updated_at FROM observations
          WHERE project_id = ? AND topic_key IS NOT NULL
          ORDER BY topic_key`,
      ).all(projectId) as Array<{ topic_key: string; title: string; updated_at: string | null }>;
    },

    listBySession: (sessionId: number): ObservationRow[] => {
      this.sessions.findById(sessionId); // scope check
      return this.prep(
        'SELECT * FROM observations WHERE session_id = ? ORDER BY created_at',
      ).all(sessionId) as ObservationRow[];
    },

    listByModule: (moduleId: number, limit = 50): ObservationRow[] => {
      this.assertInScope(this.projectIdOfModule(moduleId), 'observation listing');
      return this.prep(
        `SELECT o.* FROM observations o
           JOIN sessions s ON s.id = o.session_id
          WHERE s.module_id = ?
          ORDER BY o.created_at DESC, o.id DESC
          LIMIT ?`,
      ).all(moduleId, limit) as ObservationRow[];
    },

    listByProject: (projectId: number, limit = 50): ObservationRow[] => {
      this.assertInScope(projectId, 'observation listing');
      return this.prep(
        `SELECT * FROM observations WHERE project_id = ?
          ORDER BY COALESCE(updated_at, created_at) DESC, id DESC LIMIT ?`,
      ).all(projectId, limit) as ObservationRow[];
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // refs — typed links out of a note
  // ─────────────────────────────────────────────────────────────────
  refs = {
    add: (params: {
      observationId: number;
      kind: RefKind;
      provider: string;
      externalId: string;
      url?: string | null;
    }): RefRow => {
      this.observations.findById(params.observationId); // scope check
      this.prep(
        `INSERT INTO refs(observation_id, kind, provider, external_id, url)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(observation_id, provider, kind, external_id)
           DO UPDATE SET url = excluded.url`,
      ).run(
        params.observationId,
        params.kind,
        params.provider,
        params.externalId,
        params.url ?? null,
      );
      return this.prep(
        `SELECT * FROM refs
          WHERE observation_id = ? AND provider = ? AND kind = ? AND external_id = ?`,
      ).get(
        params.observationId,
        params.provider,
        params.kind,
        params.externalId,
      ) as RefRow;
    },

    listByObservation: (observationId: number): RefRow[] => {
      this.observations.findById(observationId); // scope check
      return this.prep('SELECT * FROM refs WHERE observation_id = ? ORDER BY id').all(
        observationId,
      ) as RefRow[];
    },

    /**
     * "Did I already do this?" as a lookup rather than a paragraph.
     *
     * Scoped through the owning observation, so one project cannot learn
     * what another has already published.
     */
    find: (params: {
      provider: string;
      kind?: RefKind;
      externalId: string;
    }): Array<RefRow & { observation_title: string; project_id: number | null }> => {
      const scope = this.scopeFilter('o.project_id');
      const extra = params.kind ? ' AND r.kind = ?' : '';
      const args: unknown[] = [params.provider, params.externalId];
      if (params.kind) args.push(params.kind);
      args.push(...scope.params);
      return this.prep(
        `SELECT r.*, o.title AS observation_title, o.project_id
           FROM refs r
           JOIN observations o ON o.id = r.observation_id
          WHERE r.provider = ? AND r.external_id = ?${extra}${scope.sql}
          ORDER BY r.created_at DESC`,
      ).all(...args) as Array<RefRow & { observation_title: string; project_id: number | null }>;
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // project_state — the living "resume here", one row per project
  // ─────────────────────────────────────────────────────────────────
  projectState = {
    get: (projectId: number): ProjectStateRow | null => {
      this.assertInScope(projectId, 'project_state');
      return (
        (this.prep('SELECT * FROM project_state WHERE project_id = ?').get(projectId) as
          | ProjectStateRow
          | undefined) ?? null
      );
    },

    set: (params: {
      projectId: number;
      content: string;
      updatedBy?: string | null;
    }): ProjectStateRow => {
      this.assertInScope(params.projectId, 'project_state');
      this.prep(
        `INSERT INTO project_state(project_id, content, updated_at, updated_by)
         VALUES (?, ?, datetime('now'), ?)
         ON CONFLICT(project_id) DO UPDATE SET
           content    = excluded.content,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      ).run(params.projectId, params.content, params.updatedBy ?? null);
      return this.projectState.get(params.projectId)!;
    },

    /**
     * Take the advisory write lock, unless someone else holds a live one.
     *
     * `ttlSeconds` is what keeps this usable: a lock with no expiry wedges
     * the project the first time a process dies holding it, and the user
     * has no obvious way to tell a crashed session from a busy one.
     * Returns the holder when the lock is denied.
     */
    lock: (params: {
      projectId: number;
      sessionTag: string;
      ttlSeconds?: number;
    }): { acquired: boolean; heldBy?: string; heldSince?: string } => {
      this.assertInScope(params.projectId, 'project_state');
      const ttl = params.ttlSeconds ?? 900;
      const current = this.projectState.get(params.projectId);

      if (current?.locked_by && current.locked_at && current.locked_by !== params.sessionTag) {
        const ageSeconds = this.prep(
          `SELECT CAST((julianday('now') - julianday(?)) * 86400 AS INTEGER) AS age`,
        ).get(current.locked_at) as { age: number };
        if (ageSeconds.age < ttl) {
          return {
            acquired: false,
            heldBy: current.locked_by,
            heldSince: current.locked_at,
          };
        }
        // Expired: fall through and take it over.
      }

      this.prep(
        `INSERT INTO project_state(project_id, content, locked_by, locked_at)
         VALUES (?, '', ?, datetime('now'))
         ON CONFLICT(project_id) DO UPDATE SET
           locked_by = excluded.locked_by,
           locked_at = excluded.locked_at`,
      ).run(params.projectId, params.sessionTag);
      return { acquired: true };
    },

    /**
     * Release the lock. Only the holder can, unless `force` — a session that
     * deliberately overrode someone else's lock has to be able to clear it,
     * or the overridden holder's lock lingers forever and every later writer
     * is told a dead session is busy.
     */
    unlock: (projectId: number, sessionTag: string, force = false): void => {
      this.assertInScope(projectId, 'project_state');
      if (force) {
        this.prep(
          `UPDATE project_state SET locked_by = NULL, locked_at = NULL WHERE project_id = ?`,
        ).run(projectId);
        return;
      }
      this.prep(
        `UPDATE project_state SET locked_by = NULL, locked_at = NULL
          WHERE project_id = ? AND locked_by = ?`,
      ).run(projectId, sessionTag);
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // providers — what a project talks to
  // ─────────────────────────────────────────────────────────────────
  providers = {
    upsert: (params: {
      projectId: number;
      role: ProviderRole;
      kind: string;
      config?: string | null;
    }): ProviderRow => {
      this.assertInScope(params.projectId, 'provider');
      this.prep(
        `INSERT INTO providers(project_id, role, kind, config)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, role) DO UPDATE SET
           kind = excluded.kind, config = excluded.config`,
      ).run(params.projectId, params.role, params.kind, params.config ?? null);
      return this.providers.findByRole(params.projectId, params.role)!;
    },

    findByRole: (projectId: number, role: ProviderRole): ProviderRow | null => {
      this.assertInScope(projectId, 'provider lookup');
      return (
        (this.prep('SELECT * FROM providers WHERE project_id = ? AND role = ?').get(
          projectId,
          role,
        ) as ProviderRow | undefined) ?? null
      );
    },

    listByProject: (projectId: number): ProviderRow[] => {
      this.assertInScope(projectId, 'provider listing');
      return this.prep('SELECT * FROM providers WHERE project_id = ? ORDER BY role').all(
        projectId,
      ) as ProviderRow[];
    },

    delete: (projectId: number, role: ProviderRole): void => {
      this.assertInScope(projectId, 'provider');
      this.prep('DELETE FROM providers WHERE project_id = ? AND role = ?').run(projectId, role);
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // workflows — rows, with org → project → user inheritance
  // ─────────────────────────────────────────────────────────────────
  workflows = {
    upsert: (params: {
      slug: string;
      name: string;
      scope: WorkflowScope;
      scopeId: number;
      extends?: number | null;
    }): WorkflowRow => {
      if (params.scope === 'project') {
        this.assertInScope(params.scopeId, 'workflow');
      }
      this.prep(
        `INSERT INTO workflows(slug, name, scope, scope_id, extends)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(slug, scope, scope_id) DO UPDATE SET
           name = excluded.name, extends = excluded.extends`,
      ).run(params.slug, params.name, params.scope, params.scopeId, params.extends ?? null);
      return this.workflows.find(params.slug, params.scope, params.scopeId)!;
    },

    find: (slug: string, scope: WorkflowScope, scopeId: number): WorkflowRow | null =>
      (this.prep(
        'SELECT * FROM workflows WHERE slug = ? AND scope = ? AND scope_id = ?',
      ).get(slug, scope, scopeId) as WorkflowRow | undefined) ?? null,

    findById: (id: number): WorkflowRow | null =>
      (this.prep('SELECT * FROM workflows WHERE id = ?').get(id) as WorkflowRow | undefined) ??
      null,

    /** Every slug reachable from a project: its own, its org's, the user's. */
    listSlugs: (projectId: number, orgId: number | null): string[] => {
      this.assertInScope(projectId, 'workflow listing');
      const rows = this.prep(
        `SELECT DISTINCT slug FROM workflows
          WHERE (scope = 'project' AND scope_id = ?)
             OR (scope = 'org'     AND scope_id = ?)
             OR  scope = 'user'
          ORDER BY slug`,
      ).all(projectId, orgId ?? -1) as Array<{ slug: string }>;
      return rows.map((r) => r.slug);
    },

    /** The three layers for one slug, ordered least to most specific. */
    layersFor: (slug: string, projectId: number, orgId: number | null): WorkflowRow[] => {
      this.assertInScope(projectId, 'workflow lookup');
      return this.prep(
        `SELECT * FROM workflows
          WHERE slug = ?
            AND ( (scope = 'org'     AND scope_id = ?)
               OR (scope = 'project' AND scope_id = ?)
               OR  scope = 'user' )
          ORDER BY CASE scope WHEN 'org' THEN 1 WHEN 'project' THEN 2 ELSE 3 END`,
      ).all(slug, orgId ?? -1, projectId) as WorkflowRow[];
    },

    delete: (id: number): void => {
      this.prep('DELETE FROM workflows WHERE id = ?').run(id);
    },
  };

  workflowSteps = {
    upsert: (params: {
      workflowId: number;
      position: number;
      name: string;
      actor: string;
      gate?: StepGate;
      capability?: string | null;
      condition?: string | null;
      notes?: string | null;
      overrides?: number | null;
      disabled?: boolean;
    }): WorkflowStepRow => {
      this.prep(
        `INSERT INTO workflow_steps(
           workflow_id, position, name, actor, gate, capability,
           condition, notes, overrides, disabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workflow_id, name) DO UPDATE SET
           position   = excluded.position,
           actor      = excluded.actor,
           gate       = excluded.gate,
           capability = excluded.capability,
           condition  = excluded.condition,
           notes      = excluded.notes,
           overrides  = excluded.overrides,
           disabled   = excluded.disabled`,
      ).run(
        params.workflowId,
        params.position,
        params.name,
        params.actor,
        params.gate ?? 'none',
        params.capability ?? null,
        params.condition ?? null,
        params.notes ?? null,
        params.overrides ?? null,
        params.disabled ? 1 : 0,
      );
      return this.prep(
        'SELECT * FROM workflow_steps WHERE workflow_id = ? AND name = ?',
      ).get(params.workflowId, params.name) as WorkflowStepRow;
    },

    listByWorkflow: (workflowId: number): WorkflowStepRow[] =>
      this.prep(
        'SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY position, id',
      ).all(workflowId) as WorkflowStepRow[],

    delete: (id: number): void => {
      this.prep('DELETE FROM workflow_steps WHERE id = ?').run(id);
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // timeline: chronological feed of sessions + observations for a
  // module. Reading the feed is 10× faster than loading the full
  // module_context dump when ramping back into a paused module.
  // ─────────────────────────────────────────────────────────────────
  timeline(
    moduleId: number,
    opts: { limit?: number } = {},
  ): TimelineEvent[] {
    const limit = opts.limit ?? 100;
    const sessions = this.prep(
      `SELECT id, started_at, ended_at, summary, next_session
         FROM sessions
        WHERE module_id = ?
        ORDER BY started_at`,
    ).all(moduleId) as Array<{
      id: number;
      started_at: string;
      ended_at: string | null;
      summary: string | null;
      next_session: string | null;
    }>;

    const observations = this.prep(
      `SELECT o.id, o.session_id, o.kind, o.title, o.story_local_id, o.created_at
         FROM observations o
         JOIN sessions s ON s.id = o.session_id
        WHERE s.module_id = ?
        ORDER BY o.created_at`,
    ).all(moduleId) as Array<{
      id: number;
      session_id: number;
      kind: ObservationKind;
      title: string;
      story_local_id: string | null;
      created_at: string;
    }>;

    const observationsBySession = new Map<number, number>();
    for (const o of observations) {
      observationsBySession.set(
        o.session_id,
        (observationsBySession.get(o.session_id) ?? 0) + 1,
      );
    }

    const events: TimelineEvent[] = [];
    for (const s of sessions) {
      events.push({ type: 'session_start', at: s.started_at, sessionId: s.id });
      if (s.ended_at) {
        events.push({
          type: 'session_end',
          at: s.ended_at,
          sessionId: s.id,
          summary: s.summary,
          nextSession: s.next_session,
          observationsCount: observationsBySession.get(s.id) ?? 0,
        });
      }
    }
    for (const o of observations) {
      events.push({
        type: 'observation',
        at: o.created_at,
        sessionId: o.session_id,
        observationId: o.id,
        kind: o.kind,
        title: o.title,
        storyLocalId: o.story_local_id,
      });
    }

    events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return events.slice(0, limit);
  }

  // ─────────────────────────────────────────────────────────────────
  // search (FTS5 across the 4 indexed tables, scoped)
  // ─────────────────────────────────────────────────────────────────
  search(
    query: string,
    opts: {
      scope?: SearchScope;
      moduleId?: number;
      /** Several modules, when a session has companions open beside its
       *  primary. Supersedes `moduleId` when both are given; `moduleId`
       *  remains for the single-module callers, which are most of them. */
      moduleIds?: number[];
      limit?: number;
    } = {},
  ): SearchHit[] {
    const scope = opts.scope ?? 'module';
    const limit = opts.limit ?? 50;
    const hits: SearchHit[] = [];

    // The tenant filter comes from the connection, never from the caller.
    // There used to be an optional `projectId` here, and omitting it meant
    // "search every project in the file". Under one DB per project that was
    // harmless; under a shared DB it is a cross-client text search, which
    // is precisely how these tools leak. Reading `this.scope` also means an
    // unscoped connection throws rather than quietly matching everything.
    const projectScope = this.scopeFilter('pc.project_id');
    const scopedProjectId = this.scopedProjectId;
    const ftsQuery = sanitizeFtsQuery(query);

    const wantPC = scope === 'module' || scope === 'project';
    const wantMC = scope === 'module' || scope === 'project' || scope === 'module_only';
    const wantObs = scope === 'observations';
    const wantSkills = scope === 'skills';

    if (wantPC) {
      const rows = this.prep(
        `SELECT pc.id AS rowid, pc.title, pc.kind,
                snippet(project_context_fts, 1, '«', '»', '…', 12) AS snippet,
                rank
           FROM project_context_fts
           JOIN project_context pc ON pc.id = project_context_fts.rowid
          WHERE project_context_fts MATCH ?${projectScope.sql}
          ORDER BY rank
          LIMIT ?`,
      ).all(ftsQuery, ...projectScope.params, limit) as Array<{
        rowid: number;
        title: string;
        kind: string;
        snippet: string;
        rank: number;
      }>;
      for (const r of rows) {
        hits.push({
          source: 'project_context',
          rowid: r.rowid,
          title: r.title,
          snippet: r.snippet,
          rank: r.rank,
          meta: { kind: r.kind },
        });
      }
    }

    if (wantMC) {
      // One list, however the caller expressed it, so the filter below has a
      // single shape to reason about.
      const targetModules =
        opts.moduleIds && opts.moduleIds.length > 0
          ? [...new Set(opts.moduleIds)]
          : opts.moduleId
            ? [opts.moduleId]
            : [];
      const filterByModule =
        scope === 'module_only' || (scope === 'module' && targetModules.length > 0);
      const params: unknown[] = [ftsQuery];
      let where = 'WHERE module_context_fts MATCH ?';
      if (filterByModule && targetModules.length > 0) {
        where += ` AND mc.module_id IN (${targetModules.map(() => '?').join(',')})`;
        params.push(...targetModules);
      }
      // Always pin to the tenant, module filter or not.
      if (scopedProjectId !== null) {
        where += ' AND m.project_id = ?';
        params.push(scopedProjectId);
      }
      params.push(limit);

      const rows = this.prep(
        `SELECT mc.id AS rowid, mc.title, mc.kind, mc.module_id,
                snippet(module_context_fts, 1, '«', '»', '…', 12) AS snippet,
                rank
           FROM module_context_fts
           JOIN module_context mc ON mc.id = module_context_fts.rowid
           JOIN modules m ON m.id = mc.module_id
           ${where}
          ORDER BY rank
          LIMIT ?`,
      ).all(...params) as Array<{
        rowid: number;
        title: string;
        kind: string;
        module_id: number;
        snippet: string;
        rank: number;
      }>;
      for (const r of rows) {
        hits.push({
          source: 'module_context',
          rowid: r.rowid,
          title: r.title,
          snippet: r.snippet,
          rank: r.rank,
          meta: { kind: r.kind, moduleId: r.module_id },
        });
      }
    }

    if (wantObs) {
      const obsModules =
        opts.moduleIds && opts.moduleIds.length > 0
          ? [...new Set(opts.moduleIds)]
          : opts.moduleId
            ? [opts.moduleId]
            : [];
      const params: unknown[] = [ftsQuery];
      let where = 'WHERE observations_fts MATCH ?';
      if (obsModules.length > 0) {
        where += ` AND s.module_id IN (${obsModules.map(() => '?').join(',')})`;
        params.push(...obsModules);
      }
      // Filter on the denormalised column; it is why that column exists.
      if (scopedProjectId !== null) {
        where += ' AND o.project_id = ?';
        params.push(scopedProjectId);
      }
      params.push(limit);

      const rows = this.prep(
        `SELECT o.id AS rowid, o.title, o.kind, o.story_local_id, o.project_id,
                snippet(observations_fts, 1, '«', '»', '…', 12) AS snippet,
                rank
           FROM observations_fts
           JOIN observations o ON o.id = observations_fts.rowid
           JOIN sessions s ON s.id = o.session_id
           ${where}
          ORDER BY rank
          LIMIT ?`,
      ).all(...params) as Array<{
        rowid: number;
        title: string;
        kind: string;
        story_local_id: string | null;
        project_id: number | null;
        snippet: string;
        rank: number;
      }>;
      for (const r of rows) {
        hits.push({
          source: 'observation',
          rowid: r.rowid,
          title: r.title,
          snippet: r.snippet,
          rank: r.rank,
          meta: {
            kind: r.kind,
            storyLocalId: r.story_local_id,
            ...(scopedProjectId === null ? { projectId: r.project_id } : {}),
          },
        });
      }
    }

    if (wantSkills) {
      const params: unknown[] = [ftsQuery];
      let where = 'WHERE skills_fts MATCH ?';
      if (scopedProjectId !== null) {
        where += ' AND sk.project_id = ?';
        params.push(scopedProjectId);
      }
      params.push(limit);

      const rows = this.prep(
        `SELECT sk.id AS rowid, sk.name AS title, sk.module_id,
                snippet(skills_fts, 2, '«', '»', '…', 12) AS snippet,
                rank
           FROM skills_fts
           JOIN skills sk ON sk.id = skills_fts.rowid
           ${where}
          ORDER BY rank
          LIMIT ?`,
      ).all(...params) as Array<{
        rowid: number;
        title: string;
        module_id: number | null;
        snippet: string;
        rank: number;
      }>;
      for (const r of rows) {
        hits.push({
          source: 'skill',
          rowid: r.rowid,
          title: r.title,
          snippet: r.snippet,
          rank: r.rank,
          meta: { moduleId: r.module_id },
        });
      }
    }

    return hits.sort((a, b) => a.rank - b.rank).slice(0, limit);
  }

  /**
   * Rebuild every FTS5 index from its content table.
   *
   * Required after a merge: the indexes are contentless and keyed by
   * rowid, so remapping ids leaves them pointing at the wrong rows. An
   * index that resolves to a different row than it indexed is worse than
   * no index, because the hit looks legitimate.
   */
  rebuildFts(): void {
    for (const t of [
      'project_context_fts',
      'module_context_fts',
      'skills_fts',
      'observations_fts',
    ]) {
      this.db.exec(`INSERT INTO ${t}(${t}) VALUES('rebuild')`);
    }
  }
}

/**
 * Turn a user query into a safe FTS5 expression.
 *
 * Multi-word input is AND-ed term by term, NOT wrapped as a single phrase.
 * Wrapping the whole thing (what this did before) meant `sangria copiar pegar`
 * only matched if those three words appeared contiguously — so a document
 * saying "plano para copiar y pegar, sin markdown y SIN SANGRÍA" returned zero
 * hits despite containing every term. Zero hits reads as "not in the brain",
 * which is the opposite of the truth: a false negative is worse than no search
 * at all.
 *
 * Rules:
 *   - `raw:` prefix  → the rest is passed to FTS5 verbatim (operators, NEAR,
 *                      column filters). Escape hatch for deliberate queries.
 *   - `"..."` inside → preserved as an explicit phrase.
 *   - everything else → split on whitespace, each term quoted (which neutralises
 *                       FTS5 reserved characters and keeps bare AND/OR/NOT as
 *                       literals), joined with AND.
 *
 * Quoting each term also fixes hyphenated words: `split-brain` becomes the
 * phrase "split brain", which is exactly how the tokenizer stored it. Left
 * bare, the `-` would parse as the NOT operator and silently invert the query.
 *
 * Note on accents: the default unicode61 tokenizer already folds them, so
 * `sangria` and `sangría` are equivalent. No tokenizer change is needed.
 */
function sanitizeFtsQuery(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '""';

  if (/^raw:/i.test(trimmed)) {
    const raw = trimmed.slice(4).trim();
    return raw || '""';
  }

  // Pull out "quoted phrases" first, then whatever bare words are left.
  const terms: string[] = [];
  const rest = trimmed.replace(/"([^"]*)"/g, (_m, phrase: string) => {
    const p = String(phrase).trim();
    if (p) terms.push(`"${p}"`);
    return ' ';
  });

  for (const word of rest.split(/\s+/)) {
    const w = word.trim().replace(/"/g, '');
    if (w) terms.push(`"${w}"`);
  }

  if (terms.length === 0) return '""';
  return terms.join(' AND ');
}
