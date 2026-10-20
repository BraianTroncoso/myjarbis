/**
 * `commands sync` — the propagation path for slash commands.
 *
 * Slash commands live as files in each project's `.claude/commands/`, and
 * the only writer was `myjarbis init`. So adding or improving a command
 * reached new projects and nothing else — the same mirror problem that
 * `skill reseed` fixed for baseline skills, which is where that gap was
 * found. A command nobody can get is a command that does not exist: the
 * 23 projects already on this machine would never see `/jarbis-close`.
 *
 * Unlike skills, these are files on disk rather than rows, so the risk is
 * the opposite one: overwriting something the user edited by hand. There
 * is no history to tell a hand-edit from an old version, so anything that
 * matches no shipped template is reported as `diverged` and left alone
 * until `--force` says otherwise. Dry run is the default.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { readRegistry } from './org/registry.js';

/**
 * The commands that ship with MyJarbis.
 *
 * NAMING RULE: every one of them starts with `jarbis`. The slash menu is a
 * flat namespace shared with every other plugin the user has installed, so
 * the prefix is the only thing that says "this one is ours" at a glance —
 * the same job the `myjarbis-` prefix does for materialised skill folders.
 * A command called `close` would be indistinguishable from someone else's.
 * `tests/v04-commands-sync.sh` asserts the prefix, so a new command that
 * forgets it turns the suite red rather than shipping loose.
 *
 * Kept in step by hand with the `for cmd in ...` loop in bin/myjarbis-init
 * (step 4), which installs the same list at init time. The same test
 * asserts the two lists name the same commands, so adding one here and
 * forgetting there is caught too.
 */
export const SHIPPED_COMMANDS = ['jarbis', 'jarbis-close', 'jarbis-save'];

/** The prefix every shipped command must carry. See SHIPPED_COMMANDS. */
export const COMMAND_PREFIX = 'jarbis';

/** Languages each command ships in. */
export const COMMAND_LANGUAGES = ['es', 'en', 'pt'];

/**
 * `new`            — the project has no such command file yet.
 * `current`        — identical to the template for the project's language.
 * `other-language` — identical to another language's template, so it is
 *                    ours and only the language is wrong.
 * `old-shipped-version`
 *                  — byte-identical to a template this repository shipped at
 *                    some earlier commit. Ours, just stale, so it is updated
 *                    without `--force`.
 * `diverged`       — matches nothing we ship and nothing we ever shipped, so
 *                    somebody edited it. Needs `--force`.
 * `no-template`    — the install dir has no template for this command.
 */
export type CommandStatus =
  | 'new'
  | 'current'
  | 'other-language'
  | 'old-shipped-version'
  | 'diverged'
  | 'no-template';

export interface CommandFileResult {
  command: string;
  status: CommandStatus;
  /** Language whose template this file currently matches, when it matches one. */
  matched?: string;
  /** True when this run actually wrote the file. */
  written: boolean;
}

export interface CommandSyncProject {
  project: string;
  path: string;
  language: string;
  files: CommandFileResult[];
  error?: string;
}

export interface CommandSyncReport {
  applied: boolean;
  force: boolean;
  templatesRoot: string;
  projects: CommandSyncProject[];
}

export interface CommandSyncOptions {
  /** Project directories to visit. Defaults to the cwd only. */
  targets?: string[];
  /** Visit every registered project instead of the cwd. */
  all?: boolean;
  /** Write. Without this the report is a dry run. */
  apply?: boolean;
  /** Overwrite `diverged` files too. */
  force?: boolean;
}

/**
 * Where the templates live.
 *
 * MYJARBIS_INSTALL_DIR first, which is the same variable the hook scripts
 * read, so a dev checkout pointed at `<repo>/global` behaves like a real
 * install. Otherwise derive it from this file: the CLI being executed IS
 * the installation, at `<install>/mcp-server/build/commands.js`.
 */
