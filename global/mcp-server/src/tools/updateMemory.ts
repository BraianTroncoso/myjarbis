/**
 * MyJarvis MCP Tool: update_memory
 *
 * Update the project's knowledge base with new information.
 *
 * WHY THIS EXISTS:
 * - After implementing features, we need to record what was built
 * - Manual updates are tedious and often forgotten
 * - This tool automates knowledge base maintenance
 *
 * HOW IT WORKS:
 * 1. Takes a memory entry (what was built, why, how)
 * 2. Appends to .myjarvis/context/knowledge-base.md
 * 3. Maintains chronological order with timestamps
 * 4. Validates entry format before writing
 *
 * EXAMPLE ENTRY:
 * ```
 * ## 2025-10-19 - User Authentication System
 *
 * **What:** Implemented JWT-based authentication
 *
 * **Why:** Need secure stateless authentication for API
 *
 * **How:**
 * - Created AuthController with login/register/logout
 * - Added JWT middleware for protected routes
 * - User model updated with password hashing
 *
 * **Files:**
 * - app/Http/Controllers/AuthController.php
 * - app/Http/Middleware/JwtAuth.php
 * - app/Models/User.php (updated)
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import { ProjectsRegistry } from '../types.js';

/**
 * Parameters for the update_memory tool
 */
export interface UpdateMemoryParams {
  /** Name of the project */
  projectName: string;

  /** Title of what was implemented */
  title: string;

  /** What was built */
  what: string;

  /** Why it was built this way */
  why: string;

  /** How it was implemented (technical details) */
  how: string;

  /** List of files created/modified */
  files?: string[];

  /** Additional notes or lessons learned */
  notes?: string;
}

/**
 * Format a memory entry as markdown
 */
function formatMemoryEntry(params: UpdateMemoryParams): string {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const { title, what, why, how, files = [], notes } = params;

  let entry = `\n## ${date} - ${title}\n\n`;

  entry += `**What:** ${what}\n\n`;
  entry += `**Why:** ${why}\n\n`;
  entry += `**How:**\n${how}\n\n`;

  if (files.length > 0) {
    entry += `**Files:**\n`;
    files.forEach(file => {
      entry += `- ${file}\n`;
    });
    entry += '\n';
  }

  if (notes) {
    entry += `**Notes:** ${notes}\n\n`;
  }

  entry += `---\n`;

  return entry;
}

/**
 * Validate memory entry parameters
 */
function validateEntry(params: UpdateMemoryParams): string | null {
  if (!params.title || params.title.trim().length === 0) {
    return 'Title is required';
  }

  if (!params.what || params.what.trim().length === 0) {
    return 'What (description) is required';
  }

  if (!params.why || params.why.trim().length === 0) {
    return 'Why (rationale) is required';
  }

  if (!params.how || params.how.trim().length === 0) {
    return 'How (implementation details) is required';
  }

  return null;
}

/**
 * Initialize knowledge-base.md if it doesn't exist
 */
function initializeKnowledgeBase(knowledgeBasePath: string): void {
  if (!fs.existsSync(knowledgeBasePath)) {
    const template = `# Knowledge Base

This file contains a chronological record of everything built in this project.

Each entry documents:
- **What** was implemented
- **Why** decisions were made
- **How** it was implemented
- **Files** that were created/modified

This serves as project memory for Claude and documentation for the team.

---

`;

    fs.writeFileSync(knowledgeBasePath, template, 'utf-8');
    console.error('[updateMemory] Initialized knowledge-base.md');
  }
}

/**
 * Execute update_memory tool
 */
export async function updateMemory(
  params: UpdateMemoryParams,
  registry: ProjectsRegistry
): Promise<string> {
  const { projectName } = params;

  // Get project
  const project = registry[projectName];
  if (!project) {
    return `Error: Project "${projectName}" not found. Available projects: ${Object.keys(registry).join(', ')}`;
  }

  // Validate entry
  const validationError = validateEntry(params);
  if (validationError) {
    return `Error: ${validationError}`;
  }

  // Get knowledge base path
  const knowledgeBasePath = path.join(
    project.path,
    '.myjarvis',
    'context',
    'knowledge-base.md'
  );

  try {
    console.error(`[updateMemory] Updating knowledge base for ${projectName}`);

    // Ensure knowledge base exists
    const contextDir = path.dirname(knowledgeBasePath);
    if (!fs.existsSync(contextDir)) {
      fs.mkdirSync(contextDir, { recursive: true });
    }

    initializeKnowledgeBase(knowledgeBasePath);

    // Format the new entry
    const entry = formatMemoryEntry(params);

    // Append to knowledge base
    fs.appendFileSync(knowledgeBasePath, entry, 'utf-8');

    console.error('[updateMemory] Successfully updated knowledge base');

    return `Successfully added entry to knowledge base:\n\n${entry}`;
  } catch (error: any) {
    console.error('[updateMemory] Error:', error);
    return `Error updating memory: ${error.message}`;
  }
}

/**
 * Helper: Read current knowledge base
 */
export async function readKnowledgeBase(
  projectName: string,
  registry: ProjectsRegistry
): Promise<string> {
  const project = registry[projectName];
  if (!project) {
    return `Error: Project "${projectName}" not found.`;
  }

  const knowledgeBasePath = path.join(
    project.path,
    '.myjarvis',
    'context',
    'knowledge-base.md'
  );

  try {
    if (!fs.existsSync(knowledgeBasePath)) {
      return 'Knowledge base not initialized yet.';
    }

    const content = fs.readFileSync(knowledgeBasePath, 'utf-8');
    return content;
  } catch (error: any) {
    return `Error reading knowledge base: ${error.message}`;
  }
}
