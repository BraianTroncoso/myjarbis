# Auto-memory pointer

This file is a **safety net**. Project context is managed by **MyJarbis** (SQLite + FTS5 at `.myjarbis/memory.db`).

The MyJarbis SessionStart hook bootstraps the active module on startup. When the MCP server is up, prefer MyJarbis tools over reading this file's body.

## Memory contract

Use these tools instead of reading auto-memory `.md` files:

- `mcp__myjarbis__current_project` — confirm registration
- `mcp__myjarbis__list_modules` — see verticals
- `mcp__myjarbis__load_project_core` — full transversal context (stack, conventions, feedback)
- `mcp__myjarbis__load_module` — module-scoped context
- `mcp__myjarbis__search` — FTS5 across project + active module
- `mcp__myjarbis__save_observation` — log decisions/gotchas/progress per session

## Hard safety rules (fallback only)

These rules are also stored in MyJarbis as `kind=feedback`. Duplicated here on purpose so they survive an MCP outage.

<!-- Add project-specific safety rules below, one per bullet. Keep total file under 200 lines. -->
