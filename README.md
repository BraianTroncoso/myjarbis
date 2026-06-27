# MyJarbis — per-project orchestrator for Claude Code

> **Persistent memory + per-project workflow + scoped skills — one
> slash command, everything else conversational.**

MyJarbis is a **persistent-memory layer over MCP (Model Context
Protocol)**. Today it's optimized for Claude Code as the harness, but
because every read/write goes through standard MCP tools + a local
SQLite database, **any MCP-compatible client** (Cursor, OpenClaw,
future agents) can sit on top of the same memory. The architecture is
also designed so mechanical tasks (classifying observations, expanding
search queries) can later be delegated to a **local open-weight model**
(e.g. Hermes via Ollama) for zero-cost token savings, keeping the
primary model for high-quality reasoning.

It turns Claude Code into a project-aware orchestrator: it remembers
what you decided, where you left off, and which workflow applies for
each vertical of the project — without dumping everything into context
every session.

```
cd ~/dev/<project>
claude
> /jarbis
```

That's it. After that, you talk in natural language.

---

## Why this exists

Claude Code on its own has no project memory. You repeat conventions,
re-explain architecture, lose "what was I doing yesterday." Existing
memory tools fix the persistence problem but treat memory as a flat
bag.

In real projects, work is **vertical**. You don't work on "the
codebase"; you work on the Media Manager, then on Page Builder, then
on Translations. Each vertical has its own workflow, plan, stories,
and skills.

MyJarbis models that explicitly:

```
project
  ├── project_context (practices, deps, conventions, specs — always loaded)
  ├── modules (verticals — you create them)
  │     ├── module_context (workflow, plan, stories, AC of the vertical)
  │     │     └── progress  (★ relational state — per-row "Smoke / Commit"
  │     │                     column updated by the agent as work happens)
  │     ├── sessions (lifecycle: start → save observations → end)
  │     │     └── observations (decisions, gotchas, progress)
  │     └── skills (module-level — only loaded when this module is active)
  └── skills (project-level — always loaded, the 10 baselines)
```

When you open Claude in a MyJarbis project, the SessionStart hook
asks which vertical you want to work on. **Only that module + the
project core get loaded.** Other modules stay out of context.

`start_session` returns an **index** of the active module (excerpts +
story localIds + progress flags), not the full bodies — the agent
fetches details on demand via `search` + `load_module(row_ids=[...])`.
A `previousSession.nextSession` field holds the curated "Resume here"
text, equivalent to a hand-edited CURRENT.md that lives in the DB
instead of on disk.

---

## Install

```bash
git clone https://github.com/braiantroncoso/myjarbis.git
cd myjarbis
./install.sh
```

This installs to `~/.myjarbis-global/`, builds the MCP server (Node
+ better-sqlite3 + FTS5), adds `myjarbis` to your PATH, and
configures the Claude Code MCP layer.

Verify: `myjarbis doctor` should print 25+ green checks.

---

## Bootstrap a project

```bash
cd ~/projects/my-app
myjarbis init                          # creates memory.db + 10 baselines + plugin hooks
```

`myjarbis init` is **interactive** — it asks two questions to
personalize how Claude talks back:

```
Languages: EN (United States), ES (Argentina), PT (Brazil)
  Language [EN/es/pt]: en

Personas:
  1=Concise (RTK / token-saving) — terse, no preamble (default)
  2=Pair programmer — 1-line intent before each change
  3=Mentor / Educational — WHAT/WHY/HOW/BENEFITS
  4=Critical reviewer — challenges your assumptions first
  Persona [1/2/3/4, default 1]: 1
```

Your answer composes the `interaction-style` skill so the agent
respects your tone + language from the first message.

To skip prompts (CI / scripts):

```bash
MYJARBIS_LANGUAGE=ES MYJARBIS_PERSONA=concise myjarbis init
```

Then create your verticals:

```bash
myjarbis module add backend
myjarbis module add frontend
```

And import the .md files you already keep on disk (the ones you
fill out by hand today):

