# MyJarbis — per-project orchestrator for Claude Code

> **Persistent memory + per-project workflow + scoped skills — one
> slash command, everything else conversational.**

MyJarbis turns Claude Code into a project-aware orchestrator: it
remembers what you decided, where you left off, and which workflow
applies for each vertical of the project — without dumping
everything into context every session.

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
  │     ├── sessions (lifecycle: start → save observations → end)
  │     │     └── observations (decisions, gotchas, progress)
  │     └── skills (module-level — only loaded when this module is active)
  └── skills (project-level — always loaded, the 10 baselines)
```

When you open Claude in a MyJarbis project, the SessionStart hook
asks which vertical you want to work on. **Only that module + the
project core get loaded.** Other modules stay out of context.

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
Languages: EN (default), ES (español rioplatense), PT (português)
  Language [EN/es/pt]: en

Personas:
  1=Concise (RTK / token-saving) — terse, no preamble
  2=Pair programmer — 1-line intent before each change (default)
  3=Mentor / Educational — WHAT/WHY/HOW/BENEFITS
  4=Critical reviewer — challenges your assumptions first
  Persona [1/2/3/4, default 2]: 2
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
  • backend, last session 2h ago
  • frontend (paused)

Pick a module to begin (e.g., "let's work on backend").

── Last "Retomar aquí" (backend, 2h ago) ──
PR #1234 merged to develop. Next session: start AUTH-12 with the
JWT refresh flow. Branch: feature/auth-12-refresh-jwt.
```

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
| "let's switch to frontend"                         | confirm + end_session + start_session(frontend)  |
| "where was I?"                                     | resume() — reads back the "Retomar aquí"         |
| "before compacting"                                | save_observation(pre-compact) → you /compact     |
| "done, close it"                                   | confirm summary + next_session + end_session     |

The next `/jarbis` resumes where you left off.

---

## The single slash command

```
/jarbis
```

That's all. **There is no** `/plan`, `/implement`, `/complete`,
`/module`, `/skill`, `/resume`, `/import`, `/compact`. The agent
infers all of those from natural language thanks to the 10 baseline
skills loaded automatically at session start.

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

- **SessionStart (startup|clear)** → module menu + auto-start if
  there's only one + materialize skills + surface "Retomar aquí"
- **SessionStart (compact)** → bring the pre-compact snapshot back
  to the resumed context + recovery imperative
- **UserPromptSubmit** → first message forces ToolSearch for MyJarbis
  tools + detects localId regex (story_pattern) + 15-min reminder
  if no save_observation
- **Stop** → if there's an open session, reminds you to close it

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
│  Discovery:  current_project, list_modules, create_module       │
│  Session:    start_session, end_session, resume                 │
│  Read/Write: load_project_core, load_module, search,            │
│              save_observation                                   │
│  Skills:     list_skills, add_skill, materialize_skills         │
│  Bootstrap:  import_md, import_json                             │
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
  same context + skills
- `shared: false` (default) → `.gitignore`d, personal context + skills

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

## Migrating from v0.1

If you were on v0.1 (no memory.db, everything in
`.myjarbis/context/*.md`), opening Claude in the project migrates
automatically:

- `knowledge-base.md` → observations under module `_general`
- `daily.md` → module_context (workflow)
- `project-summary.md` → project_context (functional_spec)
- `prompts/system.md` → project_context (convention)
- 10 baselines seeded

Auto-backup at `~/.myjarbis-global/backups/<project>/<ts>/`. Legacy
aliases (`search_code`, `get_context`, `update_memory`) still work.

---

## Bash CLI (setup / admin, outside Claude)

```bash
myjarbis init                       # init project (interactive)
myjarbis doctor                     # health check (25+ probes)
myjarbis stats                      # row counts per table
myjarbis list                       # registered projects
myjarbis update                     # pull + rebuild MCP server

myjarbis module add <name> [--description=...]
myjarbis module list

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
  }
}
```

---

## Tests

```bash
tests/bootstrap-prolicht.sh    # 12 .md + 1 JSON bulk import idempotency
tests/skills-lifecycle.sh      # baselines + module-level + cleanup on switch
tests/full-session-cycle.sh    # open → work → close → reopen → resume
tests/compact-cycle.sh         # snapshot pre/post /compact roundtrip
```

---

## License

MIT.

— Built by Braian Axel Troncoso 🇦🇷.
