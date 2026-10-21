/**
 * The module menu, rendered once and used from two places.
 *
 * It is shown at SessionStart (as a one-line pointer) and in full when the
 * user actually asks — `/jarbis`, via `list_modules`. Both must print the
 * same block: the whole reason this is rendered server-side rather than
 * described to the agent in prose is that an agent rebuilding a menu from a
 * markdown spec spends ~28s of reasoning doing it (commit 190aef6). Two
 * renderers would reintroduce that for one of the two paths.
 */

/** Rows the renderer needs, kept narrow so callers can pass DB rows directly. */
export interface MenuModule {
  name: string;
  description: string | null;
  /** 'paused' gets a tag; anything else renders plain. */
  status?: string;
  /** ISO-ish timestamp of the module's last close, or null. */
  lastEndedAt?: string | null;
}

export interface MenuStrings {
  modules_label: (n: number) => string;
  paused_tag: string;
  no_sessions_tag: string;
  menu_actions: string;
}

/**
 * The menu's own strings, owned here and spread into the hook's table.
 *
 * Single source on purpose: the SessionStart pointer and `list_modules`
 * render the same block, and two copies of these four strings is exactly the
 * shape that lets one path quietly drift from the other — the same failure
 * that let `CLAUDE_HOOKS` and the hooks.json template disagree for months.
 */
export const MENU_I18N = {
  es: {
    modules_label: (n: number) => `Módulos (${n}) · ▸ = último trabajado`,
    paused_tag: ' (en pausa)',
    no_sessions_tag: 'sin sesiones',
    menu_actions:
      'nombre o número → arrancar · varios con coma → multi-módulo (el primero manda) · "nuevo módulo <name>" · "settings"',
  },
  en: {
    modules_label: (n: number) => `Modules (${n}) · ▸ = last worked in`,
    paused_tag: ' (paused)',
    no_sessions_tag: 'no sessions',
    menu_actions:
      'name or number → start · several comma-separated → multi-module (first one is primary) · "new module <name>" · "settings"',
  },
  pt: {
    modules_label: (n: number) => `Módulos (${n}) · ▸ = último trabalhado`,
    paused_tag: ' (em pausa)',
    no_sessions_tag: 'sem sessões',
    menu_actions:
      'nome ou número → começar · vários com vírgula → multi-módulo (o primeiro manda) · "novo módulo <name>" · "settings"',
  },
} as const;

export type MenuLang = keyof typeof MENU_I18N;

/** Falls back to English on anything unrecognised, like the hook does. */
export function menuStringsFor(language: string | undefined): MenuStrings {
  const raw = (language ?? 'en').toString().toLowerCase();
  if (raw === 'es' || raw === 'en' || raw === 'pt') return MENU_I18N[raw];
  return MENU_I18N.en;
}

/**
 * How much of a module's description the menu shows.
 *
 * The menu exists to pick a module, not to read about one. At 19 modules
 * averaging 376 characters, printing the whole field cost 7.1 KB — and the
 * agent's documented response to being handed that much was to go re-query
 * the database for what it already had. 100 chars is enough to tell two
 * verticals apart; `load_module` has the rest.
 */
export const MENU_DESC_LEN = 100;

/**
 * Collapse to one line, then clip to `n` visible characters.
 *
 * Collapse BEFORE measuring: doing it after slicing spends part of the
 * budget on whitespace that is then removed, so the result comes back
 * shorter than asked for.
 */
export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
}

/**
 * Render the numbered module list plus the actions line.
 *
 * `highlight` is the most recently worked module, MARKED rather than
 * reordered: alphabetical order is what makes a nineteen-item list
 * scannable, and hoisting one entry costs that for everyone else.
 *
 * Deliberately does NOT include a handoff. In this branch no module has been
 * chosen, so the newest "resume here" belongs to a module the user may not
 * pick — two kilobytes answering a question nobody asked.
 */
export function renderModuleMenu(
  modules: MenuModule[],
  t: MenuStrings,
  highlight: string | null,
  formatDate: (iso: string) => string,
): string {
  const lines: string[] = [t.modules_label(modules.length)];
  const width = Math.max(...modules.map((m) => m.name.length), 1);

  modules.forEach((m, idx) => {
    const mark = highlight === m.name ? '▸' : ' ';
    const num = `${idx + 1}.`.padStart(3);
    const pausedTag = m.status === 'paused' ? t.paused_tag : '';
    const sessionTag = m.lastEndedAt ? formatDate(m.lastEndedAt).slice(0, 10) : t.no_sessions_tag;
    const head = `${mark}${num} ${m.name.padEnd(width)}${pausedTag}  ${sessionTag}`;
    const desc = m.description ? `  ${clip(m.description, MENU_DESC_LEN)}` : '';
    lines.push(`${head}${desc}`);
  });

  lines.push('', t.menu_actions);
  return lines.join('\n');
}