```bash
# Project-level
myjarbis import agents/WORKFLOW.md   --target=project       --kind=workflow
myjarbis import agents/PRACTICES.md  --target=project       --kind=practice

# Module-level
myjarbis import agents/backend/WORKFLOW.md --target=module:backend --kind=workflow
myjarbis import agents/backend/PLAN.md     --target=module:backend --kind=plan

# Bulk JSON (Jira, Linear, etc.)
myjarbis import agents/backend/Jira.json \
  --target=module:backend --kind=story --mapping='stories[]'
```

Re-imports are **idempotent** (SHA-256 hash on content): unchanged →
no-op, changed → in-place UPDATE.

---

## Daily flow

```bash
cd ~/projects/my-app
claude
> /jarbis
```

The SessionStart hook fires and you'll see something like:

```
═══ MyJarbis · my-app (laravel) ═══

Modules:
  • backend, last session 2026-05-04 14:30 UTC
  • frontend (paused)

Pick a module to begin (e.g., "let's work on backend").
Or create a new one: `myjarbis module add <name>`.
Or change settings (language / persona): say "settings".

── Last "Retomar aquí" (backend, 2026-05-04 14:30 UTC) ──
PR #1234 merged to develop. Next session: start AUTH-12 with the
JWT refresh flow. Branch: feature/auth-12-refresh-jwt.
```

The menu **always shows up** — even with a single module — so you can
switch verticals, create a new one, or change settings without
leaving Claude. Timestamps are absolute ISO, not relative, so the
hook output is byte-stable and Anthropic's prompt cache survives
between calls.

You say *"let's work on backend"* → the agent calls
`start_session("backend")`. It now has project_core + backend
context + the previous `next_session`. Skills are materialized to
`.claude/skills/myjarbis-*/` — **only the 10 baselines + the
module-level skills of backend**. Frontend's skills are not on disk.

From here on, **everything is natural language.** The agent knows
which MCP tool to call thanks to the `/jarbis` prompt + the 10
baseline skills:

| You say…                                          | Agent does                                       |
|----------------------------------------------------|--------------------------------------------------|
| "let's work on AUTH-12"                            | search story + audit AC + propose phase          |
| "let's plan the refresh flow"                      | Analysis phase (no code yet)                     |
| "do it" / "implement it"                           | Implementation phase + auto-save decisions       |
| "I decided to use Laravel Sanctum"                 | save_observation(kind=decision)                  |
| "heads up, refresh tokens need to revoke access"   | save_observation(kind=gotcha)                    |
| "commit this"                                      | git commit with WHY/FOR-WHAT body, no signature  |
| "mark AUTH-12 as done with commit abc"             | update_progress (row-level state, not MD edit)   |
| "update the docs / log the smokes"                 | update_progress per affected story               |
| "let's switch to frontend"                         | confirm + end_session + start_session(frontend)  |
| "where was I?"                                     | resume() — reads back the "Retomar aquí"         |
| "settings" / "change persona"                      | set_interaction_style({language?, persona?})     |
| "before compacting"                                | save_observation(pre-compact) → you /compact     |
| "done, close it"                                   | confirm summary + next_session + end_session     |

The next `/jarbis` resumes where you left off.

---

## CLI-driven workflow (git-like)

`/jarbis` is fast when the agent doesn't have to discover or render a
menu — it just continues with what's already set. The CLI handles
setup and switching, like `git checkout`:

```bash
cd ~/dev/my-app
myjarbis module use backend       # set active module — instant
claude                            # SessionStart hook auto-resumes backend
                                  # printing the curated "Resume here"
> /jarbis                         # agent acknowledges and continues
                                  # no tool calls, no 1000-token menu
```

All CLI commands render with a **blood-red minimal UI** matching the
installer (consistent palette across `install.sh`, `myjarbis init`,
`myjarbis doctor`, `myjarbis status`, etc.). Output is human-friendly
by default; pass `--json` for machine-readable JSON.

```text
$ myjarbis status

MyJarbis · my-app (laravel)
  Path          /home/dev/my-app
  Branch        feature/auth-12-refresh · 2 ahead of origin

Active module
  Name          auth                                            ← red bold
  About         Authentication — login, OAuth, token refresh
  Last close    2026-05-04 21:19 UTC

  "Resume here" excerpt:
    ## auth at 2026-05-04 — AUTH-12 refresh flow scaffolded
    **Branch**: `feature/auth-12-refresh` (ahead 2 commits of origin)
    ...

Counts
  Modules       2
  Project ctx   16 entries
  Module ctx    157 entries · 152 stories (18 with progress)
  Observations  12
  Skills        10 baselines materialized
  Sessions      4 closed · 14 total
```

