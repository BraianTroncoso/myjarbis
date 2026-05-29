/**
 * draw.io (mxfile) XML builder — pure, no DB / no FS.
 *
 * Emits plain `.drawio` XML (same format as docs/myjarbis-architecture.drawio)
 * so the VS Code `hediet.vscode-drawio` extension renders it and reloads on
 * disk change. Supports collapsible containers (a feature card that groups its
 * files) and per-node hyperlinks via the canonical `<UserObject link="…">`.
 *
 * Output is deterministic (no timestamps / random ids) so the generator can
 * compare against the previous file and skip identical writes.
 */

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Turn newlines into <br> so multi-line labels render inside a draw.io box. */
function labelHtml(label: string): string {
  return escapeXml(label).replace(/\n/g, '&lt;br&gt;');
}

export interface BoxOpts {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Parent cell id. '1' = root layer; a container id nests the box inside it. */
  parent?: string;
  fill?: string;
  stroke?: string;
  fontColor?: string;
  /** When set, the node becomes a clickable hyperlink (UserObject wrapper). */
  link?: string;
  /** Hover tooltip (e.g. the full file path while the label shows the name). */
  tooltip?: string;
  fontStyle?: number; // 0 normal, 1 bold, 2 italic
  fontSize?: number;
  align?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  rounded?: boolean;
  spacingLeft?: number;
  /** Render as a collapsible container that holds child cells. */
  container?: boolean;
  /** Header height kept visible when a container is collapsed. */
  startSize?: number;
  /** Pass the label as raw HTML (already escaped where needed). */
  rawLabel?: boolean;
}

function styleOf(o: BoxOpts): string {
  const va = o.container ? 'top' : o.verticalAlign ?? 'middle';
  const parts = [
    `rounded=${o.rounded ? 1 : 0}`,
    'whiteSpace=wrap',
    'html=1',
    `fillColor=${o.fill ?? '#ffffff'}`,
    `strokeColor=${o.stroke ?? '#000000'}`,
    `fontColor=${o.fontColor ?? '#000000'}`,
    `align=${o.align ?? 'center'}`,
    `verticalAlign=${va}`,
    `fontStyle=${o.fontStyle ?? 0}`,
  ];
  if (o.fontSize) parts.push(`fontSize=${o.fontSize}`);
  if (o.spacingLeft) parts.push(`spacingLeft=${o.spacingLeft}`);
  if (o.container) {
    parts.push('container=1', 'collapsible=1');
    parts.push(`startSize=${o.startSize ?? 30}`);
  }
  return parts.join(';') + ';';
}

export function box(o: BoxOpts): string {
  const parent = o.parent ?? '1';
  const style = styleOf(o);
  const geom = `<mxGeometry x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" as="geometry" />`;
  // draw.io stores HTML labels as entity-escaped text in the value attribute
  // (e.g. <b> → &lt;b&gt;). rawLabel carries literal HTML tags we still escape;
  // non-raw labels also turn newlines into <br>.
  const value = o.rawLabel ? escapeXml(o.label) : labelHtml(o.label);

  if (o.link) {
    const tip = o.tooltip ? ` tooltip="${escapeXml(o.tooltip)}"` : '';
    return (
      `<UserObject label="${value}" link="${escapeXml(o.link)}"${tip} id="${o.id}">` +
      `<mxCell style="${style}" vertex="1" parent="${parent}">${geom}</mxCell>` +
      `</UserObject>`
    );
  }
  return (
    `<mxCell id="${o.id}" value="${value}" style="${style}" vertex="1" parent="${parent}">` +
    `${geom}</mxCell>`
  );
}

export interface EdgeOpts {
  id: string;
  source: string;
  target: string;
  label?: string;
  stroke?: string;
  dashed?: boolean;
}

export function edge(o: EdgeOpts): string {
  const style =
    `endArrow=block;endFill=1;html=1;rounded=0;` +
    `strokeColor=${o.stroke ?? '#b3b3b3'};${o.dashed ? 'dashed=1;' : ''}` +
    `edgeStyle=orthogonalEdgeStyle;` +
    `exitX=0.5;exitY=1;exitDx=0;exitDy=0;entryX=0.5;entryY=0;entryDx=0;entryDy=0;fontSize=10;fontColor=#999999;`;
  const value = o.label ? ` value="${escapeXml(o.label)}"` : '';
  return (
    `<mxCell id="${o.id}"${value} style="${style}" edge="1" parent="1" source="${o.source}" target="${o.target}">` +
    `<mxGeometry relative="1" as="geometry" /></mxCell>`
  );
}

export function buildMxfile(diagramName: string, cells: string[]): string {
  const body = cells.map((c) => '        ' + c).join('\n');
  return (
    `<mxfile host="MyJarbis" agent="myjarbis-diagram" version="24.0.0">\n` +
    `  <diagram name="${escapeXml(diagramName)}" id="myjarbis-diagram">\n` +
    `    <mxGraphModel dx="1400" dy="900" grid="1" gridSize="10" guides="1" tooltips="1" ` +
    `connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1700" pageHeight="2200" ` +
    `math="0" shadow="0">\n` +
    `      <root>\n` +
    `        <mxCell id="0" />\n` +
    `        <mxCell id="1" parent="0" />\n` +
    `${body}\n` +
    `      </root>\n` +
    `    </mxGraphModel>\n` +
    `  </diagram>\n` +
    `</mxfile>\n`
  );
}
