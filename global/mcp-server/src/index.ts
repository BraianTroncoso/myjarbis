#!/usr/bin/env node

/**
 * MyJarbis MCP Server
 *
 * This server implements the Model Context Protocol (MCP) to provide
 * persistent memory capabilities to Claude Code.
 *
 * Architecture:
 * - ONE server instance serves ALL projects
 * - Projects register themselves via `myjarbis init`
 * - Server reads from each project's .myjarbis/ folder
 * - Resources exposed as: myjarbis://project-name/memory/instructions
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
  MyJarbisError,
  ErrorType,
} from './types.js';
import { searchCode, SearchCodeParams } from './tools/searchCode.js';
import { getContext, GetContextParams } from './tools/getContext.js';
import { updateMemory, UpdateMemoryParams } from './tools/updateMemory.js';

// Get __dirname equivalent in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Path to the global projects registry
 * Location: ~/.myjarbis-global/projects-registry.json
 */
const REGISTRY_PATH = path.join(homedir(), '.myjarbis-global', 'projects-registry.json');

/**
 * Load the projects registry from disk
 *
 * Returns an empty registry if file doesn't exist yet (first run)
 */
function loadProjectsRegistry(): ProjectsRegistry {
  try {
    if (!fs.existsSync(REGISTRY_PATH)) {
      console.error('[MyJarbis] Registry not found, returning empty registry');
      return {};
    }

    const content = fs.readFileSync(REGISTRY_PATH, 'utf-8');
    const registryFile: RegistryFile = JSON.parse(content);

    console.error(`[MyJarbis] Loaded ${Object.keys(registryFile.projects).length} projects from registry`);
    return registryFile.projects;
  } catch (error) {
    console.error('[MyJarbis] Error loading registry:', error);
    return {};
  }
}

/**
 * Get the absolute path to a project's .myjarbis/ folder
 *
 * @param projectName - Name of the project
 * @returns Absolute path to .myjarbis/ folder
 * @throws MyJarbisError if project not found
 */
function getProjectPath(projectName: string, registry: ProjectsRegistry): string {
  const project = registry[projectName];

  if (!project) {
    throw new MyJarbisError(
      ErrorType.PROJECT_NOT_FOUND,
      `Project "${projectName}" not found in registry. Did you run 'myjarbis init'?`,
      { projectName, availableProjects: Object.keys(registry) }
    );
  }

  return path.join(project.path, '.myjarbis');
}

/**
 * Get all memory file paths for a project
 *
 * @param projectName - Name of the project
 * @returns Object with paths to all memory files
 */
function getMemoryPaths(projectName: string, registry: ProjectsRegistry): MemoryPaths {
  const myjarbisPath = getProjectPath(projectName, registry);

  return {
    instructions: path.join(myjarbisPath, 'prompts', 'system.md'),
    projectSummary: path.join(myjarbisPath, 'context', 'project-summary.md'),
    knowledgeBase: path.join(myjarbisPath, 'context', 'knowledge-base.md'),
    daily: path.join(myjarbisPath, 'context', 'daily.md'),
    codebase: path.join(myjarbisPath, 'context', 'codebase.txt'),
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
    throw new MyJarbisError(
      ErrorType.FILE_READ_ERROR,
      `Failed to read file: ${filePath}`,
      { error: error instanceof Error ? error.message : String(error) }
    );
  }
}

/**
 * Parse a MyJarbis resource URI
 *
 * Format: myjarbis://project-name/memory/instructions
 *         myjarbis://project-name/memory/project
 *         myjarbis://project-name/memory/knowledge
 *         myjarbis://project-name/context/daily
 *
 * @param uri - Resource URI to parse
 * @returns { projectName, resourceType, resourceName }
 */
