/**
 * MyJarbis MCP Tool: get_context
 *
 * Get curated context about a specific topic from the codebase.
 *
 * WHY THIS EXISTS:
 * - Reading all related files is expensive (tokens + time)
 * - This tool intelligently finds and summarizes relevant information
 * - Returns ~2-3KB of curated context instead of full files
 *
 * HOW IT WORKS:
 * 1. Takes a topic query (e.g., "User authentication", "payment processing")
 * 2. Searches for relevant files and code
 * 3. Extracts key information (class definitions, important functions)
 * 4. Summarizes and returns curated context
 *
 * EXAMPLE USE CASES:
 * - "Tell me about the User model" → Returns model definition + key methods
 * - "How does authentication work?" → Returns auth-related code summary
 * - "Database schema for orders" → Returns migration/model info
 */

import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ProjectsRegistry } from '../types.js';

const execAsync = promisify(exec);

/**
 * Parameters for the get_context tool
 */
export interface GetContextParams {
  /** Name of the project */
  projectName: string;

  /** Topic to get context about (e.g., "User model", "authentication") */
  topic: string;

  /** Maximum size of context to return (in bytes, default 3KB) */
  maxSize?: number;
}

/**
 * Context item found
 */
interface ContextItem {
  /** File path */
  file: string;

  /** Relevance score (higher = more relevant) */
  score: number;

  /** Extracted content */
  content: string;

  /** Type of content (class, function, config, etc.) */
  type: string;
}

/**
 * Search for files related to the topic
 */
async function findRelevantFiles(
  projectPath: string,
  topic: string
): Promise<string[]> {
  // Convert topic to search terms
  // Example: "User authentication" → ["User", "authentication", "Auth"]
  const terms = topic.split(/\s+/).filter(t => t.length > 2);

  const relevantFiles: Set<string> = new Set();

  try {
    // Try ripgrep first (faster)
    const hasRg = await execAsync('which rg').then(() => true).catch(() => false);

    for (const term of terms) {
      const cmd = hasRg
        ? `cd "${projectPath}" && rg -l --ignore-case "${term}" --glob=!node_modules --glob=!.git --glob=!vendor --glob=!build --glob=!dist 2>/dev/null || true`
        : `cd "${projectPath}" && grep -rl --ignore-case "${term}" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=vendor . 2>/dev/null | head -n 20 || true`;

      const { stdout } = await execAsync(cmd);

      stdout.trim().split('\n').forEach(file => {
        if (file) {
          relevantFiles.add(file.replace(projectPath + '/', ''));
        }
      });
    }

    return Array.from(relevantFiles).slice(0, 10); // Limit to 10 most relevant files
  } catch (error) {
    console.error('[getContext] Error finding files:', error);
    return [];
  }
}

/**
 * Score file relevance based on filename and topic
 */
function scoreRelevance(filePath: string, topic: string): number {
  const fileName = path.basename(filePath).toLowerCase();
  const topicLower = topic.toLowerCase();
  const topicTerms = topicLower.split(/\s+/);

  let score = 0;

  // Exact filename match
  if (fileName.includes(topicLower.replace(/\s+/g, ''))) {
    score += 10;
  }

  // Individual term matches in filename
  for (const term of topicTerms) {
    if (fileName.includes(term)) {
      score += 5;
    }
  }

  // Boost for important file types
  if (fileName.match(/\.(model|controller|service|repository)\./)) {
    score += 3;
  }

  // Boost for model files
  if (filePath.includes('/Models/') || filePath.includes('/models/')) {
    score += 2;
  }

  return score;
}

/**
 * Extract important content from a file
 */
