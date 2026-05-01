/**
 * MyJarbis v0.2 — better-sqlite3 wrapper
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
} from './schema.js';

// ───────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf-8').digest('hex');
}

export type SearchScope =
  | 'module'        // active module context + project core (default)
  | 'project'       // all module contexts of project + project core
  | 'module_only'   // only the given module context
  | 'observations'  // observations in module sessions
  | 'skills';       // skills (project + module-level)

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

  private constructor(db: Database.Database, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /**
   * Open or create memory.db at <projectPath>/.myjarbis/memory.db.
   * Applies the schema (idempotent) and bumps meta.schema_version.
   */
  static open(projectPath: string): MyJarbisDB {
    const myjarbisDir = path.join(projectPath, '.myjarbis');
    if (!fs.existsSync(myjarbisDir)) {
      fs.mkdirSync(myjarbisDir, { recursive: true });
    }
    const dbPath = path.join(myjarbisDir, 'memory.db');

    const db = new Database(dbPath);
    db.exec(SCHEMA_SQL);

    // Record schema version (idempotent UPSERT)
    const upsertMeta = db.prepare(
      `INSERT INTO meta(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    );
    upsertMeta.run('schema_version', String(SCHEMA_VERSION));

    return new MyJarbisDB(db, dbPath);
  }

  /** Open against an explicit path (used by tests / migrations). */
  static openAtPath(dbPath: string): MyJarbisDB {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const db = new Database(dbPath);
    db.exec(SCHEMA_SQL);
    db.prepare(
      `INSERT INTO meta(key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(SCHEMA_VERSION));
    return new MyJarbisDB(db, dbPath);
  }

  close(): void {
    this.db.close();
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
  projects = {
    create: (name: string, projectPath: string, framework?: string): ProjectRow => {
      const info = this.prep(
        'INSERT INTO projects(name, path, framework) VALUES (?, ?, ?)',
      ).run(name, projectPath, framework ?? null);
      return this.projects.findById(Number(info.lastInsertRowid))!;
    },

    upsertByPath: (name: string, projectPath: string, framework?: string): ProjectRow => {
      const existing = this.projects.findByPath(projectPath);
      if (existing) return existing;
      return this.projects.create(name, projectPath, framework);
    },

    findById: (id: number): ProjectRow | null =>
      (this.prep('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined) ?? null,

    findByName: (name: string): ProjectRow | null =>
      (this.prep('SELECT * FROM projects WHERE name = ?').get(name) as ProjectRow | undefined) ?? null,

    findByPath: (projectPath: string): ProjectRow | null =>
      (this.prep('SELECT * FROM projects WHERE path = ?').get(projectPath) as
        | ProjectRow
        | undefined) ?? null,

    list: (): ProjectRow[] =>
      this.prep('SELECT * FROM projects ORDER BY name').all() as ProjectRow[],
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

    findById: (id: number): ProjectContextRow | null =>
      (this.prep('SELECT * FROM project_context WHERE id = ?').get(id) as
        | ProjectContextRow
        | undefined) ?? null,

    listByProject: (projectId: number): ProjectContextRow[] =>
      this.prep('SELECT * FROM project_context WHERE project_id = ? ORDER BY kind, title').all(
        projectId,
      ) as ProjectContextRow[],
  };

  // ─────────────────────────────────────────────────────────────────
  // modules
  // ─────────────────────────────────────────────────────────────────
  modules = {
    create: (projectId: number, name: string, description?: string): ModuleRow => {
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

    findById: (id: number): ModuleRow | null =>
      (this.prep('SELECT * FROM modules WHERE id = ?').get(id) as ModuleRow | undefined) ?? null,

    findByName: (projectId: number, name: string): ModuleRow | null =>
      (this.prep('SELECT * FROM modules WHERE project_id = ? AND name = ?').get(
        projectId,
        name,
      ) as ModuleRow | undefined) ?? null,

    listByProject: (projectId: number): ModuleRow[] =>
      this.prep('SELECT * FROM modules WHERE project_id = ? ORDER BY name').all(
        projectId,
      ) as ModuleRow[],

    setStatus: (id: number, status: ModuleStatus): void => {
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

    findById: (id: number): ModuleContextRow | null =>
      (this.prep('SELECT * FROM module_context WHERE id = ?').get(id) as
        | ModuleContextRow
        | undefined) ?? null,

    listByModule: (moduleId: number): ModuleContextRow[] =>
      this.prep('SELECT * FROM module_context WHERE module_id = ? ORDER BY kind, title').all(
        moduleId,
      ) as ModuleContextRow[],
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

    findById: (id: number): SkillRow | null =>
      (this.prep('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined) ?? null,

    findByName: (projectId: number, moduleId: number | null, name: string): SkillRow | null =>
      (this.prep(
        moduleId === null
          ? 'SELECT * FROM skills WHERE project_id = ? AND module_id IS NULL AND name = ?'
          : 'SELECT * FROM skills WHERE project_id = ? AND module_id = ? AND name = ?',
      ).get(...(moduleId === null ? [projectId, name] : [projectId, moduleId, name])) as
        | SkillRow
        | undefined) ?? null,

    /** Skills that should be loaded for a session in `moduleId`:
     *  project-level (module_id IS NULL) + module-level for that module.
     *  Both filtered by enabled = 1.
     */
    listForSession: (projectId: number, moduleId: number): SkillRow[] =>
      this.prep(
        `SELECT * FROM skills
          WHERE project_id = ? AND enabled = 1
            AND (module_id IS NULL OR module_id = ?)
          ORDER BY module_id IS NOT NULL, name`,
      ).all(projectId, moduleId) as SkillRow[],

    listByProject: (projectId: number, opts: { onlyProjectLevel?: boolean } = {}): SkillRow[] =>
      this.prep(
        opts.onlyProjectLevel
          ? 'SELECT * FROM skills WHERE project_id = ? AND module_id IS NULL ORDER BY name'
          : 'SELECT * FROM skills WHERE project_id = ? ORDER BY module_id IS NOT NULL, name',
      ).all(projectId) as SkillRow[],

    listByModule: (moduleId: number): SkillRow[] =>
      this.prep('SELECT * FROM skills WHERE module_id = ? ORDER BY name').all(moduleId) as SkillRow[],

    setEnabled: (id: number, enabled: boolean): void => {
      this.prep('UPDATE skills SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    },

    delete: (id: number): void => {
      this.prep('DELETE FROM skills WHERE id = ?').run(id);
    },
  };

  // ─────────────────────────────────────────────────────────────────
  // sessions
  // ─────────────────────────────────────────────────────────────────
  sessions = {
    start: (moduleId: number): SessionRow => {
      const info = this.prep('INSERT INTO sessions(module_id) VALUES (?)').run(moduleId);
      return this.sessions.findById(Number(info.lastInsertRowid))!;
    },

    end: (id: number, summary: string, nextSession: string): SessionRow => {
      this.prep(
        `UPDATE sessions
            SET ended_at = datetime('now'), summary = ?, next_session = ?
          WHERE id = ?`,
      ).run(summary, nextSession, id);
      return this.sessions.findById(id)!;
    },

    findById: (id: number): SessionRow | null =>
      (this.prep('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined) ?? null,

    /** Latest session of a module, regardless of ended_at. */
    findLastByModule: (moduleId: number): SessionRow | null =>
      (this.prep(
        'SELECT * FROM sessions WHERE module_id = ? ORDER BY started_at DESC LIMIT 1',
      ).get(moduleId) as SessionRow | undefined) ?? null,

    /** Latest CLOSED session (has next_session) for the "Retomar aquí" lookup. */
    findLastClosedByModule: (moduleId: number): SessionRow | null =>
      (this.prep(
        `SELECT * FROM sessions
          WHERE module_id = ? AND ended_at IS NOT NULL AND next_session IS NOT NULL
          ORDER BY ended_at DESC LIMIT 1`,
      ).get(moduleId) as SessionRow | undefined) ?? null,

    /** Currently-open session (no ended_at) for a module, if any. */
    findActiveByModule: (moduleId: number): SessionRow | null =>
      (this.prep(
        'SELECT * FROM sessions WHERE module_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1',
      ).get(moduleId) as SessionRow | undefined) ?? null,
  };

  // ─────────────────────────────────────────────────────────────────
  // observations
  // ─────────────────────────────────────────────────────────────────
  observations = {
    add: (params: {
      sessionId: number;
      kind: ObservationKind;
      title: string;
      content: string;
      storyLocalId?: string;
      files?: string;
      tags?: string;
    }): ObservationRow => {
      const info = this.prep(
        `INSERT INTO observations(session_id, kind, title, content, story_local_id, files, tags)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        params.sessionId,
        params.kind,
        params.title,
        params.content,
        params.storyLocalId ?? null,
        params.files ?? null,
        params.tags ?? null,
      );
      return this.observations.findById(Number(info.lastInsertRowid))!;
    },

    findById: (id: number): ObservationRow | null =>
      (this.prep('SELECT * FROM observations WHERE id = ?').get(id) as
        | ObservationRow
        | undefined) ?? null,

    listBySession: (sessionId: number): ObservationRow[] =>
      this.prep('SELECT * FROM observations WHERE session_id = ? ORDER BY created_at').all(
        sessionId,
      ) as ObservationRow[],

    listByModule: (moduleId: number, limit = 50): ObservationRow[] =>
      this.prep(
        `SELECT o.* FROM observations o
           JOIN sessions s ON s.id = o.session_id
          WHERE s.module_id = ?
          ORDER BY o.created_at DESC
          LIMIT ?`,
      ).all(moduleId, limit) as ObservationRow[],
  };

  // ─────────────────────────────────────────────────────────────────
  // search (FTS5 across the 4 indexed tables, scoped)
  // ─────────────────────────────────────────────────────────────────
  search(
    query: string,
    opts: {
      scope?: SearchScope;
      projectId?: number;
      moduleId?: number;
      limit?: number;
    } = {},
  ): SearchHit[] {
    const scope = opts.scope ?? 'module';
    const limit = opts.limit ?? 50;
    const hits: SearchHit[] = [];

    const ftsQuery = sanitizeFtsQuery(query);

    const wantPC = scope === 'module' || scope === 'project';
    const wantMC = scope === 'module' || scope === 'project' || scope === 'module_only';
    const wantObs = scope === 'observations';
    const wantSkills = scope === 'skills';

    if (wantPC && opts.projectId) {
      const rows = this.prep(
        `SELECT pc.id AS rowid, pc.title, pc.kind,
                snippet(project_context_fts, 1, '«', '»', '…', 12) AS snippet,
                rank
           FROM project_context_fts
           JOIN project_context pc ON pc.id = project_context_fts.rowid
          WHERE project_context_fts MATCH ?
            AND pc.project_id = ?
          ORDER BY rank
          LIMIT ?`,
      ).all(ftsQuery, opts.projectId, limit) as Array<{
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
      const filterByModule = scope === 'module_only' || (scope === 'module' && opts.moduleId);
      const params: unknown[] = [ftsQuery];
      let where = 'WHERE module_context_fts MATCH ?';
      if (filterByModule && opts.moduleId) {
        where += ' AND mc.module_id = ?';
        params.push(opts.moduleId);
      } else if (scope === 'project' && opts.projectId) {
        where += ' AND m.project_id = ?';
        params.push(opts.projectId);
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
      const params: unknown[] = [ftsQuery];
      let where = 'WHERE observations_fts MATCH ?';
      if (opts.moduleId) {
        where += ' AND s.module_id = ?';
        params.push(opts.moduleId);
      } else if (opts.projectId) {
        where += ' AND m.project_id = ?';
        params.push(opts.projectId);
      }
      params.push(limit);

      const rows = this.prep(
        `SELECT o.id AS rowid, o.title, o.kind, o.story_local_id,
                snippet(observations_fts, 1, '«', '»', '…', 12) AS snippet,
                rank
           FROM observations_fts
           JOIN observations o ON o.id = observations_fts.rowid
           JOIN sessions s ON s.id = o.session_id
           JOIN modules m  ON m.id = s.module_id
           ${where}
          ORDER BY rank
          LIMIT ?`,
      ).all(...params) as Array<{
        rowid: number;
        title: string;
        kind: string;
        story_local_id: string | null;
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
          meta: { kind: r.kind, storyLocalId: r.story_local_id },
        });
      }
    }

    if (wantSkills) {
      const params: unknown[] = [ftsQuery];
      let where = 'WHERE skills_fts MATCH ?';
      if (opts.projectId) {
        where += ' AND sk.project_id = ?';
        params.push(opts.projectId);
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
}

/**
 * FTS5 has reserved characters; the simplest sanitization is to wrap the
 * user query in double quotes and escape internal quotes. This treats the
 * input as a phrase. For advanced queries the caller can pass FTS5 syntax
 * directly by setting opts.raw (not implemented here for v0.2).
 */
function sanitizeFtsQuery(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '""';
  // Escape internal double quotes by doubling them (FTS5 convention).
  const escaped = trimmed.replace(/"/g, '""');
  return `"${escaped}"`;
}
