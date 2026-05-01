# /plan — Plan Mode (v0.2)

You are in **planning mode**. Goal: turn a user request into a clear,
phased plan WITHOUT writing code yet.

The behavior depends on whether the active module is **story-driven**
or **free-form**.

## Step 0 — Detect the mode

Before anything, look at the active module's `module_context` rows
(loaded by `/jarbis` at session start). If you see entries with
`kind=story` (typically imported from a Jira-bulk JSON), the module
is **story-driven**. Otherwise it's **free-form**.

You can confirm with: `search` with `scope=module_only` and a known
local-id pattern (e.g., the project's `story_pattern` regex).

## Mode A — Story-driven module

Follow the `story-driven` skill: **detect → audit → execute → close**.
For `/plan`, only do **detect** and **audit**. Implementation is `/implement`.

### Detect

If the user mentioned a local-id (matched by the `story_pattern`):
1. Call `search({ query: "<local-id>", scope: "module_only" })`.
2. Confirm to the user: "Detected MM-S1.2 — '<summary>'. Avanzo con la
   auditoría?".
3. If multiple stories match: list them and ask which one.

If the user did NOT mention a local-id:
1. Call `search({ query: "<topic>", scope: "module" })` to surface
   candidate stories.
2. Propose the closest matches; let the user pick one.

### Audit

Once you know the target story, build a **gaps table**:

| Requirement (from AC) | Status (present/missing/partial) | Evidence |
|-----------------------|----------------------------------|----------|

For each acceptance criterion in the story:
- Use `search` with `scope=project` for code paths/identifiers.
- Use the codebase tools (Bash/Read) for hard verification (run a
  test, read a file).
- Mark Status accordingly.

If **all present**: tell the user the story is already Done — propose
to `/complete` it without touching code.

If gaps exist: propose a phase breakdown and the branch name
convention based on the project's `WORKFLOW.md` if present
(e.g., `feature/mm-e1-s1.2-<slug>`). Wait for user approval.

## Mode B — Free-form module

For modules without `kind=story` rows (e.g., greenfield work).

1. **Listen.** Re-read the user's request. Don't jump to solutions.

2. **Ask.** Clarify before proposing a plan:
   - Scope: what is in / out?
   - Data: any models, tables, schemas to extend?
   - UX: who uses this, what do they see?
   - Tech: performance, errors, integrations?

3. **Use existing context.** Before grepping code, check:
   - `load_project_core` → conventions, deps, practices.
   - `load_module` → what already exists in this module.

4. **Propose phases.** Break work into 3–6 phases with clear
   deliverables. Output:

   ```
   PLAN: <feature>

   Phase 1: <name>
     - task
     - task
     WHY: <one-liner>

   Phase 2: <name>
     ...

   Once approved: `/implement Phase 1`
   ```

5. **Wait for approval.** Do not start any implementation under
   `/plan`.

## Output style

- ALWAYS surface what you read from the loaded context (don't pretend
  you discovered it; cite the source row title).
- Phase names are imperative ("Add X", "Refactor Y").
- Respect any `practice` or `convention` rows in `project_context`
  (e.g., commit message format, branch naming).

## What `/plan` does NOT do

- Write code.
- Modify files.
- Call `save_observation` (no progress yet — only `/complete` does that).
- Switch modules. If the user mentions another vertical, ask if they
  want to `/module <name>` first.
