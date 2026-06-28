#!/usr/bin/env python3
"""
Generate faithful mockups for the README.

Not real screenshots — hand-authored frames rendered as crisp SVG and
rasterized to PNG (GitHub always renders PNG). Faithful to the actual
MyJarbis CLI output + blood-red palette. **All project/module data here
is fictional demo data** (api-server, web-client, ...) — never real
project names. Edit the FRAMES at the bottom and re-run:

    python3 docs/media/gen.py

Inline markup inside a terminal line:
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

# ── terminal palette (dark, matches the CLI blood-red accent) ─────────
BG, BAR, BAR_LINE = "#0e0e11", "#1b1b20", "#2a2a31"
TXT, DIM, TITLEFG = "#e7e7ea", "#7a7a85", "#b9b9c2"
RED, BOLD = "#e0413f", "#ffffff"
GREEN, YELLOW, CYAN = "#3ddc84", "#f5c451", "#5fb3d4"
COLORS = {"r": RED, "d": DIM, "g": GREEN, "y": YELLOW, "c": CYAN}

MONO = "ui-monospace, 'DejaVu Sans Mono', 'Cascadia Code', Menlo, monospace"
SANS = "'DejaVu Sans', Helvetica, Arial, sans-serif"
FS, CH, LH = 15.5, 9.34, 26
PAD_X, PAD_TOP, BAR_H = 26, 22, 38

TAG = re.compile(r"\[(/|r|d|b|g|y|c)\]")


def spans(line):
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


def shadow_defs():
    return ('<defs><filter id="sh" x="-20%" y="-20%" width="140%" height="140%">'
            '<feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="#000" '
            'flood-opacity="0.45"/></filter>'
            '<filter id="cardsh" x="-10%" y="-10%" width="120%" height="130%">'
            '<feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#000" '
            'flood-opacity="0.12"/></filter></defs>')


def write(doc, out_name, w, h):
    with open(os.path.join(HERE, out_name + ".svg"), "w") as f:
        f.write(doc)
    if cairosvg:
        cairosvg.svg2png(bytestring=doc.encode(),
                         write_to=os.path.join(HERE, out_name + ".png"), scale=2.0)
        print("✓", out_name + ".png", f"({w}x{h})")
    else:
        print("✓", out_name + ".svg", "(no cairosvg)")


def render(title, lines, out_name, pad_bottom=18):
    """A dark terminal window with monospace, colored body lines."""
    width = max(int(max(plain_len(l) for l in lines + [title]) * CH + PAD_X * 2), 420)
    height = int(BAR_H + PAD_TOP + len(lines) * LH + pad_bottom)
    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
         f'viewBox="0 0 {width} {height}" font-family="{MONO}">', shadow_defs()]
    s.append(f'<rect x="0" y="0" width="{width}" height="{height}" rx="12" fill="{BG}" filter="url(#sh)"/>')
    s.append(f'<path d="M0 12 a12 12 0 0 1 12 -12 H{width-12} a12 12 0 0 1 12 12 V{BAR_H} H0 Z" fill="{BAR}"/>')
    s.append(f'<line x1="0" y1="{BAR_H}" x2="{width}" y2="{BAR_H}" stroke="{BAR_LINE}"/>')
    for cx, col in ((20, "#ff5f57"), (40, "#febc2e"), (60, "#28c840")):
        s.append(f'<circle cx="{cx}" cy="19" r="6" fill="{col}"/>')
    s.append(f'<text x="{width/2}" y="24" font-size="13" fill="{TITLEFG}" '
             f'text-anchor="middle" font-weight="500">{html.escape(title)}</text>')
    y = BAR_H + PAD_TOP + 4
    for line in lines:
        parts = spans(line)
        if parts:
            chunks = []
            for text, color, bold in parts:
                fill = color or (BOLD if bold else TXT)
                w = ' font-weight="700"' if bold else ""
                chunks.append(f'<tspan fill="{fill}"{w}>{html.escape(text)}</tspan>')
            s.append(f'<text x="{PAD_X}" y="{y}" font-size="{FS}" '
                     f'xml:space="preserve">{"".join(chunks)}</text>')
        y += LH
    s.append("</svg>")
    write("\n".join(s), out_name, width, height)


# ── living-diagram renderer (light, draw.io-style observation cards) ──
DG_BG, DG_CARD, DG_BORDER = "#eef0f3", "#ffffff", "#d7d9e0"
DG_TITLE, DG_WHY = "#1c1d22", "#6b6e78"
DG_FILES_BG, DG_FILES_BORDER, DG_FILE_TX = "#f5f6f8", "#e4e6eb", "#5a5d66"
ARROW = "#aab0bb"
TAGS = {
    "DECISION": ("#e7e9fb", "#3b40b8"),
    "DONE":     ("#e2f6ea", "#1f8a4c"),
    "GOTCHA":   ("#fdeede", "#b5650f"),
    "NOTE":     ("#eceef2", "#5a5d66"),
    "OPEN":     ("#fde9e9", "#c0392b"),
}


def card_height(c):
    if c["type"] == "banner":
        return 46
    h = 16 + 22 + 26 + 22 + 14
    if c.get("files"):
        h += 10 + 14 + len(c["files"]) * 20 + 10
    return h


def render_diagram(cards, out_name):
    W, CW = 580, 480
    CX = (W - CW) // 2
    GAP = 26
    top = 26
    total = top + sum(card_height(c) for c in cards) + GAP * (len(cards) - 1) + 24

    s = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{total}" '
         f'viewBox="0 0 {W} {total}" font-family="{SANS}">', shadow_defs()]
    s.append(f'<rect x="0" y="0" width="{W}" height="{total}" rx="10" fill="{DG_BG}"/>')
    cx = W / 2
    y = top
    for i, c in enumerate(cards):
        h = card_height(c)
        if c["type"] == "banner":
            s.append(f'<rect x="{CX}" y="{y}" width="{CW}" height="{h}" rx="9" '
                     f'fill="{RED}" filter="url(#cardsh)"/>')
            s.append(f'<text x="{cx}" y="{y+h/2+6}" font-size="18" fill="#fff" '
                     f'text-anchor="middle" font-weight="700" letter-spacing="0.5">'
                     f'{html.escape(c["text"])}</text>')
        else:
            s.append(f'<rect x="{CX}" y="{y}" width="{CW}" height="{h}" rx="9" '
                     f'fill="{DG_CARD}" stroke="{DG_BORDER}" filter="url(#cardsh)"/>')
            iy = y + 16
            s.append(f'<text x="{CX+20}" y="{iy+15}" font-size="15.5" fill="{DG_TITLE}" '
                     f'font-weight="700">{html.escape(c["title"])}</text>')
            iy += 22
            # tag pill
            tag = c["tag"]
            tbg, tfg = TAGS.get(tag, TAGS["NOTE"])
            pw = len(tag) * 7.6 + 20
            s.append(f'<rect x="{CX+20}" y="{iy+4}" width="{pw:.0f}" height="20" rx="6" fill="{tbg}"/>')
            s.append(f'<text x="{CX+20+pw/2:.0f}" y="{iy+18}" font-size="11" fill="{tfg}" '
                     f'text-anchor="middle" font-weight="700" letter-spacing="0.4">{html.escape(tag)}</text>')
            iy += 26
            s.append(f'<text x="{CX+20}" y="{iy+16}" font-size="13.5" fill="{DG_WHY}">'
                     f'{html.escape(c["why"])}</text>')
            iy += 22
            if c.get("files"):
                fb_h = 14 + len(c["files"]) * 20 + 8
                s.append(f'<rect x="{CX+20}" y="{iy+10}" width="{CW-40}" height="{fb_h}" rx="6" '
                         f'fill="{DG_FILES_BG}" stroke="{DG_FILES_BORDER}"/>')
                fy = iy + 10 + 18
                for fn in c["files"]:
                    s.append(f'<text x="{CX+34}" y="{fy}" font-size="12.5" fill="{DG_FILE_TX}" '
                             f'font-family="{MONO}">{html.escape(fn)}</text>')
                    fy += 20
        # arrow to next
        if i < len(cards) - 1:
            ay = y + h
            s.append(f'<line x1="{cx}" y1="{ay+4}" x2="{cx}" y2="{ay+GAP-4}" '
                     f'stroke="{ARROW}" stroke-width="2"/>')
            s.append(f'<path d="M{cx-5} {ay+GAP-9} L{cx+5} {ay+GAP-9} L{cx} {ay+GAP-2} Z" fill="{ARROW}"/>')
        y += h + GAP
    s.append("</svg>")
    write("\n".join(s), out_name, W, total)


# ── FRAMES (fictional demo data only) ─────────────────────────────────

render("myjarbis start", [
    "[d]$[/] [b]myjarbis start[/]",
    "",
    "[r]Your projects[/]",
    "",
    "  [b] 1[/])  api-server     [d]~/dev/api-server[/]",
    "  [b] 2[/])  web-client     [d]~/dev/web-client[/]",
    "  [b] 3[/])  mobile-app     [d]~/dev/mobile-app[/]",
    "  [b] 4[/])  blog-engine    [d]~/dev/blog-engine[/]",
    "  [b] 5[/])  data-pipeline  [d]~/dev/data-pipeline[/]",
    "  [b] 6[/])  landing-site   [d]~/dev/landing-site[/]",
    "",
    "  [r]Pick[/] (numbers like '1 3', or a name) [d][Enter to cancel][/]: [b]1 2[/]",
], "01-start-picker")

render("myjarbis start  ·  1 2", [
    "[r]myjarbis start[/] [d]·[/] launching (wt)",
    "",
    "  [b]api-server[/]  [d]~/dev/api-server[/]  [r]→[/] wt tab",
    "  [b]web-client[/]  [d]~/dev/web-client[/]  [r]→[/] wt tab",
    "",
    "  [g]✓[/] two tabs opened — claude + /jarbis in each",
], "02-start-launch")

render("● claude — api-server", [
    "[c]❯[/] [b]/jarbis[/]",
    "",
    "  [d]Called[/] myjarbis [d]·[/] current_project",
    "  [d]Called[/] myjarbis [d]·[/] list_modules",
    "",
    "[r]Project: api-server[/] — 5 modules",
    "",
    "  [b]1.[/] auth           [d]login, OAuth, token refresh[/]",
    "  [b]2.[/] billing        [d]subscriptions, invoices, Stripe[/]",
    "  [b]3.[/] notifications  [d]email + push delivery[/]",
    "  [b]4.[/] search         [d]full-text + filters[/]",
    "  [b]5.[/] _general       [d]default cross-cutting module[/]",
    "",
    "  Which module are we working on?",
], "03-jarbis-bootstrap")

render("myjarbis status", [
    "[r]MyJarbis[/] [d]·[/] [b]api-server[/] [d](laravel)[/]",
    "  Path          [d]~/dev/api-server[/]",
    "  Branch        [b]feature/auth-12-refresh[/]",
    "",
    "[r]Active module[/]",
    "  Name          [b]auth[/]",
    "  About         [d]login, OAuth, token refresh[/]",
    "",
    "[r]Counts[/]",
    "  Modules       5",
    "  Observations  128",
    "  Skills        [g]10 baselines materialized[/]",
    "  Sessions      [d]42 closed · 1 open[/]",
], "04-status")

render_diagram([
    {"type": "banner", "text": "auth"},
    {"type": "card", "title": "Pick Sanctum over Passport", "tag": "DECISION",
     "why": "Simpler token model — no OAuth server to run."},
    {"type": "card", "title": "AUTH-12 — Google OAuth callback", "tag": "DONE",
     "why": "Validate id_token, then link the local user.",
     "files": ["GoogleAuthController.php", "User.php", "routes/web.php"]},
    {"type": "card", "title": "redirect_uri must match Google exactly", "tag": "GOTCHA",
     "why": "Otherwise: 400 invalid_request on the callback."},
], "05-living-diagram")

print("done →", HERE)