```text
$ myjarbis module list

MyJarbis · modules of my-app
  ★ auth      Authentication — login, OAuth, token refresh         ← ★ red
    _general  Default cross-cutting module

  Active: auth  ·  /jarbis will resume this module.
```

```text
$ myjarbis module current
★ auth
```

```text
$ myjarbis config list

MyJarbis · config of my-app
  Language      ES
  Persona       concise
  Shared        false
  Scope         module
  Stories       [A-Z]+-S?\d+(\.\d+)?

  Change with: myjarbis config language <EN|ES|PT>
              · myjarbis config persona <concise|pair|mentor|reviewer>
```

All CLI verbs (all instant, zero LLM tokens):

```bash
myjarbis module list              # show modules with ★ on active
myjarbis module use backend       # set active (writes .myjarbis/active)
myjarbis module current           # print active module
myjarbis module unset             # clear → next /jarbis shows menu
myjarbis module create payments   # create new module (alias of `module add`)

myjarbis config list              # language, persona, scope, nudges
myjarbis config language EN       # recompose interaction-style + materialize
myjarbis config persona mentor    # change persona

myjarbis status                   # full overview (project, active, counts, git)
myjarbis status --json            # same, JSON for scripts
```

`.myjarbis/active` is a single-line file (the module name) — always
git-ignored, even with `shared: true`, since it's per-user state.

If you don't want a pre-set module, omit `myjarbis module use` and the
hook falls back to printing the module menu. Both flows coexist.

---

## Per-row state (the `progress` field)

When you work with hand-edited PROGRESS.md tables, each story row has
a "Smoke" column, a "Commit" column, a "Status" column. Those are
**per-row state**: relational data that lives next to the row it
describes.

MyJarbis ships the same primitive in the DB. Every `module_context`
row (typically a story) has a free-form markdown `progress` field
the agent maintains via `update_progress(local_id, progress_text)`:

```
"mark MM-S3.6 as done with commit abc1234, smoke OK"
  ↓
update_progress(
  local_id = "MM-S3.6",
  progress = "✅ done batch 2 (2026-05-04) · commit abc1234 · smoke OK"
)
```

The `progress` text travels with the row in `start_session`, `search`,
and `load_module` — so the next `/jarbis` already sees which stories
are done, in progress, or blocked, without reading any MD.

This is the direct DB equivalent of your `Edit PROGRESS.md` workflow:

| MD workflow                            | MyJarbis equivalent                          |
|----------------------------------------|----------------------------------------------|
| Edit PROGRESS.md "Smoke" column        | `update_progress(local_id, "✅ done · ...")` |
| Edit CURRENT.md rolling summary        | `end_session(summary, next_session)`         |
| Edit ERRORS.md new lesson              | `save_observation(kind=gotcha, ...)`         |
| Read CURRENT.md at start of next day   | `previousSession.nextSession` in `start_session` |

---

## RAG-style context loading

`start_session` does **not** dump the full module library. It returns:

- `previousSession.nextSession` — the curated "Resume here" (read first)
- `projectContext[]` and `moduleContext[]` — index entries with title +
  240-char excerpt + `progress` flag
- `stories: { count, entries: [{localId, progress?}] }` — story
  inventory with no body

When the agent needs the full content of a specific row, it follows
the canonical RAG pattern:

```
1. search(query, scope="module")          # FTS5 snippets with row IDs
2. load_module(row_ids=[<id>])            # full body of just those rows
```

`load_module(kinds=[...])` returns **excerpts by default** (index mode).
`full=true` is opt-in and warns when the dump exceeds 50KB. This
keeps the agent from accidentally loading 100KB+ of PROGRESS.md +
WORKFLOW.md + functional docs into one tool call.

---

## The single slash command

```
/jarbis
```

That's all. **There is no** `/plan`, `/implement`, `/complete`,
`/module`, `/skill`, `/resume`, `/import`, `/compact`. The agent
infers all of those from natural language thanks to the 10 baseline
skills loaded automatically at session start.

