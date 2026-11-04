/**
 * MyJarbis MCP Server - Type Definitions
 *
 * This file defines all TypeScript types used throughout the MCP server.
 */

/**
 * Configuration for a single project registered with MyJarbis
 *
 * Each project that runs `myjarbis init` gets registered here,
 * allowing the MCP server to locate its .myjarbis/ folder.
 */
export interface ProjectConfig {
  /** Unique project name (used in resource URIs) */
  name: string;

  /** Absolute path to the project root directory */
  path: string;

  /** Detected framework (helps with smart analysis) */
  framework?: 'laravel' | 'express' | 'nextjs' | 'react' | 'vue' | 'generic';

  /** ISO timestamp of when project was initialized */
  initialized: string;

  /** ISO timestamp of last activity (for cleanup/stats) */
  lastAccessed?: string;
}

/**
 * Registry of all projects initialized with MyJarbis
 *
 * Stored in: ~/.myjarbis/projects-registry.json (an installation that has not
 * been updated yet still has it under ~/.myjarbis-global/)
 *
 * Structure:
 * {
 *   "my-laravel-app": { name: "my-laravel-app", path: "/home/user/projects/app", ... },
 *   "website-redesign": { name: "website-redesign", path: "/home/user/work/site", ... }
 * }
 */
export interface ProjectsRegistry {
  /** Project name -> Project configuration */
  [projectName: string]: ProjectConfig;
}

/**
 * MCP Resource definition
 *
 * Resources are files that Claude can read via the MCP protocol.
 * Each resource has a unique URI like: myjarbis://project-name/memory/instructions
 */
export interface ResourceDefinition {
  /** Unique URI for this resource */
  uri: string;

  /** Human-readable name */
  name: string;

  /** Description of what this resource contains */
  description: string;

  /** MIME type (usually text/markdown or text/plain) */
  mimeType: string;
}

/**
 * Registry file metadata
 *
 * Wraps the projects registry with metadata for versioning and validation
 */
export interface RegistryFile {
  /** Format version (for future migrations) */
  _version: string;

  /** Human-readable comment */
  _comment: string;

  /** Last update timestamp */
  _lastUpdated?: string;

  /** The actual projects data */
  projects: ProjectsRegistry;
}

/**
 * Memory file paths within a project's .myjarbis/ folder
 *
 * These are the standard files that MyJarbis manages.
 */
export interface MemoryPaths {
  /** .myjarbis/prompts/system.md - Claude's instructions */
  instructions: string;

  /** .myjarbis/context/project-summary.md - Project overview */
  projectSummary: string;

  /** .myjarbis/context/knowledge-base.md - Implementation log */
  knowledgeBase: string;

  /** .myjarbis/context/daily.md - Today's context */
  daily: string;

  /** .myjarbis/context/codebase.txt - Generated code dump */
  codebase?: string;
}

/**
 * Error types for better error handling
 */
export enum ErrorType {
  PROJECT_NOT_FOUND = 'PROJECT_NOT_FOUND',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  FILE_READ_ERROR = 'FILE_READ_ERROR',
  INVALID_URI = 'INVALID_URI',
  REGISTRY_ERROR = 'REGISTRY_ERROR',
  // v0.2 additions
  MODULE_NOT_FOUND = 'MODULE_NOT_FOUND',
  SESSION_NOT_ACTIVE = 'SESSION_NOT_ACTIVE',
  INVALID_INPUT = 'INVALID_INPUT',
  DB_ERROR = 'DB_ERROR',
  // v0.3 additions
  /** A read or write was attempted before a scope was bound. With a shared
   *  DB this is the boundary between tenants, so it fails instead of
   *  defaulting to "everything". */
  SCOPE_NOT_RESOLVED = 'SCOPE_NOT_RESOLVED',
  /** A row was requested that exists but belongs to another project. */
  OUT_OF_SCOPE = 'OUT_OF_SCOPE',
  /** The working directory maps to more than one registered project. */
  AMBIGUOUS_PROJECT = 'AMBIGUOUS_PROJECT',
  ORG_NOT_FOUND = 'ORG_NOT_FOUND',
  PACK_ERROR = 'PACK_ERROR',
  /** A providers.config payload carried something that looks like a secret. */
  SECRET_IN_CONFIG = 'SECRET_IN_CONFIG',
  INVALID_CONTEXT_KIND = 'INVALID_CONTEXT_KIND',
  STATE_LOCKED = 'STATE_LOCKED',
  WORKFLOW_NOT_FOUND = 'WORKFLOW_NOT_FOUND',
  // v0.5 additions
  /** A promotion to the org memory carried something that must not leave
   *  this machine: a credential, a local path, an internal host, or a real
   *  project name. Blocking, with the offending line and a rewrite. */
  ORG_NOTE_UNSAFE = 'ORG_NOTE_UNSAFE',
  /** The project belongs to no org, so there is no org memory to read or
   *  write. Separate from ORG_NOT_FOUND, which is a named org that does not
   *  exist: this one is "you have not joined one". */
  NO_ORG = 'NO_ORG',
  /** The feature needs a newer schema than this brain has. Distinct from
   *  DB_ERROR because the remedy is one specific command, `myjarbis migrate`,
   *  and because the alternative — letting SQLite answer — produces "table
   *  workflows has no column named standalone", which names a column when
   *  what the reader needs is the fix. */
  SCHEMA_TOO_OLD = 'SCHEMA_TOO_OLD',
}

/**
 * Custom error class for MyJarbis MCP operations
 */
export class MyJarbisError extends Error {
  constructor(
    public type: ErrorType,
    message: string,
    public details?: any
  ) {
    super(message);
    this.name = 'MyJarbisError';
  }
}
