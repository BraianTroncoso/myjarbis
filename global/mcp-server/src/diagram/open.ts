/**
 * Best-effort "open in VS Code" via the `code` CLI.
 *
 * Opens the PROJECT FOLDER (as a workspace) together with the diagram file, so
 * the diagram is the main view AND clicking a file node navigates to that file
 * inside the same project — instead of opening a detached, lone file.
 *
 * Never throws and never blocks: if `code` is missing or fails, we silently
 * no-op (the file is still on disk and the drawio extension reloads it).
 */

import { execSync } from 'child_process';

function q(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

export function openInVscode(diagramPath: string, projectPath?: string): boolean {
  try {
    // 1) Open/focus the project workspace window (idempotent — if it's already
    //    open this just focuses it). 2) Open the diagram REUSING that active
    //    window (-r) so it lands inside the project instead of a lone window.
    if (projectPath) {
      execSync(`code ${q(projectPath)}`, { stdio: 'ignore', timeout: 5000 });
    }
    execSync(`code -r ${q(diagramPath)}`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