The slash prompt itself ships in **three language variants** —
`jarbis.es.md`, `jarbis.en.md`, `jarbis.pt.md`. `myjarbis init`
copies the one matching your `MYJARBIS_LANGUAGE` choice to
`.claude/commands/jarbis.md`. Each project loads only its variant —
no token cost for the languages you don't use.

## Changing settings inline (without leaving Claude)

Say "settings" / "cambiar estilo" / "change language" at any point
and the agent calls `set_interaction_style({language?, persona?})`:

```
You: settings
Agent: Current — language: ES, persona: Concise.
       Options: language=EN/ES/PT, persona=concise/pair/mentor/reviewer.
You: persona mentor
Agent: [calls set_interaction_style({persona: "mentor"})]
       Updated. Applies from my next response.
```

The skill is recomposed via `composeInteractionStyle` (same function
`myjarbis init` uses) and re-materialized to disk. To refresh the
loaded skill in the running Claude Code session, close and reopen.

---

## The 10 baseline skills

Every `myjarbis init` ships these. They get materialized to
`.claude/skills/myjarbis-<name>/SKILL.md` and Claude loads them at
session start.

| Skill                  | What it teaches the agent                                    |
|------------------------|--------------------------------------------------------------|
| `module-orchestration` | How to pick/switch modules + conversational triggers         |
| `session-protocol`     | When to close a session + summary + next_session format      |
| `observation-protocol` | When to save decision/gotcha/progress + natural triggers     |
| `story-driven`         | Pipeline detect → audit → execute → close, by phases         |
| `bitacora-progress`    | How to write a "next_session" that helps tomorrow            |
| `framework-detect`     | Auto-explore the codebase on the first session               |
| `subagent-delegation`  | When to spawn Explore/Plan/general-purpose in parallel       |
| `compact-protocol`     | Structured snapshot before native `/compact`                 |
| `interaction-style`    | Your tone / language / depth / verbosity (composed at init)  |
| `commit-hygiene`       | Commit format + git log as queryable context                 |

Two worth highlighting:

**`commit-hygiene`** — every commit in any project follows:

```
<type>(<scope>): <imperative description, ≤72 chars>

Por qué:
<2-4 lines: motivation / problem>

Para qué:
<2-4 lines: what changes / what's enabled>
```

No `Co-Authored-By: Claude`, no `--no-verify`, no `git add -A`.
**Insight:** the git log becomes queryable memory — before asking
"why was X done?", the agent runs `git log --grep` or `git log -- <path>`
first.

**`interaction-style`** — composed at `myjarbis init` from your
language + persona choice. You can also re-edit any time:

```bash
myjarbis skill edit interaction-style
```

The 4 personas:

- **Concise (RTK)** — no preamble, ≤2-3 sentences, code = diff only.
- **Pair programmer** — 1-line intent before each change, trade-offs
  if multiple approaches.
- **Mentor** — WHAT/WHY/HOW/BENEFITS for every implementation.
- **Critical reviewer** — challenges assumptions first, doesn't just
  obey.

---

## Custom skills (when a project needs its own)

Any project can add its own skills, project-level or module-level:

```bash
# project-level (always active in this project)
myjarbis skill add jira-rules --content-from=docs/jira-rules.md \
  --description="JIRA tracking rules for this project"

# module-level (only active when working on MM)
myjarbis skill add mm-pixel-perfect --module=MM \
  --content-from=docs/mm-pixel-perfect.md \
  --description="MM: copy HTML from design package, NEVER reinterpret"
```

When you `start_session(MM)`, the MM module-level skills get
materialized to `.claude/skills/`. When you switch modules, those
disappear from the filesystem and the new module's appear.

---

## What hooks do automatically

`.claude-plugin/hooks/hooks.json` registers 4 events. You don't
invoke them — Claude Code does:

- **SessionStart (startup|clear)** → has TWO modes:
  - If `.myjarbis/active` is set (via `myjarbis module use <name>`),
    auto-starts that module's session, materializes its skills, and
    prints the curated `previousSession.nextSession` directly. /jarbis
    then only acknowledges and continues — no tool calls, no menu
    rendering, no agent reasoning.
  - If no active module, prints the localized module menu (numbered
    list with descriptions, options for `new module X` / `settings`)
    and the most-recent "Retomar aquí" across modules. The agent
    parses the user's reply.
  Output is **byte-stable across runs** (uses ISO timestamps, not
  "2h ago") so Anthropic's prompt cache survives.
