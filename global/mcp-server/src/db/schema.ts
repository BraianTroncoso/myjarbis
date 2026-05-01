/**
 * MyJarbis v0.2 — SQLite + FTS5 schema
 *
 * Hierarchy:
 *   project
 *     └── project_context     (core: practices, deps, conventions, specs)
 *     └── modules             (verticales creadas explícitamente)
 *           └── module_context (workflow, plan, stories, AC del módulo)
 *           └── sessions       (sesión de trabajo en un módulo)
 *                 └── observations (decisions, gotchas, progress)
 *     └── skills              (project-level si module_id IS NULL,
 *                              module-level si module_id apunta a uno)
 *
 * FTS5 contentless indexes mirror the searchable columns of:
 *   project_context, module_context, skills, observations
 * Triggers keep the FTS5 tables in sync on INSERT/UPDATE/DELETE.
 *
 * `content_hash` (SHA-256) on context/skills rows enables idempotent
 * re-import: same path + same content = no-op; same path + new content
 * = UPDATE.
 *
 * Schema versioning lives in the `meta` table to support future
 * migrations without code-detection of structure.
 */

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
-- ─────────────────────────────────────────────────────────────────
-- Pragmas
-- ─────────────────────────────────────────────────────────────────
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

-- ─────────────────────────────────────────────────────────────────
-- Meta (schema version + arbitrary key/value metadata)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ─────────────────────────────────────────────────────────────────
-- Projects
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  path       TEXT    NOT NULL UNIQUE,
  framework  TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─────────────────────────────────────────────────────────────────
-- Project context (core: practices, deps, conventions, specs)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS project_context (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  content      TEXT    NOT NULL,
  tags         TEXT,
  source_path  TEXT,
  content_hash TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, source_path, kind)
);
CREATE INDEX IF NOT EXISTS idx_project_context_project ON project_context(project_id);
CREATE INDEX IF NOT EXISTS idx_project_context_kind    ON project_context(kind);

-- ─────────────────────────────────────────────────────────────────
-- Modules (verticales creadas explícitamente por el user)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS modules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL,
  description TEXT,
  status      TEXT    NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'paused', 'done')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS idx_modules_project ON modules(project_id);

-- ─────────────────────────────────────────────────────────────────
-- Module context (workflow, plan, stories, AC, use cases)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS module_context (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id    INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  kind         TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  content      TEXT    NOT NULL,
  tags         TEXT,
  source_path  TEXT,
  content_hash TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(module_id, source_path, kind, title)
);
CREATE INDEX IF NOT EXISTS idx_module_context_module ON module_context(module_id);
CREATE INDEX IF NOT EXISTS idx_module_context_kind   ON module_context(kind);

-- ─────────────────────────────────────────────────────────────────
-- Skills (project-level si module_id NULL, module-level si NOT NULL)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS skills (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  module_id       INTEGER REFERENCES modules(id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  description     TEXT,
  trigger_pattern TEXT,
  content         TEXT    NOT NULL,
  content_hash    TEXT    NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, module_id, name)
);
CREATE INDEX IF NOT EXISTS idx_skills_project ON skills(project_id);
CREATE INDEX IF NOT EXISTS idx_skills_module  ON skills(module_id);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);

-- ─────────────────────────────────────────────────────────────────
-- Sessions (siempre dentro de un módulo)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  module_id    INTEGER NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  started_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  ended_at     TEXT,
  summary      TEXT,
  next_session TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_module     ON sessions(module_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);

-- ─────────────────────────────────────────────────────────────────
-- Observations (decisions, gotchas, progress, ...)
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS observations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind           TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  content        TEXT    NOT NULL,
  story_local_id TEXT,
  files          TEXT,
  tags           TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_observations_kind    ON observations(kind);
CREATE INDEX IF NOT EXISTS idx_observations_story   ON observations(story_local_id);

-- ─────────────────────────────────────────────────────────────────
-- FTS5 virtual tables (contentless, mirror searchable columns)
-- ─────────────────────────────────────────────────────────────────
CREATE VIRTUAL TABLE IF NOT EXISTS project_context_fts USING fts5(
  title, content, tags,
  content='project_context',
  content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS module_context_fts USING fts5(
  title, content, tags,
  content='module_context',
  content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
  name, description, content,
  content='skills',
  content_rowid='id'
);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, content, tags, story_local_id,
  content='observations',
  content_rowid='id'
);

