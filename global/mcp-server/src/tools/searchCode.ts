/**
 * MyJarbis MCP Tool: search_code
 *
 * Intelligent code search using ripgrep or grep.
 *
 * WHY THIS EXISTS:
 * - Reading entire codebases into context is expensive and slow
 * - This tool searches intelligently and returns SUMMARIZED results
 * - Saves tokens and provides faster, more relevant responses
 *
 * HOW IT WORKS:
 * 1. Takes a search query and optional file type filters
 * 2. Uses ripgrep (or falls back to grep) for fast searching
 * 3. Limits results to prevent context overflow
 * 4. Returns formatted, summarized results
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { ProjectsRegistry } from '../types.js';

const execAsync = promisify(exec);

/**
 * Parameters for the search_code tool
 */
export interface SearchCodeParams {
  /** Name of the project to search in */
  projectName: string;

  /** Search query (can be plain text or regex) */
  query: string;

  /** File extensions to search (e.g., ['ts', 'tsx', 'js']) */
  fileTypes?: string[];

  /** Case-insensitive search */
  caseInsensitive?: boolean;

  /** Maximum number of results to return */
  maxResults?: number;
}

/**
 * Result from code search
 */
export interface SearchResult {
  /** File path (relative to project root) */
  file: string;

  /** Line number where match was found */
  line: number;

  /** Matched line content */
  content: string;

  /** Surrounding context (2 lines before/after) */
  context?: string;
}

/**
 * Check if ripgrep is available on the system
 */
async function isRipgrepAvailable(): Promise<boolean> {
  try {
    await execAsync('which rg');
    return true;
  } catch {
    return false;
  }
}

/**
 * Build ripgrep command
 */
function buildRipgrepCommand(
  projectPath: string,
  query: string,
  fileTypes: string[] = [],
  caseInsensitive: boolean = false,
  maxResults: number = 50
): string {
  const flags: string[] = [
    '--line-number',         // Show line numbers
    '--no-heading',          // Don't group by file
    '--with-filename',       // Always show filename
    '--color=never',         // No color codes
    `--max-count=${maxResults}`, // Limit matches per file
  ];

  // Add case-insensitive flag
  if (caseInsensitive) {
    flags.push('--ignore-case');
  }

  // Add file type filters
  if (fileTypes.length > 0) {
    fileTypes.forEach(type => {
      flags.push(`--glob=*.${type}`);
    });
  }

  // Ignore common directories
  flags.push(
    '--glob=!node_modules/**',
    '--glob=!.git/**',
    '--glob=!vendor/**',
    '--glob=!build/**',
    '--glob=!dist/**',
    '--glob=!*.min.js',
    '--glob=!package-lock.json'
  );

  // Escape query for shell
  const escapedQuery = query.replace(/'/g, "'\\''");

  return `cd "${projectPath}" && rg ${flags.join(' ')} '${escapedQuery}'`;
}

/**
 * Build grep command (fallback if ripgrep not available)
 */
function buildGrepCommand(
  projectPath: string,
  query: string,
  fileTypes: string[] = [],
  caseInsensitive: boolean = false
): string {
  const flags: string[] = [
    '-n',  // Line numbers
    '-r',  // Recursive
  ];

  if (caseInsensitive) {
    flags.push('-i');
  }

  // Build file type include patterns
  let includePattern = '';
  if (fileTypes.length > 0) {
    const patterns = fileTypes.map(type => `--include=*.${type}`).join(' ');
    includePattern = patterns;
  }

  // Exclude common directories
  const excludes = [
    '--exclude-dir=node_modules',
    '--exclude-dir=.git',
    '--exclude-dir=vendor',
    '--exclude-dir=build',
    '--exclude-dir=dist',
  ].join(' ');

  // Escape query for shell
  const escapedQuery = query.replace(/'/g, "'\\''");

  return `cd "${projectPath}" && grep ${flags.join(' ')} ${excludes} ${includePattern} '${escapedQuery}' . 2>/dev/null | head -n 100`;
}

/**
 * Parse search output into structured results
 */
function parseSearchOutput(output: string, projectPath: string): SearchResult[] {
  const lines = output.trim().split('\n').filter(line => line.length > 0);
  const results: SearchResult[] = [];

  for (const line of lines) {
    // Format: filepath:linenumber:content
    const match = line.match(/^([^:]+):(\d+):(.+)$/);

    if (match) {
      const [, filePath, lineNum, content] = match;

      results.push({
        file: filePath.replace(projectPath + '/', ''), // Make path relative
        line: parseInt(lineNum, 10),
        content: content.trim(),
      });
    }
  }

  return results;
}

/**
 * Format search results for Claude
 */
function formatResults(results: SearchResult[], query: string, total: number): string {
  if (results.length === 0) {
    return `No results found for query: "${query}"`;
  }

  let output = `Found ${total} matches for "${query}"\n\n`;
  output += `Showing ${results.length} results:\n\n`;

  // Group by file
  const byFile = new Map<string, SearchResult[]>();
  for (const result of results) {
    if (!byFile.has(result.file)) {
      byFile.set(result.file, []);
    }
    byFile.get(result.file)!.push(result);
  }

  // Format each file's results
  for (const [file, fileResults] of byFile) {
    output += `━━━ ${file} (${fileResults.length} matches)\n`;

    for (const result of fileResults.slice(0, 5)) { // Max 5 matches per file
      output += `  Line ${result.line}: ${result.content}\n`;
    }

    if (fileResults.length > 5) {
      output += `  ... and ${fileResults.length - 5} more matches\n`;
    }

    output += '\n';
  }

  return output;
}

/**
 * Execute code search
 */
export async function searchCode(
  params: SearchCodeParams,
  registry: ProjectsRegistry
): Promise<string> {
  const { projectName, query, fileTypes = [], caseInsensitive = false, maxResults = 50 } = params;

  // Get project path
  const project = registry[projectName];
  if (!project) {
    return `Error: Project "${projectName}" not found. Available projects: ${Object.keys(registry).join(', ')}`;
  }

  const projectPath = project.path;

  try {
    // Check if ripgrep is available
    const useRipgrep = await isRipgrepAvailable();

    // Build command
    const command = useRipgrep
      ? buildRipgrepCommand(projectPath, query, fileTypes, caseInsensitive, maxResults)
      : buildGrepCommand(projectPath, query, fileTypes, caseInsensitive);

    console.error(`[searchCode] Using ${useRipgrep ? 'ripgrep' : 'grep'}: ${query}`);

    // Execute search
    const { stdout } = await execAsync(command, {
      maxBuffer: 1024 * 1024 * 5, // 5MB buffer
    });

    // Parse and format results
    const results = parseSearchOutput(stdout, projectPath);
    const formatted = formatResults(results.slice(0, maxResults), query, results.length);

    return formatted;
  } catch (error: any) {
    // If exit code is 1, it means no matches found (not an error)
    if (error.code === 1) {
      return `No results found for query: "${query}"`;
    }

    console.error('[searchCode] Error:', error);
    return `Error searching code: ${error.message}`;
  }
}