- **SessionStart (compact)** → bring the pre-compact snapshot back
  to the resumed context + recovery imperative
- **UserPromptSubmit** → first message forces ToolSearch for MyJarbis
  tools + detects localId regex (story_pattern). The save_observation
  reminder is **opt-in** via `settings.nudges.save_reminder_minutes`
  (default off, hour-bucketed when on, also cache-stable).
- **Stop** → if there's an open session, reminds you to close it

### Optional: git `post-commit` hook (opt-in per project)

Run once per project:

```bash
myjarbis hook install git-post-commit
```

This drops a tiny `.git/hooks/post-commit` script that, on every
commit while a session is open in the active module, persists a
`progress` observation tagged `auto,git-post-commit`. The observation
captures the commit hash, full message, files changed, and the
detected `story_local_id` (matched via the project's `story_pattern`
regex against branch name + commit message). Silently no-ops when
no session is open. Idempotent: re-running the hook on the same HEAD
does not duplicate the observation. Kills the "I forgot to save that
decision" problem.

### Stale-resume warning

When `start_session` finds a `previousSession.nextSession` older than
**7 days** (configurable via `session.stale_after_days` in
`settings.json`), it sets `previousSession.stale = true` and the
SessionStart hook surfaces a clear warning to confirm the context still
applies (branches merged, PRs landed, decisions reversed) before the
agent proceeds. Prevents stale-autopilot mistakes after long breaks.

---

## Living diagrams

Documentation that **draws itself while you work.** Every module gets a
draw.io diagram that is a *view* of its memory — you never draw it by
hand. You code, you tell MyJarbis what you did (the same
`save_observation` you already do), and the diagram redraws itself.