-- ─────────────────────────────────────────────────────────────────
-- Triggers: keep FTS5 tables in sync with main tables
-- ─────────────────────────────────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS project_context_ai AFTER INSERT ON project_context BEGIN
  INSERT INTO project_context_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS project_context_ad AFTER DELETE ON project_context BEGIN
  INSERT INTO project_context_fts(project_context_fts, rowid, title, content, tags)
  VALUES('delete', old.id, old.title, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS project_context_au AFTER UPDATE ON project_context BEGIN
  INSERT INTO project_context_fts(project_context_fts, rowid, title, content, tags)
  VALUES('delete', old.id, old.title, old.content, old.tags);
  INSERT INTO project_context_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS module_context_ai AFTER INSERT ON module_context BEGIN
  INSERT INTO module_context_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS module_context_ad AFTER DELETE ON module_context BEGIN
  INSERT INTO module_context_fts(module_context_fts, rowid, title, content, tags)
  VALUES('delete', old.id, old.title, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS module_context_au AFTER UPDATE ON module_context BEGIN
  INSERT INTO module_context_fts(module_context_fts, rowid, title, content, tags)
  VALUES('delete', old.id, old.title, old.content, old.tags);
  INSERT INTO module_context_fts(rowid, title, content, tags)
  VALUES (new.id, new.title, new.content, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
  INSERT INTO skills_fts(rowid, name, description, content)
  VALUES (new.id, new.name, new.description, new.content);
END;
CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, content)
  VALUES('delete', old.id, old.name, old.description, old.content);
END;
CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, content)
  VALUES('delete', old.id, old.name, old.description, old.content);
  INSERT INTO skills_fts(rowid, name, description, content)
  VALUES (new.id, new.name, new.description, new.content);
END;

CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, content, tags, story_local_id)
  VALUES (new.id, new.title, new.content, new.tags, new.story_local_id);
END;
CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content, tags, story_local_id)
  VALUES('delete', old.id, old.title, old.content, old.tags, old.story_local_id);
END;
CREATE TRIGGER IF NOT EXISTS observations_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, content, tags, story_local_id)
  VALUES('delete', old.id, old.title, old.content, old.tags, old.story_local_id);
  INSERT INTO observations_fts(rowid, title, content, tags, story_local_id)
  VALUES (new.id, new.title, new.content, new.tags, new.story_local_id);
END;

-- updated_at is touched explicitly by the application layer in the
-- corresponding UPSERT statements (db/index.ts). We avoid AFTER UPDATE
-- "touch" triggers here because they cascade with the FTS5 sync triggers
-- and can corrupt the contentless FTS5 index (SQLITE_CORRUPT_VTAB) when
-- the same row receives two UPDATEs in the same statement.
`;

// ───────────────────────────────────────────────────────────────────
// TypeScript row types (1:1 with table columns)
// ───────────────────────────────────────────────────────────────────

export interface ProjectRow {
  id: number;
  name: string;
  path: string;
  framework: string | null;
  created_at: string;
}

export type ContextKind =
  | 'practice'
  | 'dependency'
  | 'convention'
  | 'functional_spec'
  | 'jira_rules'
  | 'error_log'
  | 'design_guideline'
  | 'workflow'
  | 'plan'
  | 'functional_doc'
  | 'use_cases'
  | 'acceptance_criteria'
  | 'story'
  | 'other';

export interface ProjectContextRow {
  id: number;
  project_id: number;
  kind: ContextKind;
  title: string;
  content: string;
  tags: string | null;
  source_path: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

export type ModuleStatus = 'active' | 'paused' | 'done';

export interface ModuleRow {
  id: number;
  project_id: number;
  name: string;
  description: string | null;
  status: ModuleStatus;
  created_at: string;
}

export interface ModuleContextRow {
  id: number;
  module_id: number;
  kind: ContextKind;
  title: string;
  content: string;
  tags: string | null;
  source_path: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
}

export interface SkillRow {
  id: number;
  project_id: number;
  module_id: number | null;
  name: string;
  description: string | null;
  trigger_pattern: string | null;
  content: string;
  content_hash: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface SessionRow {
  id: number;
  module_id: number;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  next_session: string | null;
}

export type ObservationKind =
  | 'decision'
  | 'gotcha'
  | 'progress'
  | 'error'
  | 'discovery';

export interface ObservationRow {
  id: number;
  session_id: number;
  kind: ObservationKind;
  title: string;
  content: string;
  story_local_id: string | null;
  files: string | null;
  tags: string | null;
  created_at: string;
}

export interface MetaRow {
  key: string;
  value: string;
}