export function templatesRoot(): string {
  const env = process.env.MYJARBIS_INSTALL_DIR;
  if (env) return path.join(env, 'templates');
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'templates');
}

function commandsDir(root: string): string {
  return path.join(root, '.claude', 'commands');
}

/**
 * The git checkout the templates came from, or null.
 *
 * Two shapes: a dev checkout pointed at `<repo>/global`, where the repo root is
 * two levels above the templates; and a real installation, where
 * `<install>/.source` records the checkout `update` pulls from. Returns null
 * when neither resolves to a git repository, which is the signal to fall back
 * to the pre-history behaviour rather than to guess.
 */
function sourceCheckout(templates: string): string | null {
  const candidates: string[] = [];

  const twoUp = path.resolve(templates, '..', '..');
  candidates.push(twoUp);

  try {
    const recorded = fs.readFileSync(path.resolve(templates, '..', '.source'), 'utf-8').trim();
    if (recorded) candidates.push(recorded);
  } catch {
    /* installs older than v0.3 never wrote .source */
  }

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
  }
  return null;
}

/** Git's object name for a file's contents: sha1 over `blob <len>\0<bytes>`.
 *  Computed here rather than shelling out to `git hash-object`, so comparing
 *  one file costs nothing. */
function blobSha(content: string): string {
  const bytes = Buffer.from(content, 'utf-8');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, 'utf-8'), bytes]))
    .digest('hex');
}

/**
 * Every version of the command templates this repository has ever shipped,
 * as a set of blob object names.
 *
 * WHY THIS EXISTS
 * ---------------
 * `diverged` meant "matches no template we currently ship", which conflates
 * two opposite situations: a file somebody hand-edited, and a file we shipped
 * ourselves two releases ago. The tool refused to touch either without
 * `--force`, which is correct for the first and useless for the second.
 *
 * It cost something real. A commit removed three live client identifiers from
 * the `/jarbis` template because they appeared in user-facing output of a
 * public repo. That fixed the repository and nothing else: 23 projects on disk
 * kept the old file, every one of them reported `diverged`, and the scrub read
 * as done in git while being undone everywhere it mattered. Finding out took
 * comparing all 23 copies against the template as it existed at several past
 * commits, by hand, to establish that `--force` was safe.
 *
 * An exact object-name match answers that question for free: a hand-edited
 * file cannot collide with a blob we actually shipped, so anything in this set
 * is ours and can be updated without asking. `--force` goes back to meaning
 * what it says — overwrite a file a human changed.
 *
 * Two git calls total, however many commits and languages there are:
 * `rev-list` for the commits that touched the templates, then one
 * `cat-file --batch-check` resolving every (commit, path) pair at once.
 */
