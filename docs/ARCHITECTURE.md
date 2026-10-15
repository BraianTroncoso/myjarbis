# MyJarbis Architecture

What MyJarbis is and what it is built with, as of **v0.4.5 (schema v4)**.

This file replaces a version that described v0.1 — MCP *resources* under
`myjarbis://{project}/memory/...` and three tools — an API removed in v0.2.
It had been loaded into every session as `kind=convention` since May, which
put a three-version-old design at precedence #2. It is `kind=stack` now,
because that is what the catalogue calls "what the project is and what it is
built with". Architecture is not a convention.

## The problem it solves

Claude Code forgets everything between sessions, and a flat memory file does
not scale: a project has verticals, and loading all of them to work on one
burns the context window on things that do not apply.

So MyJarbis is an MCP server that sits **on top of** Claude Code and provides
two things: memory that persists per project, and scope so only the relevant
slice rides the system prompt.

## The two layers

| Layer | Holds | Loaded when |
|---|---|---|
| **project** | conventions, stack, practices, specs — anything true across the whole repo | always, as an index of excerpts |
| **module** | one vertical (`auth`, `mcp-server`, `entrevistas`): its workflow, plan, stories, module-level skills | only the active one |

A session is always open **in one module**. `search` defaults to
`scope=module`, which means the active module plus the project core; widening
to `scope=project` is an explicit act. This is the whole point: 23 projects
and 115 modules share one database, and a session reads a knowable slice of it.

## Storage

**SQLite + FTS5**, 35 tables counting the FTS shadow tables. The ones that
matter:

- `projects`, `modules` — the two layers.
- `project_context`, `module_context` — documents, typed by `kind` from a
  catalogue (`context_kinds`), not free text. Each has an FTS5 mirror.
- `observations` — what was learned, with `topic_key` + `supersedes` so saving
  again **updates** a note instead of adding a rival to it.
- `sessions` — one row per working block, with `summary` and `next_session`:
  the handoff.
- `project_state` — the living "resume here", a single row that gets
  overwritten, with an advisory lock that expires so a dead process cannot
  wedge the project.
- `skills`, `workflows`, `workflow_steps`, `providers`, `orgs`, `refs`.

Retrieval is pure FTS5 and stays that way. Hybrid/vector was measured and
rejected: at this scale the deciding axis is latency, not recall.

### Where the database lives

Two shapes, and resolution tries them in that order:

1. **silo** — `<project>/.myjarbis/memory.db`, one file per project.
2. **shared brain** — `~/.myjarbis/memory.db`, every project as rows.

`resolveProject()` (`global/mcp-server/src/resolve.ts`) matches a directory to
a project by, in order: an explicit name (`--project` or `MYJARBIS_PROJECT`),
the **git remote**, the **path**, or single-tenancy. The remote comes before
the path so a clone to a different directory still resolves. A silo next to
the project wins over the shared brain, so a project that never migrated keeps
working untouched.

`myjarbis migrate` upgrades a brain (backing it up first); `myjarbis merge`
moves a silo into the shared one. Neither is automatic — a schema change
should be something you chose, with a backup you know about.

## The MCP surface

**32 tools: 18 always loaded, 14 deferred.** Deferred tools are advertised by
name and their schemas are fetched on demand, which keeps the system prompt
small without hiding capability.

Always loaded — discovery, session lifecycle, read, write:

```
current_project · list_modules · start_session · end_session · resume
load_project_core · load_module · search
save_observation · update_progress · suggest_topic_key · update_observation
find_by_ref · add_ref · get_project_state · set_project_state
get_workflow · list_workflows
```

Deferred: module/skill administration, imports, org packs, providers,
interaction style, and the three v0.1 legacy aliases (`search_code`,
`get_context`, `update_memory`).

The canonical read pattern is `search` first (cheap, returns snippets with row
ids), then `load_module(row_ids=[...])` for the one or two bodies that matter.
Loading a whole kind with `full=true` on a large module returns 100KB+ and
drowns the context.

## Sessions and the handoff

`start_session` opens a session in a module and returns the project index, the
module context, and the previous session's `next_session` — the "resume here".

`end_session` closes it with a summary and the next handoff. The agent is
supposed to write both, which is what `/jarbis-close` exists to make reflexive.

