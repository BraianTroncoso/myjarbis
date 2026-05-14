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
 * Stored in: ~/.myjarbis-global/projects-registry.json
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
