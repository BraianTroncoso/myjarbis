#!/usr/bin/env node

/**
 * MyJarvis MCP Server
 *
 * This server implements the Model Context Protocol (MCP) to provide
 * persistent memory capabilities to Claude Code.
 *
 * Architecture:
 * - ONE server instance serves ALL projects
 * - Projects register themselves via `myjarvis init`
 * - Server reads from each project's .myjarvis/ folder
 * - Resources exposed as: myjarvis://project-name/memory/instructions
 *
 * Protocol: MCP over stdio (standard input/output)
 * Communication: Claude Code <-> This Server <-> Project Files
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import {
  ProjectConfig,
  ProjectsRegistry,
  RegistryFile,
  ResourceDefinition,
  MemoryPaths,
  MyJarvisError,
  ErrorType,
} from './types.js';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Path to the global projects registry
 * Location: ~/.myjarvis-global/projects-registry.json
 */
const REGISTRY_PATH = path.join(homedir(), '.myjarvis-global', 'projects-registry.json');

/**
 * Load the projects registry from disk
 *
 * Returns an empty registry if file doesn't exist yet (first run)
 */
function loadProjectsRegistry(): ProjectsRegistry {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) {
      console.error('[MyJarvis] Registry not found, returning empty registry');
      return {};
    }

    const content = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    const registryFile: RegistryFile = JSON.parse(content);

    console.error(`[MyJarvis] Loaded ${Object.keys(registryFile.projects).length} projects from registry`);
    return registryFile.projects;
  } catch (error) {
    console.error('[MyJarvis] Error loading registry:', error);
    return {};
  }
}

/**
 * Get the absolute path to a project's .myjarvis/ folder
 *
 * @param projectName - Name of the project
 * @returns Absolute path to .myjarvis/ folder
 * @throws MyJarvisError if project not found
 */
function getProjectPath(projectName: string, registry: ProjectsRegistry): string {
  const project = registry[projectName];

  if (!project) {
    throw new MyJarvisError(
      ErrorType.PROJECT_NOT_FOUND,
      `Project "${projectName}" not found in registry. Did you run 'myjarvis init'?`,
      { projectName, availableProjects: Object.keys(registry) }
    );
  }

  return path.join(project.path, '.myjarvis');
}

/**
 * Get all memory file paths for a project
 *
 * @param projectName - Name of the project
 * @returns Object with paths to all memory files
 */
function getMemoryPaths(projectName: string, registry: ProjectsRegistry): MemoryPaths {
  const myjarvisPath = getProjectPath(projectName, registry);

  return {
    instructions: path.join(myjarvisPath, 'prompts', 'system.md'),
    projectSummary: path.join(myjarvisPath, 'context', 'project-summary.md'),
    knowledgeBase: path.join(myjarvisPath, 'context', 'knowledge-base.md'),
    daily: path.join(myjarvisPath, 'context', 'daily.md'),
    codebase: path.join(myjarvisPath, 'context', 'codebase.txt'),
  };
}

/**
 * Read a file safely with error handling
 *
 * @param filePath - Absolute path to file
 * @returns File contents or error message
 */
function readProjectFile(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) {
      return `[File not found: ${path.basename(filePath)}]\n\nThis file hasn't been created yet. It will be generated during project initialization or usage.`;
    }

    const content = fs.readFileSync(filePath, 'utf-8');

    // Return helpful message if file is empty
    if (!content.trim()) {
      return `[Empty file: ${path.basename(filePath)}]\n\nThis file exists but has no content yet.`;
    }

    return content;
  } catch (error) {
    throw new MyJarvisError(
      ErrorType.FILE_READ_ERROR,
      `Failed to read file: ${filePath}`,
      { error: error instanceof Error ? error.message : String(error) }
    );
  }
}

/**
 * Parse a MyJarvis resource URI
 *
 * Format: myjarvis://project-name/memory/instructions
 *         myjarvis://project-name/memory/project
 *         myjarvis://project-name/memory/knowledge
 *         myjarvis://project-name/context/daily
 *
 * @param uri - Resource URI to parse
 * @returns { projectName, resourceType, resourceName }
 */
function parseResourceURI(uri: string): { projectName: string; category: string; resourceName: string } {
  const match = uri.match(/^myjarvis:\/\/([^\/]+)\/([^\/]+)\/([^\/]+)$/);

  if (!match) {
    throw new MyJarvisError(
      ErrorType.INVALID_URI,
      `Invalid MyJarvis URI format: ${uri}`,
      { expectedFormat: 'myjarvis://project-name/category/resource-name' }
    );
  }

  const [, projectName, category, resourceName] = match;
  return { projectName, category, resourceName };
}

/**
 * Generate resource definitions for a project
 *
 * @param projectName - Name of the project
 * @returns Array of resource definitions
 */
