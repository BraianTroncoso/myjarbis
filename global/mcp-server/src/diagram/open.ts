/**
 * Best-effort "open file in VS Code" via the `code` CLI.
 *
 * Used by the SessionStart hook so the living diagram pops up beside the editor.
 * Never throws and never blocks: if `code` is missing or fails, we silently no-op
 * (the file is still on disk and the drawio extension reloads it when present).
 */

import { execSync } from 'child_process';

export function openInVscode(absPath: string): boolean {
  try {
    execSync(`code "${absPath.replace(/"/g, '\\"')}"`, {
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}