By default it stays out of your way: run `myjarbis diagram` whenever you
want to (re)generate and open the active module's diagram. Prefer it to
follow along automatically? Opt in with `myjarbis config diagram on` and
it stays in sync — the SessionStart hook opens it, every
`save_observation` / `update_progress` regenerates it, and the Stop hook
refreshes it on the way out. Install the
[Draw.io Integration](https://marketplace.visualstudio.com/items?itemName=hediet.vscode-drawio)
VS Code extension and the `.drawio` renders right inside the editor.

It reads top-to-bottom as a **narrative of the work**: one collapsible
card per observation — its title, a kind tag, the "why", and the files
it touched nested inside — chained with arrows in the order things
happened. Minimalist on purpose: white cards, thin borders, a single
accent on the banner; meaning comes from the text, not a rainbow of
colours.

```text
        ┌───────────────────────────────────────────────┐
        │                  auth                          │   ← module banner
        └───────────────────────────────────────────────┘
                              │
        ┌───────────────────────────────────────────────┐
        │ Pick Sanctum over Passport                     │
        │ DECISION                                       │   ← kind tag
        │ Simpler token model, no OAuth server needed.   │   ← the "why"
        └───────────────────────────────────────────────┘
                              │
        ┌─[–]───────────────────────────────────────────┐
        │ AUTH-12 — Google OAuth callback                │
        │ DONE · validate id_token, link the local user  │
        │   ┌─────────────────────────────────────────┐  │
        │   │ GoogleAuthController.php                 │  │   ← files inside,
        │   │ User.php                                │  │     name only,
        │   │ routes/web.php                          │  │     full path on hover
        │   └─────────────────────────────────────────┘  │
        └───────────────────────────────────────────────┘
                              │
        ┌───────────────────────────────────────────────┐
        │ redirect_uri must match Google exactly         │
        │ GOTCHA · 400 invalid_request otherwise         │
        └───────────────────────────────────────────────┘
```

The tag is the observation `kind`, so the taxonomy you already use to
save work is the taxonomy you see:

| kind        | tag        | when you use it                         |
|-------------|------------|-----------------------------------------|
| `progress`  | `DONE`     | a story / milestone closed              |
| `decision`  | `DECISION` | an approach or library was chosen       |
| `gotcha`    | `GOTCHA`   | a non-obvious lesson worth keeping      |
| `discovery` | `NOTE`     | something learned about the codebase    |
| `error`     | `OPEN`     | an unresolved issue                     |

```bash
myjarbis diagram                # (re)generate + open the active module's diagram
myjarbis diagram <module>       # a specific module
myjarbis config diagram on      # opt in to auto-generate/open (default off)
```

Diagrams are written to `<project>/.myjarbis/diagrams/<module>.drawio`,
generated deterministically and idempotently (identical content is never
rewritten). Each file node shows its full project path in a tooltip;
copy it + `Ctrl+P` to jump to the file.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CLAUDE CODE (harness)                                          │
│  • hooks  • /jarbis (only one)  • skills loaded from .claude/   │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  MCP SERVER (Node/TS, ~/.myjarbis-global/mcp-server/)           │
│  ── Always-loaded (session-critical, in system prompt) ──       │
│  Discovery:  current_project, list_modules                      │
│  Session:    start_session, end_session, resume                 │
│  Read/Write: load_project_core, load_module, search,            │
│              save_observation, update_progress                  │
│  ── Deferred (loaded on-demand via ToolSearch) ──               │
│  Admin:      create_module, list_skills, add_skill,             │
│              materialize_skills, import_md, import_json,        │
│              set_interaction_style                              │
│  Legacy:     search_code, get_context, update_memory            │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  SQLite (.myjarbis/memory.db) — better-sqlite3 + FTS5           │
│  projects → project_context · modules · skills                  │
│  modules → module_context · sessions → observations             │
└─────────────────────────────────────────────────────────────────┘
```

Each project has its own `memory.db`. Per-project decision:

- `shared: true` → committed to the repo, the whole team loads the
  same context + skills. **Heads up**: observations may carry tokens,
  URLs, or paths — `myjarbis init --shared=true` warns explicitly.
- `shared: false` (default) → `.gitignore`d, personal context + skills

---

## Token economy

MyJarbis is opinionated about every token Claude reads. Five levers:

1. **Per-module loading** — only the active module + project core ride
   the system prompt. Other verticals stay out.
2. **Index by default** — `start_session` and `load_module` return
   excerpts (~240 chars) + indexes. Full bodies arrive only via
   `load_module(row_ids=[...])` after a `search` snippet identifies
   what's relevant (RAG pattern).
3. **Cache-stable hooks** — SessionStart and UserPromptSubmit emit
   byte-deterministic output so Anthropic's prompt cache survives
   between turns. No "2h ago" labels, no per-minute timers.
4. **Deferred admin tools** — 9 of 18 MCP tools are marked `deferred`,
   so their schemas don't ride the system prompt unless invoked.
   ~600-1200 tokens saved per session.
5. **Trilingual `/jarbis`** — each project loads only the variant of
   its language. EN-only users don't pay for ES/PT examples.

Measure the impact with `myjarbis cost`:

```bash
myjarbis cost                  # tokens + cache hit ratio per session, USD approx
myjarbis cost --last=5         # just the last 5
myjarbis cost --json           # machine-readable
```

It parses Claude Code's `~/.claude/projects/<slug>/*.jsonl` and prints:

```
session   when              model     msgs  in    cache_r  cache_c  out    hit  cost
--------  ----------------  --------  ----  ----  -------  -------  -----  ---  ------
16169e9d  2026-05-04 04:02  opus-4-7  946   5.8K  496.47M  15.80M   1.59M  97%  $1160.00

Cache   hit ratio 97%  (>80% healthy, <50% something is busting it)
```

Hit ratio above ~80% means the cache is working. Below ~50% means a
hook or tool is emitting variable content that breaks reuse.

---

## Scoped search

`search` is FTS5 over project_context, module_context, skills, and
observations. Scopes:

- `module` (default): active module + project_core. **Token-saving.**
- `project`: every module of this project + project_core
- `module_only`: only the active or named module
- `observations`: only the session log
- `skills`: only skill content

The `module` default is the key difference: with 5 indexed modules,
the agent only sees hits from the one you're in, not the other 4.

---

## Migrations

**v0.1 → v0.2** (markdown → SQLite). If you were on v0.1, opening
Claude in the project migrates automatically:

- `knowledge-base.md` → observations under module `_general`
- `daily.md` → module_context (workflow)
- `project-summary.md` → project_context (functional_spec)
- `prompts/system.md` → project_context (convention)
- 10 baselines seeded

Auto-backup at `~/.myjarbis-global/backups/<project>/<ts>/`. Legacy
aliases (`search_code`, `get_context`, `update_memory`) still work.

**Schema versioning** (v2 → v3 and beyond). `MyJarbisDB.open()` reads
`meta.schema_version` and walks `MIGRATIONS[v]` from `current+1` up to
`SCHEMA_VERSION`. Each step is idempotent (duplicate-column errors are
tolerated). v3 added `module_context.progress` for relational per-row
state — opening any v2 DB at runtime upgrades it in place without
re-import.

---

## Bash CLI (setup / admin, outside Claude)

```bash
myjarbis init                       # init project (interactive)
myjarbis doctor                     # health check (25+ probes)
myjarbis status                     # git-like overview: project, active module, last session, counts
myjarbis timeline <module>          # chronological feed of sessions + observations (--json, --limit=N)
myjarbis stats                      # row counts per table
myjarbis cost [--last=N] [--json]   # token usage + cache hit ratio + USD approx
myjarbis list                       # registered projects
myjarbis update                     # pull + rebuild MCP server
myjarbis hook install git-post-commit  # auto-save a progress observation on every commit

myjarbis module list                              # list with active marker
myjarbis module use <name>                        # set active (.myjarbis/active)
myjarbis module current                           # print active
myjarbis module unset                             # clear active
myjarbis module create <name> [--description=...] # alias of `module add`
myjarbis module add <name> [--description=...]    # original verb

myjarbis config list                              # all settings + inferred language/persona
myjarbis config language <EN|ES|PT>               # recompose interaction-style + materialize
myjarbis config persona <concise|pair|mentor|reviewer>

myjarbis skill add <name> --content-from=<file> [--module=...] [--description=...] [--trigger=...]
myjarbis skill list [--scope=all|project|module|session]
myjarbis skill edit <name> [--module=...]
myjarbis skill delete <name> [--module=...]
myjarbis skill enable|disable <name> [--module=...]
myjarbis skill materialize [--module=...]

myjarbis import <file.md>   --target=<project|module:NAME> --kind=<kind>
myjarbis import <file.json> --target=... --kind=<kind> --mapping='items[]'
                                                       [--id-field=...] [--title-field=...]
```

`myjarbis init` flags (override the interactive prompts):

```bash
myjarbis init                                       # interactive
MYJARBIS_LANGUAGE=PT MYJARBIS_PERSONA=mentor myjarbis init    # non-interactive
```

---

## Per-project settings

`.myjarbis/config/settings.json`:

```json
{
  "version": "0.2.0",
  "project": { "name": "my-app", "framework": "laravel" },
  "shared": false,
  "search_default_scope": "module",
  "story_pattern": "[A-Z]+-S?\\d+(\\.\\d+)?",
  "auto_module_select_when_single": true,
  "skills": {
    "materialize_on_session_start": true,
    "cleanup_module_skills_on_session_end": false
  },
  "nudges": {
    "save_reminder_minutes": null
  },
  "session": {
    "stale_after_days": 7
  },
  "diagram": {
    "auto": false
  }
}
```

`nudges.save_reminder_minutes`: when set to a positive integer N, the
UserPromptSubmit hook reminds the agent to call `save_observation` if
no observation has landed in the last N+ minutes. Default `null` keeps
the hook output cache-stable. When enabled, the check is hour-bucketed
so the output stays stable for an hour at a time.

`diagram.auto`: opt-in living diagram. Default `false` — the diagram is
only generated/opened when you run `myjarbis diagram`. Set to `true`
(or `myjarbis config diagram on`) to have session hooks,
`save_observation` and `update_progress` regenerate it and pop it open
in VS Code automatically.

---

## Tests

```bash
tests/bootstrap-import.sh      # 12 .md + 1 JSON bulk import idempotency
tests/skills-lifecycle.sh      # baselines + module-level + cleanup on switch
tests/full-session-cycle.sh    # open → work → close → reopen → resume
tests/compact-cycle.sh         # snapshot pre/post /compact roundtrip
tests/dx-batch-1.sh            # stale-resume + timeline + post-commit auto-observation
```

---

## License

MIT.

— Built by Braian Axel Troncoso 🇦🇷.
