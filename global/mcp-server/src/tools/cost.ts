/**
 * Cost tool — parse Claude Code's per-project jsonl logs and aggregate
 * token usage and cost per session.
 *
 * Path convention: Claude Code stores session logs at
 *   ~/.claude/projects/<cwd-with-slashes-replaced-by-dashes>/<sessionId>.jsonl
 *
 * Each .jsonl line is a JSON event. Assistant messages carry usage:
 *   { type: "assistant", timestamp, message: { model, usage: {
 *       input_tokens, cache_read_input_tokens,
 *       cache_creation_input_tokens, output_tokens } } }
 *
 * Cache hit ratio is the headline metric: cache_read / (input + cache_read
 * + cache_creation). Above ~80% means the prompt cache is working; below
 * ~50% something is busting it (the kind of thing P11.49 fixes).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface Usage {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

interface SessionAgg extends Usage {
  sessionId: string;
  startedAt: string | null;
  endedAt: string | null;
  messages: number;
  model: string;
  costUsd: number;
  cacheHitRatio: number;
}

interface ProjectAgg extends Usage {
  sessions: number;
  messages: number;
  costUsd: number;
  cacheHitRatio: number;
}

interface CostReport {
  projectPath: string;
  logsDir: string;
  sessions: SessionAgg[];
  totals: ProjectAgg;
}

// USD per million tokens. Update if Anthropic pricing changes.
interface ModelPricing {
  input: number;
  cacheRead: number;
  cacheCreation: number;
  output: number;
}

const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-7': { input: 15, cacheRead: 1.5, cacheCreation: 18.75, output: 75 },
  'claude-opus-4-6': { input: 15, cacheRead: 1.5, cacheCreation: 18.75, output: 75 },
  'claude-sonnet-4-6': { input: 3, cacheRead: 0.3, cacheCreation: 3.75, output: 15 },
  'claude-sonnet-4-5': { input: 3, cacheRead: 0.3, cacheCreation: 3.75, output: 15 },
  'claude-haiku-4-5': { input: 1, cacheRead: 0.1, cacheCreation: 1.25, output: 5 },
};

function pricingFor(model: string): ModelPricing | null {
  if (PRICING[model]) return PRICING[model];
  // strip date suffixes like -20251001
  const base = model.replace(/-\d{8}$/, '');
  return PRICING[base] ?? null;
}

function projectLogsDir(projectPath: string): string {
  const slug = projectPath.replace(/\//g, '-');
  return path.join(os.homedir(), '.claude', 'projects', slug);
}

function emptyUsage(): Usage {
  return { input: 0, cacheRead: 0, cacheCreation: 0, output: 0 };
}

function addUsage(target: Usage, src: Usage): void {
  target.input += src.input;
  target.cacheRead += src.cacheRead;
  target.cacheCreation += src.cacheCreation;
  target.output += src.output;
}

function ratio(u: Usage): number {
  const denom = u.input + u.cacheRead + u.cacheCreation;
  return denom === 0 ? 0 : u.cacheRead / denom;
}

function costOf(u: Usage, model: string): number {
  const p = pricingFor(model);
  if (!p) return 0;
  return (
    (u.input * p.input +
      u.cacheRead * p.cacheRead +
      u.cacheCreation * p.cacheCreation +
      u.output * p.output) /
    1_000_000
  );
}

function parseSessionFile(filePath: string): SessionAgg {
  const sessionId = path.basename(filePath, '.jsonl');
  const usage = emptyUsage();
  let messages = 0;
  let model = '';
  let startedAt: string | null = null;
  let endedAt: string | null = null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.timestamp) {
      if (!startedAt) startedAt = entry.timestamp;
      endedAt = entry.timestamp;
    }
    if (entry.type !== 'assistant' || !entry.message?.usage) continue;
    messages++;
    if (!model && entry.message.model) model = entry.message.model;
    const u = entry.message.usage;
    usage.input += u.input_tokens ?? 0;
    usage.cacheRead += u.cache_read_input_tokens ?? 0;
    usage.cacheCreation += u.cache_creation_input_tokens ?? 0;
    usage.output += u.output_tokens ?? 0;
  }

  return {
    sessionId,
    startedAt,
    endedAt,
    messages,
    model: model || 'unknown',
    ...usage,
    costUsd: costOf(usage, model),
    cacheHitRatio: ratio(usage),
  };
}

export interface CostOptions {
  last?: number;
  since?: string; // ISO date — only sessions whose endedAt is >= since are included
}

export function computeCost(projectPath: string, opts: CostOptions = {}): CostReport {
  const logsDir = projectLogsDir(projectPath);
  if (!fs.existsSync(logsDir)) {
    return {
      projectPath,
      logsDir,
      sessions: [],
      totals: { ...emptyUsage(), sessions: 0, messages: 0, costUsd: 0, cacheHitRatio: 0 },
    };
  }
  const files = fs
    .readdirSync(logsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => path.join(logsDir, f));

  let sessions = files.map(parseSessionFile).filter((s) => s.messages > 0);

  // newest first
  sessions.sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));

  if (opts.since) {
    sessions = sessions.filter((s) => (s.endedAt ?? '') >= opts.since!);
  }
  if (opts.last && opts.last > 0) {
    sessions = sessions.slice(0, opts.last);
  }

  const totals: ProjectAgg = {
    ...emptyUsage(),
    sessions: sessions.length,
    messages: 0,
    costUsd: 0,
    cacheHitRatio: 0,
  };
  for (const s of sessions) {
    addUsage(totals, s);
    totals.messages += s.messages;
    totals.costUsd += s.costUsd;
  }
  totals.cacheHitRatio = ratio(totals);

  return { projectPath, logsDir, sessions, totals };
}

// ─── formatting ─────────────────────────────────────────────────────

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtUsd(n: number): string {
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

function fmtTs(iso: string | null): string {
  if (!iso) return '-';
  // 2026-05-04T12:34:56.789Z → 2026-05-04 12:34
  return iso.slice(0, 16).replace('T', ' ');
}

export function formatTable(report: CostReport): string {
  const lines: string[] = [];
  lines.push(`Project  ${report.projectPath}`);
  lines.push(`Logs     ${report.logsDir}`);
  lines.push('');
  if (report.sessions.length === 0) {
    lines.push('No Claude Code sessions found for this project.');
    return lines.join('\n');
  }

  const header = ['session', 'when', 'model', 'msgs', 'in', 'cache_r', 'cache_c', 'out', 'hit', 'cost'];
  const rows = report.sessions.map((s) => [
    s.sessionId.slice(0, 8),
    fmtTs(s.endedAt),
    s.model.replace(/^claude-/, ''),
    String(s.messages),
    fmtTokens(s.input),
    fmtTokens(s.cacheRead),
    fmtTokens(s.cacheCreation),
    fmtTokens(s.output),
    fmtPct(s.cacheHitRatio),
    fmtUsd(s.costUsd),
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const fmtRow = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join('  ');
  lines.push(fmtRow(header));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push(fmtRow(r));

  lines.push('');
  const t = report.totals;
  lines.push(`Totals  ${t.sessions} sessions · ${t.messages} msgs`);
  lines.push(
    `Tokens  in=${fmtTokens(t.input)} cache_read=${fmtTokens(t.cacheRead)} ` +
      `cache_create=${fmtTokens(t.cacheCreation)} out=${fmtTokens(t.output)}`,
  );
  lines.push(`Cache   hit ratio ${fmtPct(t.cacheHitRatio)}  (>80% healthy, <50% something is busting it)`);
  lines.push(`Cost    ${fmtUsd(t.costUsd)} approx`);

  return lines.join('\n');
}
