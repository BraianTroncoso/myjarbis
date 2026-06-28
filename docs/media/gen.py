#!/usr/bin/env python3
"""
Generate faithful terminal-window mockups for the README.

Not real screenshots — hand-authored frames rendered as crisp SVG and
rasterized to PNG (GitHub always renders PNG). Faithful to the actual
MyJarbis CLI output + blood-red palette. Edit the FRAMES at the bottom
and re-run:  python3 docs/media/gen.py

Inline markup inside a line:
  [r]..[/]  blood-red accent      [b]..[/]  bold/white
  [d]..[/]  dim grey (paths)      [g]..[/]  green (ok)
  [y]..[/]  yellow                [c]..[/]  cyan/chevron
"""

import html
import re
import os

try:
    import cairosvg
except ImportError:
    cairosvg = None

HERE = os.path.dirname(os.path.abspath(__file__))

# ── palette (dark, marketable, matches the CLI blood-red accent) ──────
BG       = "#0e0e11"
BAR      = "#1b1b20"
BAR_LINE = "#2a2a31"
TXT      = "#e7e7ea"
DIM      = "#7a7a85"
RED      = "#e0413f"   # accent (CLI ANSI 88 reads as blood red; brighter pops on dark)
BOLD     = "#ffffff"
GREEN    = "#3ddc84"
YELLOW   = "#f5c451"
CYAN     = "#5fb3d4"
TITLEFG  = "#b9b9c2"

COLORS = {"r": RED, "d": DIM, "g": GREEN, "y": YELLOW, "c": CYAN}

FONT = "ui-monospace, 'DejaVu Sans Mono', 'Cascadia Code', Menlo, monospace"
FS = 15.5          # body font-size
CH = 9.34          # char width @ FS for DejaVu Sans Mono
LH = 26            # line height
PAD_X = 26
PAD_TOP = 22
BAR_H = 38

TAG = re.compile(r"\[(/|r|d|b|g|y|c)\]")


def spans(line):
    """Parse inline markup → list of (text, color, bold)."""
    out, color, bold, i = [], None, False, 0
    for m in TAG.finditer(line):
        if m.start() > i:
            out.append((line[i:m.start()], color, bold))
        t = m.group(1)
        if t == "/":
            color, bold = None, False
        elif t == "b":
            bold = True
        else:
            color = COLORS[t]
        i = m.end()
    if i < len(line):
        out.append((line[i:], color, bold))
    return out


def plain_len(line):
    return len(TAG.sub("", line))


def render(title, lines, out_name, pad_bottom=18):
    width = int(max(plain_len(l) for l in lines + [title]) * CH + PAD_X * 2)
    width = max(width, 420)
    height = int(BAR_H + PAD_TOP + len(lines) * LH + pad_bottom)

    svg = []
    svg.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'viewBox="0 0 {width} {height}" font-family="{FONT}">'
    )
    svg.append(
        '<defs><filter id="sh" x="-20%" y="-20%" width="140%" height="140%">'
        '<feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="#000" flood-opacity="0.45"/>'
        '</filter></defs>'
    )
    # window
    svg.append(f'<rect x="0" y="0" width="{width}" height="{height}" rx="12" fill="{BG}" filter="url(#sh)"/>')
    # title bar
    svg.append(f'<path d="M0 12 a12 12 0 0 1 12 -12 H{width-12} a12 12 0 0 1 12 12 V{BAR_H} H0 Z" fill="{BAR}"/>')
    svg.append(f'<line x1="0" y1="{BAR_H}" x2="{width}" y2="{BAR_H}" stroke="{BAR_LINE}" stroke-width="1"/>')
    for cx, col in ((20, "#ff5f57"), (40, "#febc2e"), (60, "#28c840")):
        svg.append(f'<circle cx="{cx}" cy="19" r="6" fill="{col}"/>')
    svg.append(
        f'<text x="{width/2}" y="24" font-size="13" fill="{TITLEFG}" '
        f'text-anchor="middle" font-weight="500">{html.escape(title)}</text>'
    )
    # body
    y = BAR_H + PAD_TOP + 4
    for line in lines:
        parts = spans(line)
        if not parts:
            y += LH
            continue
        chunks = []
        for text, color, bold in parts:
            fill = color or (BOLD if bold else TXT)
            weight = ' font-weight="700"' if bold else ""
            chunks.append(f'<tspan fill="{fill}"{weight}>{html.escape(text)}</tspan>')
        svg.append(
            f'<text x="{PAD_X}" y="{y}" font-size="{FS}" '
            f'xml:space="preserve">{"".join(chunks)}</text>'
        )
        y += LH
    svg.append("</svg>")
    doc = "\n".join(svg)

    svg_path = os.path.join(HERE, out_name + ".svg")
    png_path = os.path.join(HERE, out_name + ".png")
    with open(svg_path, "w") as f:
        f.write(doc)
    if cairosvg:
        cairosvg.svg2png(bytestring=doc.encode(), write_to=png_path, scale=2.0)
        print("✓", out_name + ".png", f"({width}x{height})")
    else:
        print("✓", out_name + ".svg", "(no cairosvg — png skipped)")