function shippedHistory(templates: string): Set<string> {
  const known = new Set<string>();
  const repo = sourceCheckout(templates);
  if (!repo) return known;

  // Paths as the repository spells them, which is not how the install dir
  // does: templates live under global/ in the repo and at the top in an
  // installation.
  const relPaths: string[] = [];
  for (const command of SHIPPED_COMMANDS) {
    for (const lang of COMMAND_LANGUAGES) {
      relPaths.push(`global/templates/.claude/commands/${command}.${lang}.md`);
    }
  }

  try {
    const commits = execFileSync('git', ['rev-list', '--all', '--', ...relPaths], {
      cwd: repo,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    if (commits.length === 0) return known;

    const queries = commits.flatMap((c) => relPaths.map((p) => `${c}:${p}`)).join('\n');
    const out = execFileSync('git', ['cat-file', '--batch-check'], {
      cwd: repo,
      input: `${queries}\n`,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });

    // `<sha> blob <size>` for a path that existed in that commit, and
    // `<query> missing` for one that did not. Only the first shape matters.
    for (const line of out.split('\n')) {
      const m = /^([0-9a-f]{40}) blob \d+$/.exec(line.trim());
      if (m) known.add(m[1]);
    }
  } catch {
    // No git, a shallow clone, a checkout that moved. The caller degrades to
    // reporting `diverged`, which is what it did before this existed.
  }

  return known;
}

/** Template text for one command in one language, or null if absent. */
function readTemplate(root: string, command: string, lang: string): string | null {
  const p = path.join(commandsDir(root), `${command}.${lang}.md`);
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * The language a project renders its commands in.
 *
 * Mirrors the SessionStart hook: the field was added by v0.2 `init`, and
 * projects older than it have no language, which the rest of the system
 * reads as English.
 */
export function projectLanguage(projectPath: string): string {
  const p = path.join(projectPath, '.myjarbis', 'config', 'settings.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as { language?: unknown };
    const lang = typeof parsed.language === 'string' ? parsed.language.toLowerCase() : '';
    return COMMAND_LANGUAGES.includes(lang) ? lang : 'en';
  } catch {
    return 'en';
  }
}

export function syncCommands(opts: CommandSyncOptions = {}): CommandSyncReport {
  const root = templatesRoot();
  const apply = opts.apply === true;
  const force = opts.force === true;
  // Resolved once for the whole run: the git calls are the expensive part and
  // the answer is the same for every project.
  const history = shippedHistory(root);

  const targets = opts.targets ?? (opts.all ? readRegistry().map((e) => e.path) : [process.cwd()]);

  const projects: CommandSyncProject[] = [];

  for (const dir of targets) {
    const language = projectLanguage(dir);
    const entry: CommandSyncProject = {
      project: path.basename(dir),
      path: dir,
      language,
      files: [],
    };

    if (!fs.existsSync(path.join(dir, '.myjarbis'))) {
      entry.error = 'not a MyJarbis project';
      projects.push(entry);
      continue;
    }

    for (const command of SHIPPED_COMMANDS) {
      // The project's own language, falling back to ES exactly as init
      // does, so a missing variant degrades the same way in both paths.
      const wanted = readTemplate(root, command, language) ?? readTemplate(root, command, 'es');
      if (wanted === null) {
        entry.files.push({ command, status: 'no-template', written: false });
        continue;
      }

      const target = path.join(commandsDir(dir), `${command}.md`);
      let existing: string | null = null;
      try {
        existing = fs.readFileSync(target, 'utf-8');
      } catch {
        existing = null;
      }

      let status: CommandStatus;
      let matched: string | undefined;
      if (existing === null) {
        status = 'new';
      } else if (existing === wanted) {
        status = 'current';
      } else {
        // Compare against every language before calling it diverged: a
        // project whose language was switched holds our file, not a
        // hand-edited one, and must not need --force to be corrected.
        const hit = COMMAND_LANGUAGES.find((l) => readTemplate(root, command, l) === existing);
        if (hit) {
          status = 'other-language';
          matched = hit;
        } else if (history.has(blobSha(existing))) {
          // Ours, from an earlier release. Updating it is not overwriting
          // someone's work, it is finishing a propagation that stalled.
          status = 'old-shipped-version';
        } else {
          status = 'diverged';
        }
      }

      const shouldWrite =
        status === 'new' ||
        status === 'other-language' ||
        status === 'old-shipped-version' ||
        (status === 'diverged' && force);

      let written = false;
      if (apply && shouldWrite) {
        fs.mkdirSync(commandsDir(dir), { recursive: true });
        fs.writeFileSync(target, wanted, 'utf-8');
        written = true;
      }

      entry.files.push({ command, status, matched, written });
    }

    projects.push(entry);
  }

  return { applied: apply, force, templatesRoot: root, projects };
}

/** Files this run did act on, or would act on in a dry run. */
export function pendingFiles(p: CommandSyncProject, force: boolean): CommandFileResult[] {
  return p.files.filter(
    (f) =>
      f.status === 'new' ||
      f.status === 'other-language' ||
      f.status === 'old-shipped-version' ||
      (f.status === 'diverged' && force),
  );
}
