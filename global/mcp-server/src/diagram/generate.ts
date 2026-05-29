/**
 * Living diagram generator.
 *
 * Renders the ACTIVE module (or a named one) as a `.drawio` file under
 * `<project>/.myjarbis/diagrams/<module>.drawio`. The diagram is a VIEW of the
 * MyJarbis DB:
 *   - one box per story (module_context kind='story'), coloured by `progress`
 *   - connected to file boxes (the `files` of observations tied to that story),
 *     each linked to source via `vscode://…` so a click opens the code
 *   - falls back to observation file groups when the module has no stories
 *
 * Writes are idempotent (skips identical content) and best-effort: the public
 * `maybeRegenerateDiagram` never throws, so hooks/tools can call it freely.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ServerContext } from '../context.js';
import { ModuleContextRow } from '../db/schema.js';
import { box, edge, buildMxfile } from './drawio.js';

export interface GenerateResult {
  ok: boolean;
  reason?: string;
  module?: string;
  path?: string;
  nodeCount?: number;
  edgeCount?: number;
  changed?: boolean;
}

// ── helpers ────────────────────────────────────────────────────────────

/** Read `.myjarbis/active` (module name) without depending on cli.ts. */
function readActiveModuleName(projectPath: string): string | null {
  try {
    const p = path.join(projectPath, '.myjarbis', 'active');
    if (!fs.existsSync(p)) return null;
    const v = fs.readFileSync(p, 'utf-8').trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Is the auto-diagram toggle on? Default ON when unset. */
export function isDiagramAuto(projectPath: string): boolean {
  try {
    const p = path.join(projectPath, '.myjarbis', 'config', 'settings.json');
    if (!fs.existsSync(p)) return true;
    const s = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      diagram?: { auto?: boolean };
    };
    return s?.diagram?.auto !== false;
  } catch {
    return true;
  }
}

/** Build a clickable link to a source file. Handles WSL remote paths. */
function fileLink(projectPath: string, file: string): string {
  const abs = path.isAbsolute(file) ? file : path.resolve(projectPath, file);
  const distro = process.env.WSL_DISTRO_NAME;
  // Under WSL, VS Code resolves files via the remote authority form.
  if (distro) return `vscode://vscode-remote/wsl+${distro}${abs}`;
  return `vscode://file${abs}`;
}

/** Pick a fill colour from a free-form progress string (emoji/keyword based). */
function progressFill(progress: string | null): string {
  if (!progress) return '#ffffff';
  const p = progress.toLowerCase();
  if (progress.includes('✅') || p.includes('done')) return '#d5e8d4'; // green
  if (progress.includes('🔴') || p.includes('block')) return '#f8cecc'; // red
  if (progress.includes('🔄') || p.includes('wip') || p.includes('progress'))
    return '#fff2cc'; // amber
  return '#ffffff';
}

/** Extract a story's local id from `source_path` ("…#MM-S3.6"). */
function storyLocalId(s: ModuleContextRow): string | null {
  if (s.source_path && s.source_path.includes('#')) {
    const id = s.source_path.split('#').pop();
    return id && id.length > 0 ? id : null;
  }
  return null;
}

function sanitizeId(s: string): string {
  return 'n_' + s.replace(/[^a-zA-Z0-9_]/g, '_');
}

// layout constants
const STORY_X = 40;
const FILE_X = 360;
const STORY_W = 280;
const FILE_W = 460;
const BOX_H = 40;
const GAP = 14;
const LANE_GAP = 26;

// ── core ───────────────────────────────────────────────────────────────

export function generateModuleDiagram(
  ctx: ServerContext,
  moduleName?: string,
): GenerateResult {
  const project = ctx.project;
  if (!project) return { ok: false, reason: 'no-project' };

  const name =
    moduleName ??
    readActiveModuleName(ctx.projectPath) ??
    (ctx.activeModuleId != null
      ? ctx.db.modules.findById(ctx.activeModuleId)?.name
      : undefined) ??
    undefined;
  if (!name) return { ok: false, reason: 'no-active-module' };

  const moduleRow = ctx.db.modules.findByName(project.id, name);
  if (!moduleRow) return { ok: false, reason: `module-not-found:${name}` };

  const ctxRows = ctx.db.moduleContext.listByModule(moduleRow.id);
  const stories = ctxRows.filter((r) => r.kind === 'story');
  const obs = ctx.db.observations.listByModule(moduleRow.id, 1000);

  // files grouped by story_local_id (preserves insertion order, dedup)
  const filesByStory = new Map<string, string[]>();
  for (const o of obs) {
    if (!o.files) continue;
    const key = o.story_local_id ?? '(unassigned)';
    const arr = filesByStory.get(key) ?? [];
    for (const f of o.files.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!arr.includes(f)) arr.push(f);
    }
    filesByStory.set(key, arr);
  }

  const cells: string[] = [];
  let nodeCount = 0;
  let edgeCount = 0;
  let y = 90;

  cells.push(
    box({
      id: 'title',
      label: `${moduleRow.name} — MyJarbis`,
      x: STORY_X,
      y: 30,
      w: 760,
      h: 40,
      fontStyle: 1,
    }),
  );

  const renderLane = (
    nodeId: string,
    label: string,
    fill: string,
    files: string[],
  ): void => {
    const fileCount = files.length;
    const laneH = Math.max(
      BOX_H,
      fileCount * BOX_H + Math.max(0, fileCount - 1) * GAP,
    );
    const storyY = y + Math.max(0, Math.floor((laneH - BOX_H) / 2));
    cells.push(
      box({ id: nodeId, label, x: STORY_X, y: storyY, w: STORY_W, h: BOX_H, fill, fontStyle: 1 }),
    );
    nodeCount++;
    files.forEach((f, j) => {
      const fid = `${nodeId}_f${j}`;
      const fy = y + j * (BOX_H + GAP);
      cells.push(
        box({
          id: fid,
          label: f,
          x: FILE_X,
          y: fy,
          w: FILE_W,
          h: BOX_H,
          fill: '#f5f5f5',
          link: fileLink(ctx.projectPath, f),
          align: 'left',
        }),
      );
      nodeCount++;
      cells.push(edge(`e_${nodeId}_${j}`, nodeId, fid));
      edgeCount++;
    });
    y += laneH + LANE_GAP;
  };

  const usedStoryKeys = new Set<string>();

  if (stories.length > 0) {
    for (const s of stories) {
      const lid = storyLocalId(s);
      const files = lid && filesByStory.get(lid) ? filesByStory.get(lid)! : [];
      if (lid) usedStoryKeys.add(lid);
      const label =
        (lid ? `[${lid}] ` : '') + s.title + (s.progress ? `\n${s.progress}` : '');
      renderLane(sanitizeId(`story_${s.id}`), label, progressFill(s.progress), files);
    }
    // Orphan file groups: observations whose story_local_id matched no story.
    for (const [key, files] of filesByStory) {
      if (key !== '(unassigned)' && usedStoryKeys.has(key)) continue;
      const label = key === '(unassigned)' ? 'Sin story asignada' : `[${key}]`;
      renderLane(sanitizeId(`grp_${key}`), label, '#ffffff', files);
    }
  } else if (filesByStory.size === 0) {
    cells.push(
      box({
        id: 'empty',
        label:
          'Sin datos todavía.\nRegistrá avance (save_observation con files) y el diagrama se irá poblando.',
        x: STORY_X,
        y,
        w: 720,
        h: 60,
        align: 'left',
      }),
    );
    nodeCount++;
  } else {
    for (const [key, files] of filesByStory) {
      const label = key === '(unassigned)' ? 'Observaciones' : `[${key}]`;
      renderLane(sanitizeId(`grp_${key}`), label, '#ffffff', files);
    }
  }

  const xml = buildMxfile(moduleRow.name, cells);

  const outDir = path.join(ctx.projectPath, '.myjarbis', 'diagrams');
  const outPath = path.join(outDir, `${moduleRow.name}.drawio`);
  let changed = true;
  try {
    const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf-8') : null;
    if (prev === xml) {
      changed = false;
    } else {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(outPath, xml, 'utf-8');
    }
  } catch (e) {
    return {
      ok: false,
      reason: 'write-failed:' + (e as Error).message,
      module: moduleRow.name,
    };
  }

  return { ok: true, module: moduleRow.name, path: outPath, nodeCount, edgeCount, changed };
}

/** Best-effort regen for hooks/tools. Honours the toggle; never throws. */
export function maybeRegenerateDiagram(
  ctx: ServerContext,
  moduleName?: string,
): GenerateResult {
  try {
    if (!isDiagramAuto(ctx.projectPath)) return { ok: false, reason: 'disabled' };
    return generateModuleDiagram(ctx, moduleName);
  } catch (e) {
    return { ok: false, reason: 'error:' + (e as Error).message };
  }
}
