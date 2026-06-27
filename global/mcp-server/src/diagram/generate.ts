/**
 * Living diagram generator.
 *
 * Renders the ACTIVE module (or a named one) as a `.drawio` file under
 * `<project>/.myjarbis/diagrams/<module>.drawio`. The diagram is an EXECUTIVE
 * view of the MyJarbis DB: one collapsible card per observation (the thing you
 * did), titled with its human title + a small kind tag + the "why" (first line
 * of content), holding the files it touched as clickable child nodes. Files
 * show the filename only (full path in the tooltip) and link to source via
 * `vscode://…` so a click opens the code inside the project. Cards are chained
 * top-to-bottom with arrows to show the order work happened in.
 *
 * Minimalist palette: white cards, thin grey borders, a single brand accent on
 * the banner. Kind is conveyed by a text tag, not by fill colour.
 *
 * Writes are idempotent (skips identical content) and best-effort: the public
 * `maybeRegenerateDiagram` never throws, so hooks/tools can call it freely.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ServerContext } from '../context.js';
import { ObservationRow, ObservationKind } from '../db/schema.js';
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

export function isDiagramAuto(projectPath: string): boolean {
  try {
    const p = path.join(projectPath, '.myjarbis', 'config', 'settings.json');
    if (!fs.existsSync(p)) return false;
    const s = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
      diagram?: { auto?: boolean };
    };
    return s?.diagram?.auto === true;
  } catch {
    return false;
  }
}

/** Build a clickable link that opens the file in the ALREADY-OPEN VS Code
 *  window WITHOUT a permission prompt and without spawning an empty window.
 *
 *  Tested in this env (hediet.vscode-drawio v1.9.0 under Remote-WSL):
 *    - `vscode://vscode-remote/wsl+...` → prompts AND opens a blank window (ms/vscode#236348)
 *    - `command:vscode.open?...`        → blocked by the webview, click does nothing
 *    - RELATIVE path (this)             → extension resolves it and opens the file in-workspace
 *
 *  So we emit a path RELATIVE to the .drawio's directory
 *  (<project>/.myjarbis/diagrams). Note: relative-link support is version-
 *  dependent. Fallback if a future version stops resolving it (prompts once):
 *    const distro = process.env.WSL_DISTRO_NAME;
 *    return distro ? `vscode://vscode-remote/wsl+${distro}${abs}` : `vscode://file${abs}`;
 */
function fileLink(projectPath: string, file: string): string {
  const abs = path.isAbsolute(file) ? file : path.resolve(projectPath, file);
  // Relative path from the .drawio file's dir (<project>/.myjarbis/diagrams) to
  // the source file. The hediet drawio extension resolves relative links and
  // opens the file inside the workspace — no external-URI prompt, no blank
  // window. (vscode:// opens an empty WSL window; command:vscode.open is blocked
  // by the webview — both ruled out by testing.)
  const diagramDir = path.join(projectPath, '.myjarbis', 'diagrams');
  return path.relative(diagramDir, abs);
}

/** Minimalist: only a short text tag per kind (no fill colours). */
function kindTag(kind: ObservationKind): string {
  switch (kind) {
    case 'progress':
      return 'DONE';
    case 'decision':
      return 'DECISION';
    case 'discovery':
      return 'NOTE';
    case 'gotcha':
      return 'GOTCHA';
    case 'error':
      return 'OPEN';
    default:
      return String(kind).toUpperCase();
  }
}

/** First meaningful line of the content ("WHY first"), word-trimmed to `max`
 *  characters so it never cuts mid-word. */
