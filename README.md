# MyJarbis — per-project orchestrator for Claude Code

> **Persistent memory + workflow + skills, scoped per project and per module.**

MyJarbis turns Claude Code into a project-aware orchestrator: it
remembers what you decided, where you left off, and which workflow
applies — without dumping everything into context every session.

## Why this exists

Claude Code by itself has no project memory. You repeat conventions,
re-explain architecture, lose "what was I doing yesterday." Existing
memory tools fix the persistence problem but treat memory as a flat
bag.

In real projects, work is **vertical**. You don't work on "the codebase";
you work on the Media Manager, then on Page Builder, then on Translations.
Each vertical has its own workflow, plan, stories, and skills.

MyJarbis models that explicitly:

```
project
  ├── project_context (practices, deps, conventions, specs — load once)
  ├── modules (verticals — created explicitly)
  │     ├── module_context (workflow, plan, stories, AC of the vertical)
  │     ├── sessions (lifecycle: start → save observations → end)
  │     │     └── observations (decisions, gotchas, progress)
  │     └── skills (module-level — only loaded when this module is active)
  └── skills (project-level — always loaded)
```

When you open Claude in a MyJarbis project, the SessionStart hook
asks which module you're working on. Only that module's context +
project-level core gets loaded into the session — token-efficient
by design.

## Install

```bash
git clone https://github.com/braiantroncoso/myjarbis.git
cd myjarbis
./install.sh
```

This installs to `~/.myjarbis-global/`, builds the MCP server (Node
+ better-sqlite3 + FTS5), registers `myjarbis` in your PATH, and
configures Claude Code's MCP layer.

Verify: `myjarbis doctor` should print 20+ green checks.

## First project

```bash
cd ~/projects/my-app
myjarbis init                # creates .myjarbis/memory.db, seeds 9 baseline skills
myjarbis module add MM       # create your first vertical
```

Now bootstrap context from existing notes (the .md files you already
keep in `agents/` or wherever):

```bash
# Project-level docs
myjarbis import agents/WORKFLOW.md   --target=project --kind=workflow
myjarbis import agents/PLAN.md       --target=project --kind=plan
myjarbis import agents/ERRORS.md     --target=project --kind=error_log

# Module-level docs (MM)
myjarbis import agents/MM/WORKFLOW.md --target=module:MM --kind=workflow
myjarbis import agents/MM/PLAN.md     --target=module:MM --kind=plan

# Bulk JSON (e.g. Jira export)
myjarbis import agents/MM/Jira_Bulk.json \
  --target=module:MM --kind=story --mapping='stories[]'
```

Re-imports are **idempotent** (SHA-256 hash on content): unchanged
files are no-ops, edited files update the row in place.

## Daily flow

```bash
cd ~/projects/my-app
claude
```

The SessionStart hook fires:

```
═══ MyJarbis · my-app (laravel) ═══
Modules:
  • MM, last session 2h ago
  • PageBuilder (paused)

Pick a module to begin (e.g., "let's work on MM").

── Last "Retomar aquí" (MM, 2h ago) ──
PR #1234 mergeado a MediaManager. Próxima sesión: arrancar MM-S1.4
con la migración asset_translations. Branch suggerida:
feature/mm-e1-s1.4-asset-translations.
```

You say "let's work on MM" → the agent calls `start_session("MM")`.
It now has project core + MM context + the `next_session` from last
time. Skills are materialized to `.claude/skills/myjarbis-*/` —
**only the ones for project + MM**. Other modules' skills are not on
disk.

A partir de ahí, **todo es conversacional** — el agente sabe qué tools
MCP llamar gracias al prompt de `/jarbis` + las 9 skills baseline:

- "decidí usar Pest" → `save_observation(kind=decision)`.
- "encontré que MySQL 5.7 falla con JSON columns" → `save_observation(kind=gotcha)`.
- "vamos a tocar PageBuilder" → confirma + `end_session` + `start_session(PageBuilder)`.
- "MM-S1.4" → `search` + audit + propone phase breakdown.
- "dale, hacelo" → ejecuta + auto-save de decisions por commit.
- "listo, cerralo" → `save_observation(kind=progress)` + `end_session(summary, next_session)`.
- "donde estaba?" → `resume()`.
- "antes de compactar" → `save_observation(kind=discovery, tags=pre-compact)` + invocás `/compact`.

El próximo `/jarbis` resume desde donde quedaste.

## Skills, scoped

Skills are markdown files Claude Code loads at session start. In
MyJarbis they live in the DB and are materialized to
`<project>/.claude/skills/myjarbis-<name>/SKILL.md` based on which
module is active.

