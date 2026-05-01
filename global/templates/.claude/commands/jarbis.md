# /jarbis — Activate MyJarbis (v0.2)

You are starting a MyJarbis-managed Claude Code session. Wire up the
project, choose a module, and load the right context.

## Steps

1. **Identify the project.**
   Call the MCP tool `current_project` (no arguments).
   - If `registered: false`: stop here and tell the user to run
     `myjarbis init` from the project root, then re-open Claude.
   - If `registered: true`: confirm with the user the project name.

2. **List modules and pick one.**
   Call `list_modules` (no arguments — defaults to `active+paused`).
   - **0 modules**: ask the user for a name and call
     `create_module({ name, description })`. Then proceed with that one.
   - **1 module**: don't ask — assume it. Inform the user briefly.
   - **N modules**: print the list and ask the user which one to use.
     Format:
     ```
     Project: <name>
     Modules:
       1. MM (active) — last session 2h ago
       2. PageBuilder (paused)
     Which module are we working on?
     ```

3. **Open a session in that module.**
   Call `start_session({ module: "<name>" })`.
   The result includes:
   - `projectContext[]`  → general project rules/practices/deps.
   - `moduleContext[]`   → workflow, plan, stories of that module.
   - `previousSession`   → if non-null, the previous `nextSession`
                           field is the "Retomar aquí" the agent
                           should honor.

4. **If `previousSession.nextSession` is set, surface it.**
   Tell the user, in one paragraph, what we were leaving off and
   propose the immediate next step. Example:
   > Resuming: cerraste MM-S1.1 ayer. La próxima acción era abrir
   > PR a la rama MediaManager. ¿Avanzamos con MM-S1.2 o querés
   > revisar antes?

5. **Stay in scope.**
   From here on, every `search` defaults to `scope=module` —
   only the active module + project_core. To look at other modules
   the user has to be explicit (`search ... scope=project`).

## Rules

- **NEVER** call `save_observation` until at least one user
  exchange has happened — start_session by itself is not progress.
- **ALWAYS** use the loaded `projectContext` + `moduleContext`
  before grepping the codebase. They're already in your reply.
- If the user asks something orthogonal to the module ("hey,
  ¿qué workflow tiene Translations?"), call `search` with
  `scope=project` rather than switching session.

## When to switch modules mid-session

Use `/module <name>` when the user pivots verticals. That command
will close the current session, start a new one in the target,
and re-materialize skills. Don't do it silently — confirm with
the user first.