function whyLine(content: string, max = 150): string {
  const first = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return '';
  const clean = first.replace(/[*_`#>]/g, '').replace(/^(WHY|WHAT|HOW)\s*:?\s*/i, '').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + '…';
}

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

function sanitizeId(s: string): string {
  return 'n_' + s.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** Rough wrapped-line estimate so headers reserve enough vertical room. */
function estLines(text: string, charsPerLine: number): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / charsPerLine));
}

// layout constants
const PAGE_X = 40;
const CARD_W = 600;
const FILE_H = 26;
const FILE_GAP = 6;
const INNER_X = 14;
const PAD_TOP = 12; // gap between header text and first file
const PAD_BOTTOM = 14;
const CARD_GAP = 56; // room for the connector arrow between cards
const TITLE_INDENT = 24; // leave room for the collapse [-] toggle
const TITLE_CPL = 52; // chars/line for the bold title
const WHY_CPL = 80; // chars/line for the grey why line
const LINE_TITLE = 18;
const LINE_TAG = 14;
const LINE_WHY = 15;

// minimalist palette
const C_BANNER = '#5a0a0a'; // single brand accent
const C_CARD_BORDER = '#9a9a9a';
const C_FILE_BORDER = '#d0d0d0';
const C_TEXT = '#222222';
const C_MUTED = '#777777';
const C_EDGE = '#b3b3b3';

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

  const observations: ObservationRow[] = ctx.db.observations
    .listByModule(moduleRow.id, 1000)
    .slice()
    .sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id,
    );

  const cells: string[] = [];
  let nodeCount = 0;
  let edgeCount = 0;
  let y = 24;

  // ── Module banner ──
  cells.push(
    box({
      id: 'title',
      label: moduleRow.name,
      x: PAGE_X,
      y,
      w: CARD_W,
      h: 38,
      fill: C_BANNER,
      stroke: C_BANNER,
      fontColor: '#ffffff',
      fontStyle: 1,
      fontSize: 17,
      rounded: true,
    }),
  );
  y += 38 + 18;

  if (observations.length === 0) {
    cells.push(
      box({
        id: 'empty',
        label:
          'Sin datos todavía.\nRegistrá avance (save_observation) y el diagrama se irá poblando.',
        x: PAGE_X,
        y,
        w: CARD_W,
        h: 60,
        align: 'left',
        fontColor: C_MUTED,
        stroke: C_CARD_BORDER,
        rounded: true,
      }),
    );
    nodeCount++;
    return writeDiagram(ctx, moduleRow.name, cells, nodeCount, 0);
  }

  // ── One card per observation, chained with arrows ──
  let prevId: string | null = null;

  for (const o of observations) {
    const files = [
      ...new Set((o.files ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    ];
    const id = sanitizeId(`obs_${o.id}`);
    const why = whyLine(o.content);

    // Header height grows with wrapped title + why so text never clips.
    const titleLines = estLines(o.title, TITLE_CPL);
    const whyLines = why ? estLines(why, WHY_CPL) : 0;
    const headerH =
      10 + titleLines * LINE_TITLE + LINE_TAG + (whyLines ? whyLines * LINE_WHY : 0) + 10;

    // Indent the title block so it clears the collapse toggle in the corner.
    const header =
      `<div style="margin-left:${TITLE_INDENT}px;">` +
      `<b>${o.title}</b>` +
      `<br><font style="font-size:9px;letter-spacing:1px;color:${C_MUTED};">${kindTag(o.kind)}</font>` +
      (why ? `<br><font style="font-size:10px;color:${C_MUTED};">${why}</font>` : '') +
      `</div>`;

    if (files.length === 0) {
      cells.push(
        box({
          id,
          label: header,
          rawLabel: true,
          x: PAGE_X,
          y,
          w: CARD_W,
          h: headerH,
          fill: '#ffffff',
          stroke: C_CARD_BORDER,
          fontColor: C_TEXT,
          align: 'left',
          verticalAlign: 'middle',
          spacingLeft: 12,
          rounded: true,
        }),
      );
      nodeCount++;
      if (prevId) {
        cells.push(edge({ id: `e_${prevId}_${id}`, source: prevId, target: id, stroke: C_EDGE }));
        edgeCount++;
      }
      prevId = id;
      y += headerH + CARD_GAP;
      continue;
    }

    const filesTop = headerH + PAD_TOP;
    const cardH = filesTop + files.length * (FILE_H + FILE_GAP) + PAD_BOTTOM;
    cells.push(
      box({
        id,
        label: header,
        rawLabel: true,
        x: PAGE_X,
        y,
        w: CARD_W,
        h: cardH,
        fill: '#ffffff',
        stroke: C_CARD_BORDER,
        fontColor: C_TEXT,
        align: 'left',
        spacingLeft: 12,
        rounded: true,
        container: true,
        startSize: headerH,
      }),
    );
    nodeCount++;
    if (prevId) {
      cells.push(edge({ id: `e_${prevId}_${id}`, source: prevId, target: id, stroke: C_EDGE }));
      edgeCount++;
    }
    prevId = id;

    files.forEach((f, j) => {
      const fy = filesTop + j * (FILE_H + FILE_GAP);
      cells.push(
        box({
          id: `${id}_f${j}`,
          label: basename(f),
          parent: id,
          x: INNER_X,
          y: fy,
          w: CARD_W - 2 * INNER_X,
          h: FILE_H,
          fill: '#fbfbfb',
          stroke: C_FILE_BORDER,
          fontColor: C_TEXT,
          // No clickable link: hediet v1.9.0 has no working generic file-link
          // format (vscode:// → blank window, command: → blocked, relative →
          // resolves against the extension dir / opens a browser). We show the
          // full path in the tooltip; copy it + Ctrl+P to open. Native file
          // links exist via the "Link File With Selected Node" command (manual,
          // UI-set) — a future option if we ever want real click-to-open.
          tooltip: f,
          align: 'left',
          fontSize: 11,
          spacingLeft: 8,
        }),
      );
      nodeCount++;
    });

    y += cardH + CARD_GAP;
  }

  return writeDiagram(ctx, moduleRow.name, cells, nodeCount, edgeCount);
}

function writeDiagram(
  ctx: ServerContext,
  moduleName: string,
  cells: string[],
  nodeCount: number,
  edgeCount: number,
): GenerateResult {
  const xml = buildMxfile(moduleName, cells);
  const outDir = path.join(ctx.projectPath, '.myjarbis', 'diagrams');
  const outPath = path.join(outDir, `${moduleName}.drawio`);
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
    return { ok: false, reason: 'write-failed:' + (e as Error).message, module: moduleName };
  }
  return { ok: true, module: moduleName, path: outPath, nodeCount, edgeCount, changed };
}

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
