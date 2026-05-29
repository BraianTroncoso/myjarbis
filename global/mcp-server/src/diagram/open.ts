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
    const target = projectPath
      ? `${q(projectPath)} ${q(diagramPath)}`
      : q(diagramPath);
    execSync(`code ${target}`, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}