function generateResourcesForProject(projectName: string): ResourceDefinition[] {
  return [
    {
      uri: `myjarvis://${projectName}/memory/instructions`,
      name: `${projectName} - System Instructions`,
      description: 'Claude\'s behavior rules, workflow guidelines, and educational mode settings',
      mimeType: 'text/markdown',
    },
    {
      uri: `myjarvis://${projectName}/memory/project`,
      name: `${projectName} - Project Summary`,
      description: 'High-level project overview, architecture, tech stack, and structure',
      mimeType: 'text/markdown',
    },
    {
      uri: `myjarvis://${projectName}/memory/knowledge`,
      name: `${projectName} - Knowledge Base`,
      description: 'Chronological log of everything built, decisions made, and lessons learned',
      mimeType: 'text/markdown',
    },
    {
      uri: `myjarvis://${projectName}/context/daily`,
      name: `${projectName} - Daily Context`,
      description: 'Today\'s focus, recent changes, and current work-in-progress',
      mimeType: 'text/markdown',
    },
  ];
}

/**
 * Main server setup
 */
async function main() {
  console.error('[MyJarvis] Starting MCP Server...');

  // Load projects registry
  const registry = loadProjectsRegistry();

  // Create MCP server instance
  const server = new Server(
    {
      name: 'myjarvis-mcp-server',
      version: '0.1.0',
    },
    {
      capabilities: {
        resources: {},
        tools: {},
      },
    }
  );

  /**
   * Handler: List all available resources
   *
   * Returns resources for ALL registered projects
   */
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    console.error('[MyJarvis] Listing resources...');

    const allResources: ResourceDefinition[] = [];

    // Generate resources for each registered project
    for (const projectName of Object.keys(registry)) {
      const projectResources = generateResourcesForProject(projectName);
      allResources.push(...projectResources);
    }

    console.error(`[MyJarvis] Returning ${allResources.length} resources from ${Object.keys(registry).length} projects`);

    return {
      resources: allResources,
    };
  });

  /**
   * Handler: Read a specific resource
   *
   * Parses the URI, locates the file, and returns its contents
   */
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    console.error(`[MyJarvis] Reading resource: ${uri}`);

    try {
      // Parse URI to extract project and resource info
      const { projectName, category, resourceName } = parseResourceURI(uri);

      // Get memory file paths for this project
      const memoryPaths = getMemoryPaths(projectName, registry);

      // Map resource name to file path
      let filePath: string;

      if (category === 'memory') {
        switch (resourceName) {
          case 'instructions':
            filePath = memoryPaths.instructions;
            break;
          case 'project':
            filePath = memoryPaths.projectSummary;
            break;
          case 'knowledge':
            filePath = memoryPaths.knowledgeBase;
            break;
          default:
            throw new MyJarvisError(
              ErrorType.RESOURCE_NOT_FOUND,
              `Unknown memory resource: ${resourceName}`,
              { validResources: ['instructions', 'project', 'knowledge'] }
            );
        }
      } else if (category === 'context') {
        switch (resourceName) {
          case 'daily':
            filePath = memoryPaths.daily;
            break;
          default:
            throw new MyJarvisError(
              ErrorType.RESOURCE_NOT_FOUND,
              `Unknown context resource: ${resourceName}`,
              { validResources: ['daily'] }
            );
        }
      } else {
        throw new MyJarvisError(
          ErrorType.INVALID_URI,
          `Unknown category: ${category}`,
          { validCategories: ['memory', 'context'] }
        );
      }

      // Read the file
      const content = readProjectFile(filePath);

      console.error(`[MyJarvis] Successfully read: ${path.basename(filePath)} (${content.length} bytes)`);

      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: content,
          },
        ],
      };
    } catch (error) {
      if (error instanceof MyJarvisError) {
        console.error(`[MyJarvis] Error: ${error.message}`, error.details);
        throw error;
      }

      console.error('[MyJarvis] Unexpected error:', error);
      throw new MyJarvisError(
        ErrorType.FILE_READ_ERROR,
        'Unexpected error reading resource',
        { error: String(error) }
      );
    }
  });

  /**
   * Handler: List available tools
   *
   * Tools are functions that Claude can call (we'll implement in Phase 3)
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error('[MyJarvis] Listing tools...');

    // Phase 3: We'll add tools like search_code, get_context, update_memory
    return {
      tools: [],
    };
  });

  /**
   * Handler: Execute a tool
   *
   * (Will be implemented in Phase 3)
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    console.error(`[MyJarvis] Tool called: ${request.params.name}`);

    throw new MyJarvisError(
      ErrorType.RESOURCE_NOT_FOUND,
      'Tools not yet implemented (Phase 3)',
      { requestedTool: request.params.name }
    );
  });

  // Start the server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[MyJarvis] MCP Server running and ready for connections');
}

// Run the server
main().catch((error) => {
  console.error('[MyJarvis] Fatal error:', error);
  process.exit(1);
});