function parseResourceURI(uri: string): { projectName: string; category: string; resourceName: string } {
  const match = uri.match(/^myjarbis:\/\/([^\/]+)\/([^\/]+)\/([^\/]+)$/);

  if (!match) {
    throw new MyJarbisError(
      ErrorType.INVALID_URI,
      `Invalid MyJarbis URI format: ${uri}`,
      { expectedFormat: 'myjarbis://project-name/category/resource-name' }
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
      uri: `myjarbis://${projectName}/memory/instructions`,
      name: `${projectName} - System Instructions`,
      description: 'Claude\'s behavior rules, workflow guidelines, and educational mode settings',
      mimeType: 'text/markdown',
    },
    {
      uri: `myjarbis://${projectName}/memory/project`,
      name: `${projectName} - Project Summary`,
      description: 'High-level project overview, architecture, tech stack, and structure',
      mimeType: 'text/markdown',
    },
    {
      uri: `myjarbis://${projectName}/memory/knowledge`,
      name: `${projectName} - Knowledge Base`,
      description: 'Chronological log of everything built, decisions made, and lessons learned',
      mimeType: 'text/markdown',
    },
    {
      uri: `myjarbis://${projectName}/context/daily`,
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
  console.error('[MyJarbis] Starting MCP Server...');

  // Load projects registry
  const registry = loadProjectsRegistry();

  // Create MCP server instance
  const server = new Server(
    {
      name: 'myjarbis-mcp-server',
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
    console.error('[MyJarbis] Listing resources...');

    const allResources: ResourceDefinition[] = [];

    // Generate resources for each registered project
    for (const projectName of Object.keys(registry)) {
      const projectResources = generateResourcesForProject(projectName);
      allResources.push(...projectResources);
    }

    console.error(`[MyJarbis] Returning ${allResources.length} resources from ${Object.keys(registry).length} projects`);

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
    console.error(`[MyJarbis] Reading resource: ${uri}`);

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
            throw new MyJarbisError(
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
            throw new MyJarbisError(
              ErrorType.RESOURCE_NOT_FOUND,
              `Unknown context resource: ${resourceName}`,
              { validResources: ['daily'] }
            );
        }
      } else {
        throw new MyJarbisError(
          ErrorType.INVALID_URI,
          `Unknown category: ${category}`,
          { validCategories: ['memory', 'context'] }
        );
      }

      // Read the file
      const content = readProjectFile(filePath);

      console.error(`[MyJarbis] Successfully read: ${path.basename(filePath)} (${content.length} bytes)`);

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
      if (error instanceof MyJarbisError) {
        console.error(`[MyJarbis] Error: ${error.message}`, error.details);
        throw error;
      }

      console.error('[MyJarbis] Unexpected error:', error);
      throw new MyJarbisError(
        ErrorType.FILE_READ_ERROR,
        'Unexpected error reading resource',
        { error: String(error) }
      );
    }
  });

  /**
   * Handler: List available tools
   *
   * Tools are functions that Claude can call
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error('[MyJarbis] Listing tools...');

    return {
      tools: [
        {
          name: 'search_code',
          description: 'Search the codebase intelligently and return summarized results. Use this when you need to find specific code patterns, functions, or implementations without reading entire files.',
          inputSchema: {
            type: 'object',
            properties: {
              projectName: {
                type: 'string',
                description: 'Name of the project to search in',
              },
              query: {
                type: 'string',
                description: 'Search query (e.g., "User model", "authentication logic", "handlePayment")',
              },
              fileTypes: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter by file extensions (e.g., ["ts", "tsx", "js"])',
              },
              caseInsensitive: {
                type: 'boolean',
                description: 'Case-insensitive search (default: false)',
              },
              maxResults: {
                type: 'number',
                description: 'Maximum number of results to return (default: 50)',
              },
            },
            required: ['projectName', 'query'],
          },
        },
        {
          name: 'get_context',
          description: 'Get curated context about a specific topic from the codebase. Returns ~2-3KB of relevant information instead of full files. Use this when you need to understand a feature or component.',
          inputSchema: {
            type: 'object',
            properties: {
              projectName: {
                type: 'string',
                description: 'Name of the project',
              },
              topic: {
                type: 'string',
                description: 'Topic to get context about (e.g., "User authentication", "payment processing", "User model")',
              },
              maxSize: {
                type: 'number',
                description: 'Maximum size of context in bytes (default: 3072 = 3KB)',
              },
            },
            required: ['projectName', 'topic'],
          },
        },
        {
          name: 'update_memory',
          description: 'Update the project\'s knowledge base with information about what was implemented. Use this after completing a feature or phase to maintain project memory.',
          inputSchema: {
            type: 'object',
            properties: {
              projectName: {
                type: 'string',
                description: 'Name of the project',
              },
              title: {
                type: 'string',
                description: 'Title of what was implemented (e.g., "User Authentication System")',
              },
              what: {
                type: 'string',
                description: 'What was built (brief description)',
              },
              why: {
                type: 'string',
                description: 'Why it was built this way (rationale)',
              },
              how: {
                type: 'string',
                description: 'How it was implemented (technical details, can be multi-line)',
              },
              files: {
                type: 'array',
                items: { type: 'string' },
                description: 'List of files created or modified',
              },
              notes: {
                type: 'string',
                description: 'Additional notes or lessons learned',
              },
            },
            required: ['projectName', 'title', 'what', 'why', 'how'],
          },
        },
      ],
    };
  });

  /**
   * Handler: Execute a tool
   *
   * Routes tool calls to the appropriate implementation
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.error(`[MyJarbis] Tool called: ${name}`);

    try {
      switch (name) {
        case 'search_code': {
          const params = args as unknown as SearchCodeParams;
          const result = await searchCode(params, registry);
          return {
            content: [
              {
                type: 'text',
                text: result,
              },
            ],
          };
        }

        case 'get_context': {
          const params = args as unknown as GetContextParams;
          const result = await getContext(params, registry);
          return {
            content: [
              {
                type: 'text',
                text: result,
              },
            ],
          };
        }

        case 'update_memory': {
          const params = args as unknown as UpdateMemoryParams;
          const result = await updateMemory(params, registry);
          return {
            content: [
              {
                type: 'text',
                text: result,
              },
            ],
          };
        }

        default:
          throw new MyJarbisError(
            ErrorType.RESOURCE_NOT_FOUND,
            `Unknown tool: ${name}`,
            { requestedTool: name, availableTools: ['search_code', 'get_context', 'update_memory'] }
          );
      }
    } catch (error) {
      if (error instanceof MyJarbisError) {
        console.error(`[MyJarbis] Tool error: ${error.message}`, error.details);
        throw error;
      }

      console.error('[MyJarbis] Unexpected tool error:', error);
      throw new MyJarbisError(
        ErrorType.FILE_READ_ERROR,
        `Error executing tool ${name}: ${error instanceof Error ? error.message : String(error)}`,
        { tool: name, error: String(error) }
      );
    }
  });

  // Start the server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[MyJarbis] MCP Server running and ready for connections');
}

// Run the server
main().catch((error) => {
  console.error('[MyJarbis] Fatal error:', error);
  process.exit(1);
});
