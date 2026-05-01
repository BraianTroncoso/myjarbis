# /skill — Manage project / module skills

Skills are markdown SKILL.md files Claude Code loads at session
start. In MyJarbis they live in the SQLite DB and are materialized
to `<project>/.claude/skills/myjarbis-<name>/SKILL.md` per module
activation.

This command is for the inline (in-Claude) workflow. For batch
work, the bash CLI (`myjarbis skill add/list/edit/...`) is faster.

## Forms

### `/skill list [--scope=all|project|module|session] [--module=<name>]`

Call `list_skills` with the matching args. Print:
- Each skill's `name`, `module` (or "project-level"), `enabled`,
  `bytes`, `updated_at`.
- A short tip explaining how to add/edit a skill below the list.

### `/skill add <name> [--module=<m>]`

Goal: create a project-level or module-level skill.

1. Ask the user for the skill content (plain markdown). Encourage
   YAML frontmatter at the top:
   ```
   ---
   name: <name>
   description: <one-liner>
   ---
   ```
2. Optional inputs you can ask follow-ups for:
   - `description` (1-line)
   - `trigger_pattern` (free-form note about when this skill should fire)
3. Call `add_skill({ name, content, description, trigger_pattern, module })`.
4. After success, call `materialize_skills({ module: "<m or active>" })`
   so the file appears in `.claude/skills/`. Tell the user a Claude
   restart may be needed for the running session to actually load
   the new skill.

### `/skill edit <name> [--module=<m>]`

1. Resolve the skill row via `list_skills` with the right scope and
   filter by name. If not found, error.
2. Show the current content to the user (whole or excerpt).
3. Ask for the new content (full replacement) or specific edits to
   apply. Apply them and show the diff.
4. Once the user approves, call `add_skill` with the new content
   (it does an idempotent UPSERT). Re-materialize.

### `/skill delete <name> [--module=<m>]`

1. Confirm with the user explicitly — this is destructive.
2. Use the bash CLI: ask the user to run
   `myjarbis skill delete <name> --module=<m>`. (The MCP tool surface
   doesn't expose a delete; we deliberately keep destructive ops on
   the CLI.)
3. After they delete, call `materialize_skills` to clean the FS.

### `/skill enable <name>` / `/skill disable <name>`

Same pattern as delete — point the user at the bash CLI:
`myjarbis skill enable|disable <name> [--module=<m>]`.

## When to make something a skill

Make a new skill when:
- A workflow rule fits in a self-contained markdown doc.
- The agent needs the rule loaded at session start (not only on
  request) — so it should be a Claude Code skill.
- It's specific to **this project** (or this module). For things
  reusable across projects, the bash CLI doesn't yet support
  cross-project skills (v0.3 roadmap).

Don't make it a skill if:
- It's just a fact about the codebase → use `save_observation`.
- It's a one-off note for this session → say it in chat.
- It's how the codebase is structured → use `import_md` to bring
  the actual document in as `project_context` or `module_context`.