Two scopes:

- **Project-level** (`module_id IS NULL`): always loaded for this project.
- **Module-level** (`module_id` set): only loaded when that module
  is the active session.

Switching modules re-renders `.claude/skills/`: previous module's
skills are removed, new module's appear.

```bash
# Add a project-wide skill
myjarbis skill add commit-style --content-from=docs/commits.md

# Add a skill that only matters when working in MM
myjarbis skill add mm-pixel-perfect --module=MM --content-from=docs/mm-pixel.md

# List, edit, enable/disable
myjarbis skill list
myjarbis skill edit mm-pixel-perfect --module=MM
myjarbis skill disable commit-style
```

## El único slash command

```
/jarbis
```

Eso es todo. El comando hace el bootstrap completo (detecta proyecto,
lista módulos, pide elegir, abre `start_session`, materializa skills,
te muestra el "Retomar aquí") y después la interacción es 100%
conversacional. **No hay `/plan`, `/implement`, `/complete`, `/module`,
`/skill`, `/resume`, `/import`, `/compact` etc.** El agente sabe qué
hacer cuando le hablás en lenguaje natural gracias a las 9 skills
baseline que se cargan automáticamente.

Si querés ver/editar las skills (preferencias, workflow, triggers
conversacionales, etc.), usá el bash CLI:

```bash
myjarbis skill list
myjarbis skill edit interaction-style    # tus preferencias de tono/idioma/etc.
myjarbis skill edit story-driven         # workflow de stories del proyecto
```

## What the hooks do automatically

`.claude-plugin/hooks/hooks.json` registers 4 events:

- **SessionStart (startup|clear)** → menu + auto-start if 1 module
- **SessionStart (compact)** → recovery imperative after compaction
- **UserPromptSubmit** → first-message ToolSearch + story-id detect
  (regex `[A-Z]+-S?\d+(\.\d+)?` configurable) + 15-min save reminder
- **Stop** → reminds to close the session if one is open

You don't invoke them; Claude Code does. They inject text that the
agent reads as system context.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  CLAUDE CODE (harness)                                          │
│  • hooks  • slash commands  • skills loaded from disk           │
└────────────────────────────────┬────────────────────────────────┘
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│  MCP SERVER (Node/TS)                                           │
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

Each project has its own `memory.db`. The user decides per-project
whether it's `shared: true` (commit it, the whole team loads the
same context + skills) or `shared: false` (gitignored, personal).

## Search, scoped

`search` is FTS5 over project_context, module_context, skills, and
observations. Scopes:

- `module` (default): active module + project_core only — token-saving
- `project`: all modules of this project + project_core
- `module_only`: only the active/named module
- `observations`: only the session log
- `skills`: only skill content

Token saving is the point: with 5 modules and FTS5 over each, the
default `module` scope returns hits only from the one you're in,
not from the other 4.

## Migrating from v0.1

If you were on v0.1 (markdown-only `.myjarbis/context/*.md`),
opening Claude on the project automatically migrates:

- `knowledge-base.md` → observations under a `_general` module
- `daily.md` → module_context (workflow)
- `project-summary.md` → project_context (functional_spec)
- `prompts/system.md` → project_context (convention)
- 9 baseline skills seeded

Backup is dumped to `~/.myjarbis-global/backups/<project>/<ts>/`.
Legacy aliases (`search_code`, `get_context`, `update_memory`) keep
working.

## CLI reference

```bash
myjarbis init               # initialize current project
myjarbis doctor             # health check (25+ probes)
myjarbis stats              # counts per table
myjarbis list               # registered projects
myjarbis update             # pull + rebuild MCP server

myjarbis module add <name> [--description=...]
myjarbis module list

myjarbis skill add <name> --content-from=<file> [--module=...] [--description=...] [--trigger=...]
myjarbis skill list [--scope=all|project|module|session] [--module=<m>] [--only-enabled]
myjarbis skill edit <name> [--module=...]
myjarbis skill delete <name> [--module=...]
myjarbis skill enable|disable <name> [--module=...]
myjarbis skill materialize [--module=...] [--no-cleanup]

myjarbis import <file.md>   --target=<project|module:NAME> --kind=<kind> [--tags=...]
myjarbis import <file.json> --target=...                   --kind=<kind> --mapping='items[]'
                                                            [--id-field=...] [--title-field=...]
```

## Settings

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

## Tests

```bash
tests/bootstrap-prolicht.sh   # 12 .md + 1 JSON bulk import idempotency
tests/skills-lifecycle.sh     # baseline + module-level + cleanup on switch
```

## License

MIT.

— Built by Braian Axel Troncoso 🇦🇷.
