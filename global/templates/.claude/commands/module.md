# /module — Switch or create a module

Modules (verticals) are how MyJarbis scopes context per project.
Use this command to **switch** between existing modules or **create**
a new one.

## Forms

### `/module <name>`  — switch to an existing module

Steps:

1. Confirm with the user: "Cambiamos a <name>?". A switch closes
   the current session.
2. If a session is open, ask the user for `summary` + `next_session`
   and call `end_session`. Don't lose the active session silently.
3. Call `start_session({ module: "<name>" })` for the target.
4. After start_session returns, the SessionStart hook normally
   re-materializes skills automatically; if you're inside an
   already-running Claude (no hook fired), call:
   ```
   materialize_skills({ module: "<name>" })
   ```
5. Surface the new module's `previousSession.nextSession` to the
   user so they can resume.

### `/module new <name> [--description="<desc>"]`  — create

Steps:

1. Validate: name is kebab-case or short identifier (alphanumeric,
   hyphens, no spaces). Reject otherwise with a clear hint.
2. Call `create_module({ name, description })`.
3. Ask the user if they want to start a session in the new module
   right now. If yes, run the switch flow above.

### `/module list`  — list modules (read-only)

Equivalent to `list_modules({ include_status: ["active","paused","done"] })`.
Print as a numbered list with status + last-session relativeTime.

## Notes

- The active module is the one whose `module_context` rows + skills
  are loaded into your context.
- `materialize_skills` is what changes which `myjarbis-*` skill folders
  exist under `.claude/skills/`. Module-level skills of the previous
  module disappear from disk; the new module's appear.
- Skills loaded in Claude Code's running session may not refresh
  on-the-fly even after re-materialize. If the user wants the
  exact new skill set live, ask them to restart Claude.

## Anti-patterns

- Switching modules mid-task to "look at" something else. Use
  `search` with `scope: "project"` instead — keeps the session.
- Creating modules eagerly. Wait until the user explicitly says
  "this is a new vertical".