# ── frames ────────────────────────────────────────────────────────────

render("myjarbis start", [
    "[d]$[/] [b]myjarbis start[/]",
    "",
    "[r]Your projects[/]",
    "",
    "  [b] 1[/])  myjarbis      [d]~/dev-own/myjarbis[/]",
    "  [b] 2[/])  tgf-web       [d]~/dev/tgf-web[/]",
    "  [b] 3[/])  aura          [d]~/dev-own/aura[/]",
    "  [b] 4[/])  relay         [d]~/dev-own/relay[/]",
    "  [b] 5[/])  roster        [d]~/dev-own/roster[/]",
    "  [b] 6[/])  ibera         [d]~/dev-own/dmeter-repositories/ibera[/]",
    "",
    "  [r]Pick[/] (numbers like '1 3', or a name) [d][Enter to cancel][/]: [b]1 3[/]",
], "01-start-picker")

render("myjarbis start  ·  1 3", [
    "[r]myjarbis start[/] [d]·[/] launching (wt)",
    "",
    "  [b]myjarbis[/]  [d]~/dev-own/myjarbis[/]  [r]→[/] wt tab",
    "  [b]aura[/]      [d]~/dev-own/aura[/]      [r]→[/] wt tab",
    "",
    "  [g]✓[/] two tabs opened — claude + /jarbis in each",
], "02-start-launch")

render("● claude — myjarbis", [
    "[c]❯[/] [b]/jarbis[/]",
    "",
    "  [d]Called[/] myjarbis [d]·[/] current_project",
    "  [d]Called[/] myjarbis [d]·[/] list_modules",
    "",
    "[r]Project: myjarbis[/] — 5 modules",
    "",
    "  [b]1.[/] mcp-server   [d]Node MCP server (TS + better-sqlite3 + FTS5)[/]",
    "  [b]2.[/] cli          [d]bash bin/* + node cli.ts subcommands[/]",
    "  [b]3.[/] hooks        [d].claude-plugin SessionStart / Stop[/]",
    "  [b]4.[/] commands     [d].claude/commands/*.md slash commands[/]",
    "  [b]5.[/] _general     [d]default cross-cutting module[/]",
    "",
    "  Which module are we working on?",
], "03-jarbis-bootstrap")

render("myjarbis status", [
    "[r]MyJarbis[/] [d]·[/] [b]myjarbis[/] [d](generic)[/]",
    "  Path          [d]~/dev-own/myjarbis[/]",
    "  Branch        [b]feat/myjarbis-start[/]",
    "",
    "[r]Active module[/]",
    "  Name          [b]mcp-server[/]",
    "  About         [d]Node MCP server (TS + better-sqlite3 + FTS5)[/]",
    "",
    "[r]Counts[/]",
    "  Modules       5",
    "  Observations  128",
    "  Skills        [g]11 baselines materialized[/]",
    "  Sessions      [d]42 closed · 1 open[/]",
], "04-status")

print("done →", HERE)