If the agent never closes it, the **SessionEnd hook does**, with a synthetic
`[auto]` summary. That is a safety net, not a substitute: it records activity
("three commits happened") where a handoff states intent ("do this next").
Because a synthetic close is always the newest close, it used to bury the last
hand-written handoff; `start_session` and `resume` now also return
`curatedResume` when the newest close is machine-written, with its own
staleness clock and the count of closes burying it. Session recency is ordered
by `(ended_at, id)` — ids are not in close order.

## Skills, commands, and how they reach a project

Two different artifacts with two different propagation paths. This is the
distinction most likely to bite:

| | Lives as | Seeded by | Propagated by |
|---|---|---|---|
| **skills** (10 baselines) | rows in the brain, materialised to `.claude/skills/myjarbis-*/` | `init` | `myjarbis skill reseed [--all]` |
| **slash commands** (`/jarbis`, `/jarbis-close`) | files in `.claude/commands/` | `init` | `myjarbis commands sync [--all]` |
| **org packs** | rows, from a directory you own | `org add` | `myjarbis org sync <org>` |

Baselines: `session-protocol`, `observation-protocol`, `bitacora-progress`,
`commit-hygiene`, `compact-protocol`, `module-orchestration`, `story-driven`,
`framework-detect`, `subagent-delegation`, `interaction-style`.

The rule that both paths exist to enforce: **anything seeded by `init` reaches
new projects only.** Every per-project artifact needs a propagation path on day
one, or improving it silently helps nobody who already uses the tool.

Two guards worth knowing. `skill reseed` refuses `interaction-style`, which is
composed per project from the user's language and persona, so every project
legitimately differs from the baseline. `commands sync` refuses a command file
that matches no shipped template (`diverged`) — nothing distinguishes a
hand-edit from an old version, so it asks for `--force` instead of guessing.

Every slash command starts with `jarbis`: the slash menu is a flat namespace
shared with every other plugin, and the prefix is the only thing marking a
command as ours.

## The hooks

Four, shipped in `global/templates/.claude-plugin/` and copied into each
project by `init`. Claude Code provides the attachment points; the logic is
MyJarbis's, and each script just delegates to `cli.js hook <name>`.

| Hook | Fires | Does |
|---|---|---|
| `SessionStart` | Claude opens (`startup`/`clear`) | prints project, modules and the last handoff — in the project's language, read from `settings.json` because no agent exists yet |
| `SessionStart` | after `/compact` | re-surfaces the pre-compaction snapshot |
| `UserPromptSubmit` | every prompt | the memory-preference reminder, optional nudges |
| `Stop` | after **every** agent turn | nudges for a real summary; optional module-skill cleanup |
| `SessionEnd` | Claude actually closes | auto-closes any open session |

`Stop` firing per turn rather than at exit is why "remind the agent to close
the session" never worked, and why the real close lives in `SessionEnd`.

## Precedence

MyJarbis replaces Claude Code's defaults rather than negotiating with them.
Strongest first:

1. What the user just said.
2. `project_context` kind=`convention`/`practice` for this project.
3. `get_workflow(slug)` — resolved steps and their gates.
4. Org pack skills (`overrides/` has already replaced the baselines).
5. The 10 baseline skills.
6. Claude Code defaults — only where MyJarbis said nothing.

The limit, in the other direction: none of it overrides safety. A workflow does
not authorise deleting without a backup, pushing unasked, or skipping a
confirmation the user would want.

## Layout

```
bin/                      bash entry points: myjarbis, -init, -doctor, -update, -start
global/mcp-server/src/    the server
  index.ts                tool declarations (always-loaded vs deferred)
  cli.ts                  every CLI subcommand
  resolve.ts              directory → project, and which brain holds it
  context.ts              ServerContext: the handle tools receive
  db/                     schema, migrations, per-table repositories
  tools/                  one module per tool group
  org/                    packs, registry, fleet sync
  health.ts gc.ts review.ts commands.ts
global/templates/         .claude-plugin (hooks) + .claude/commands (es/en/pt)
tests/                    15 E2E suites, 248 assertions — bash, own fixtures
```

Tests build their own fixtures and run on any checkout: `bash
tests/run-all.sh`. A suite is only trusted once the fix it covers has been
reverted on purpose and the assertion confirmed red — the harness once could
not fail at all, and that is how it was found.
