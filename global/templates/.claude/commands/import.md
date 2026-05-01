# /import — Bootstrap context from .md or .json

Brings external documents (workflow notes, plans, JIRA bulks) into
MyJarbis's SQLite as `project_context` or `module_context` rows.
Hash-idempotent: re-importing the same content is a no-op; an edit
is an UPDATE.

## Forms

### `/import <path> --target=<project|module:NAME> --kind=<kind> [--tags=<csv>]`

For .md files. Calls `import_md`. Example:
```
/import agents/backend/prolicht/MM/PROGRESS.md --target=module:MM --kind=workflow --tags=progress
```

Recognised `kind` values:
- Project-level: `practice` · `dependency` · `convention` ·
  `functional_spec` · `jira_rules` · `error_log` ·
  `design_guideline` · `other`
- Module-level: `workflow` · `plan` · `functional_doc` ·
  `use_cases` · `acceptance_criteria` · `story` · `other`

### `/import <path> --target=... --kind=... --mapping="<jsonpath>"` (JSON)

For structured JSON (Jira/Linear bulks). Calls `import_json`. The
`mapping` selector points to the array of items (e.g., `stories[]`,
`data.items[]`). Each item becomes one row.

Auto-detects:
- ID field: `localId` → `id` → `key` → `name` → index.
- Title field: `title` → `name` → `summary` → ... → ID.

Override with `--id-field=<f>` / `--title-field=<f>` if needed.

## Steps the agent should follow

1. Confirm the inputs with the user before running. Show:
   - File path (resolved absolute)
   - Target (project or module:name)
   - Kind
   - For JSON: the mapping
2. Invoke `import_md` or `import_json` via the MCP tool.
3. Print the result block. Highlight `inserted` / `updated` /
   `unchanged` counts so the user sees what changed.
4. Suggest next steps:
   - For workflow/plan: "Re-`/jarbis` to refresh `start_session`'s
     context." (or run the SessionStart hook manually.)
   - For story bulks: "Now you can `search` by local-id to detect
     stories from `/plan`."

## Where the file lives in the DB

`source_path` is stored relative to the project root when possible.
For JSON items, `source_path` becomes `<rel-path>#<id>` so each item
is uniquely addressable for re-import.

## Tip — bulk import the whole agents/ tree

For a larger import (say, all 12 .md + 1 JSON of a project), prefer
the bash form — faster, no chat overhead:

```bash
myjarbis import agents/.../WORKFLOW.md --target=project --kind=workflow
myjarbis import agents/.../MM_Jira_Bulk.json --target=module:MM --kind=story --mapping='stories[]'
# ...
```

The slash-command form is best for one-off or interactive imports.