function extractImportantContent(
  filePath: string,
  content: string,
  topic: string
): string {
  const lines = content.split('\n');
  const important: string[] = [];

  // Extract class definitions
  const classMatch = content.match(/class\s+(\w+)[\s\S]*?\{/);
  if (classMatch) {
    const startIdx = content.indexOf(classMatch[0]);
    const preview = content.substring(startIdx, startIdx + 500);
    important.push(`Class definition:\n${preview}...`);
  }

  // Extract function/method signatures
  const functions = content.matchAll(/(?:public|private|protected)?\s*function\s+(\w+)\s*\([^)]*\)/g);
  const funcList: string[] = [];
  for (const func of functions) {
    funcList.push(func[0]);
  }
  if (funcList.length > 0) {
    important.push(`\nMethods:\n${funcList.slice(0, 10).join('\n')}`);
  }

  // Extract properties/attributes
  const properties = content.matchAll(/(?:public|private|protected)\s+(?:static\s+)?\$(\w+)/g);
  const propList: string[] = [];
  for (const prop of properties) {
    propList.push(`$${prop[1]}`);
  }
  if (propList.length > 0) {
    important.push(`\nProperties: ${propList.slice(0, 15).join(', ')}`);
  }

  if (important.length > 0) {
    return important.join('\n');
  }

  // If no specific patterns found, return first 500 chars
  return content.substring(0, 500) + '...';
}

/**
 * Read and analyze a file for context
 */
function analyzeFile(
  projectPath: string,
  filePath: string,
  topic: string
): ContextItem | null {
  const fullPath = path.join(projectPath, filePath);

  try {
    // Skip large files (>100KB)
    const stats = fs.statSync(fullPath);
    if (stats.size > 100 * 1024) {
      return null;
    }

    const content = fs.readFileSync(fullPath, 'utf-8');
    const score = scoreRelevance(filePath, topic);

    // Determine file type
    let type = 'unknown';
    if (filePath.match(/Model|model/)) type = 'model';
    else if (filePath.match(/Controller|controller/)) type = 'controller';
    else if (filePath.match(/Service|service/)) type = 'service';
    else if (filePath.match(/migration/i)) type = 'migration';
    else if (filePath.match(/\.(ts|js)$/)) type = 'code';
    else if (filePath.match(/\.(php)$/)) type = 'code';

    // Extract important content
    const extracted = extractImportantContent(filePath, content, topic);

    return {
      file: filePath,
      score,
      content: extracted,
      type,
    };
  } catch (error) {
    console.error(`[getContext] Error reading ${filePath}:`, error);
    return null;
  }
}

/**
 * Format context items for Claude
 */
function formatContext(items: ContextItem[], topic: string): string {
  if (items.length === 0) {
    return `No context found for topic: "${topic}"`;
  }

  let output = `Context for: "${topic}"\n\n`;
  output += `Found ${items.length} relevant files:\n\n`;

  for (const item of items) {
    output += `━━━ ${item.file} (${item.type})\n`;
    output += `${item.content}\n\n`;
  }

  return output;
}

/**
 * Execute get_context tool
 */
export async function getContext(
  params: GetContextParams,
  registry: ProjectsRegistry
): Promise<string> {
  const { projectName, topic, maxSize = 3 * 1024 } = params; // Default 3KB

  // Get project
  const project = registry[projectName];
  if (!project) {
    return `Error: Project "${projectName}" not found. Available projects: ${Object.keys(registry).join(', ')}`;
  }

  const projectPath = project.path;

  try {
    console.error(`[getContext] Getting context for "${topic}" in ${projectName}`);

    // Find relevant files
    const relevantFiles = await findRelevantFiles(projectPath, topic);

    if (relevantFiles.length === 0) {
      return `No files found related to topic: "${topic}"`;
    }

    console.error(`[getContext] Found ${relevantFiles.length} potentially relevant files`);

    // Analyze each file
    const contextItems: ContextItem[] = [];

    for (const file of relevantFiles) {
      const item = analyzeFile(projectPath, file, topic);
      if (item) {
        contextItems.push(item);
      }
    }

    // Sort by relevance score
    contextItems.sort((a, b) => b.score - a.score);

    // Trim to maxSize
    let totalSize = 0;
    const trimmedItems: ContextItem[] = [];

    for (const item of contextItems) {
      if (totalSize + item.content.length > maxSize) {
        break;
      }
      trimmedItems.push(item);
      totalSize += item.content.length;
    }

    // Format and return
    const formatted = formatContext(trimmedItems, topic);

    console.error(`[getContext] Returning ${trimmedItems.length} items, ${formatted.length} bytes`);

    return formatted;
  } catch (error: any) {
    console.error('[getContext] Error:', error);
    return `Error getting context: ${error.message}`;
  }
}
