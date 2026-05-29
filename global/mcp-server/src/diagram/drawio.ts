/**
 * draw.io (mxfile) XML builder — pure, no DB / no FS.
 *
 * Emits plain `.drawio` XML (the same format as docs/myjarbis-architecture.drawio)
 * so the VS Code `hediet.vscode-drawio` extension renders it and reloads on disk
 * change. Per-node hyperlinks use the canonical `<UserObject link="…">` wrapper.
 *
 * Output is intentionally deterministic (no timestamps / random ids) so the
 * generator can compare against the previous file and skip identical writes.
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
  fill?: string;
  /** When set, the node becomes a clickable hyperlink (UserObject wrapper). */
  link?: string;
  /** 0 = normal, 1 = bold, 2 = italic. */
  fontStyle?: number;
  align?: 'left' | 'center' | 'right';
}

export function box(o: BoxOpts): string {
  const style =
    `rounded=0;whiteSpace=wrap;html=1;` +
    `fillColor=${o.fill ?? '#ffffff'};strokeColor=#000000;fontColor=#000000;` +
    `align=${o.align ?? 'center'};verticalAlign=middle;fontStyle=${o.fontStyle ?? 0};`;
  const geom = `<mxGeometry x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" as="geometry" />`;

  if (o.link) {
    // Canonical draw.io link pattern: UserObject carries label + link + id,
    // the inner mxCell has no value (it inherits the UserObject label).
    return (
      `<UserObject label="${labelHtml(o.label)}" link="${escapeXml(o.link)}" id="${o.id}">` +
      `<mxCell style="${style}" vertex="1" parent="1">${geom}</mxCell>` +
      `</UserObject>`
    );
  }
  return (
    `<mxCell id="${o.id}" value="${labelHtml(o.label)}" style="${style}" vertex="1" parent="1">` +
    `${geom}</mxCell>`
  );
}

export function edge(id: string, source: string, target: string, label = ''): string {
  const style =
    `endArrow=open;html=1;rounded=0;strokeColor=#000000;edgeStyle=orthogonalEdgeStyle;fontSize=10;`;
  const value = label ? ` value="${escapeXml(label)}"` : '';
  return (
    `<mxCell id="${id}"${value} style="${style}" edge="1" parent="1" source="${source}" target="${target}">` +
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
