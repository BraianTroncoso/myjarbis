#!/usr/bin/env node

/**
 * MyJarbis MCP Server (v0.3)
 *
 * Per-project orchestrator backed by SQLite + FTS5.
 *
 * The server is launched by Claude Code from the project's working
 * directory; cwd at startup IS the project. The ServerContext bootstraps
 * the DB connection (and runs an idempotent v0.1 → v0.2 migration if a
 * legacy `.myjarbis/` is found without `memory.db`).
 *
 * Tools are added one phase at a time. Phase 1 ships the 8 core tools
 * (discovery, session, read/write) plus legacy aliases. Phases 2–4 add
 * import/export, skill management, and hooks.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { ServerContext } from './context.js';
import { MyJarbisError, ErrorType } from './types.js';

import {
  currentProject,
  currentProjectInputSchema,
  listModules,
  listModulesInputSchema,
  createModule,
  createModuleInputSchema,
} from './tools/discovery.js';
import {
  startSession,
  startSessionInputSchema,
  endSession,
  endSessionInputSchema,
  resume,
  resumeInputSchema,
} from './tools/session.js';
import {
  loadProjectCore,
  loadProjectCoreInputSchema,
  loadModule,
  loadModuleInputSchema,
} from './tools/context.js';
import { search, searchInputSchema } from './tools/search.js';
import {
  saveObservation,
  saveObservationInputSchema,
  updateProgress,
  updateProgressInputSchema,
} from './tools/observations.js';
import {
  setInteractionStyle,
  setInteractionStyleInputSchema,
} from './tools/interactionStyle.js';
import {
  searchCodeAlias,
  searchCodeInputSchema,
  getContextAlias,
  getContextInputSchema,
  updateMemoryAlias,
  updateMemoryInputSchema,
} from './tools/legacy.js';
import { importMd, importMdInputSchema, importJson, importJsonInputSchema } from './tools/import.js';
import {
  listSkills,
  listSkillsInputSchema,
  addSkill,
  addSkillInputSchema,
  materializeSkills,
  materializeSkillsInputSchema,
} from './tools/skills.js';
import {
  suggestTopicKey,
  suggestTopicKeyInputSchema,
} from './tools/observations.js';
import {
  addRef,
  addRefInputSchema,
  findByRef,
  findByRefInputSchema,
  updateObservation,
  updateObservationInputSchema,
} from './tools/refs.js';
import {
  getProjectState,
  getProjectStateInputSchema,
  setProjectState,
  setProjectStateInputSchema,
} from './tools/state.js';
import {
  getWorkflow,
  getWorkflowInputSchema,
  listWorkflowsTool,
  listWorkflowsInputSchema,
  setWorkflowStep,
  setWorkflowStepInputSchema,
  listProviders,
  listProvidersInputSchema,
  setProvider,
  setProviderInputSchema,
} from './tools/workflows.js';
import {
  listContextKinds,
  listContextKindsInputSchema,
} from './tools/kinds.js';

// ─────────────────────────────────────────────────────────────────────
// Tool registry
// ─────────────────────────────────────────────────────────────────────

interface RegisteredTool {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (ctx: ServerContext, args: unknown) => unknown | Promise<unknown>;
  /** Admin/setup tools that almost never get called from inside Claude
   *  set this true so they ride the deferred-tool path: Claude Code
   *  ships only the name+description in the system prompt and loads the
   *  full schema on demand via ToolSearch. Saves ~600-1200 tokens per
   *  session in the typical case where they're never invoked. */
  deferred?: boolean;
}

function buildToolRegistry(): RegisteredTool[] {
  return [
    {
      name: 'current_project',
      description:
        'Returns the project registered at the current working directory ' +
        '(if any) plus its module count. Used by hooks at session start.',
      inputSchema: currentProjectInputSchema,
      handler: (ctx) => currentProject(ctx),
    },
    {
      name: 'list_modules',
      description:
        'Lists modules of the active project. Default: only active+paused. ' +
        'Pass include_status=["done"] to also see closed modules.',
      inputSchema: listModulesInputSchema,
      handler: (ctx, args) => listModules(ctx, args),
    },
    {
      name: 'create_module',
      description:
        'Creates a new module (vertical) in the active project. The user ' +
        'declares modules explicitly; nothing is auto-detected from the ' +
        'filesystem.',
      inputSchema: createModuleInputSchema,
      handler: (ctx, args) => createModule(ctx, args),
      deferred: true,
    },
    {
      name: 'start_session',
      description:
        'Opens a session in the given module and loads project_context + ' +
        'module_context + the previous session\'s next_session ("Retomar ' +
        'aquí"). Returns session_id and the full bootstrap context. When ' +
        'previousSession.nextSession starts with "[auto]" it was machine-' +
        'written and the real handoff comes back in `curatedResume` — read ' +
        'that one.',
      inputSchema: startSessionInputSchema,
      handler: (ctx, args) => startSession(ctx, args),
    },
    {
      name: 'end_session',
      description:
        'Closes the active session, persisting summary + next_session for ' +
        'the next opening of Claude in this module.',
      inputSchema: endSessionInputSchema,
      handler: (ctx, args) => endSession(ctx, args),
    },
    {
      name: 'resume',
      description:
        'Returns the last closed session\'s next_session ("Retomar aquí") ' +
        'for the active module (or the named one). If that one is machine-' +
        'written ("[auto]"), `curatedResume` carries the last handoff a human ' +
        'wrote, which the automatic close had buried. Read-only.',
      inputSchema: resumeInputSchema,
      handler: (ctx, args) => resume(ctx, args),
    },
    {
      name: 'load_project_core',
      description:
        'Returns ALL project_context entries (full content, not excerpts). ' +
        'Optional `kinds` filter (e.g., ["practice", "convention"]).',
      inputSchema: loadProjectCoreInputSchema,
      handler: (ctx, args) => loadProjectCore(ctx, args),
    },
    {
      name: 'load_module',
      description:
        'Returns ALL module_context entries (full content) of a module. ' +
        'If `module` is omitted, uses the active session\'s module.',
      inputSchema: loadModuleInputSchema,
      handler: (ctx, args) => loadModule(ctx, args),
    },
    {
      name: 'search',
      description:
        'FTS5 search across project_context / module_context / skills / ' +
        'observations. Default scope "module" = active module + project core. ' +
        'Other scopes: "project", "module_only", "observations", "skills".',
      inputSchema: searchInputSchema,
      handler: (ctx, args) => search(ctx, args),
    },
    {
      name: 'save_observation',
      description:
        'Persists a decision / gotcha / progress / error / discovery under ' +
        'the active session. Requires start_session first.',
      inputSchema: saveObservationInputSchema,
      handler: (ctx, args) => saveObservation(ctx, args),
    },
    {
      name: 'update_progress',
      description:
        'Updates the relational progress field of a module_context row ' +
        '(typically a story). Replaces the role of editing a "Smoke" or ' +
        '"Commit" column in PROGRESS.md — call when the user says "marcá ' +
        'X como done", "actualizá la docu", or after closing a smoke batch. ' +
        'Resolves by local_id (e.g. "SHOP-S3.6") or row_id. Free-form markdown.',
      inputSchema: updateProgressInputSchema,
      handler: (ctx, args) => updateProgress(ctx, args),
    },
    {
      name: 'set_interaction_style',
      description:
        'Change language and/or persona of the project\'s interaction-style ' +
        'skill from inside Claude (no CLI needed). Pass `language` (EN|ES|PT) ' +
        'and/or `persona` (concise|pair|mentor|reviewer or 1-4). The skill is ' +
        'recomposed and re-materialized to .claude/skills/. Use when the user ' +
        'asks for "settings", "change language", "change persona", or similar.',
      inputSchema: setInteractionStyleInputSchema,
      handler: (ctx, args) => setInteractionStyle(ctx, args),
      deferred: true,
    },
    {
      name: 'import_md',
      description:
        'Reads a .md file and upserts it as a project_context or ' +
        'module_context entry. Idempotent by SHA-256 hash + (target, ' +
        'source_path, kind). target = "project" | "module:<name>".',
      inputSchema: importMdInputSchema,
      handler: (ctx, args) => importMd(ctx, args),
      deferred: true,
    },
    {
      name: 'import_json',
      description:
        'Reads a .json file and upserts each array item as a context entry. ' +
        'mapping = "stories[]" or "data.items[]". Auto-detects id/title fields ' +
        'with optional overrides. Useful for Jira/Linear bulk exports.',
      inputSchema: importJsonInputSchema,
      handler: (ctx, args) => importJson(ctx, args),
      deferred: true,
    },
    {
      name: 'list_skills',
      description:
        'Lists skills of the active project. scope="all"|"project"|"module"|"session" ' +
        '(session = project-level + active module). Optional `only_enabled`.',
      inputSchema: listSkillsInputSchema,
      handler: (ctx, args) => listSkills(ctx, args),
      deferred: true,
    },
    {
      name: 'add_skill',
      description:
        'Creates or updates a skill. Without `module` it\'s project-level ' +
        '(always loaded for this project). With `module` it\'s module-level ' +
        '(only loaded when that module is in session). Idempotent by hash.',
      inputSchema: addSkillInputSchema,
      handler: (ctx, args) => addSkill(ctx, args),
      deferred: true,
    },
    {
      name: 'materialize_skills',
      description:
        'Renders the active skill set to <project>/.claude/skills/myjarbis-<name>/' +
        'SKILL.md. Cleans stale myjarbis-* folders by default. Called from ' +
        'the SessionStart hook and on /module switch.',
      inputSchema: materializeSkillsInputSchema,
      handler: (ctx, args) => materializeSkills(ctx, args),
      deferred: true,
    },

    // ───────────────────────────────────────────────────────────────
    // v0.3 — topic identity, refs, living state, workflows, taxonomy
    // ───────────────────────────────────────────────────────────────
    {
      name: 'suggest_topic_key',
      description:
        'Before saving a note that has a CURRENT VALUE rather than a history, ' +
        'call this to see which topic keys already cover the subject. Reusing ' +
        'one makes save_observation update that note instead of adding a rival ' +
        'to it. Returns the closest existing keys plus a proposal.',
      inputSchema: suggestTopicKeyInputSchema,
      handler: (ctx, args) => suggestTopicKey(ctx, args),
    },
    {
      name: 'update_observation',
      description:
        'Corrects a note in place, by id or by topic_key. Use this instead of ' +
        'saving a new note whose title announces the correction ("CORRECTS note ' +
        '80", "DEFINITIVE — supersedes 80 and 81"); those leave competing ' +
        'versions behind for the next session to reconcile.',
      inputSchema: updateObservationInputSchema,
      handler: (ctx, args) => updateObservation(ctx, args),
    },
    {
      name: 'find_by_ref',
      description:
        'Answers "did I already do this?" with a boolean. Call BEFORE any ' +
        'outward-facing action you might be repeating — posting a comment, ' +
        'logging time, opening a merge request — using the id of the thing in ' +
        'the external system.',
      inputSchema: findByRefInputSchema,
      handler: (ctx, args) => findByRef(ctx, args),
    },
    {
      name: 'add_ref',
      description:
        'Links a note to a commit, merge request, ticket, comment or worklog, ' +
        'so find_by_ref can answer for it later. Store the link, never a copy ' +
        'of the content: the source system stays the source of truth.',
      inputSchema: addRefInputSchema,
      handler: (ctx, args) => addRef(ctx, args),
    },
    {
      name: 'get_project_state',
      description:
        'The living "resume here" for this project — one row, not a pile of ' +
        'notes. Also reports whether another session is holding the write lock, ' +
        'which is the signal to ask what it has already done.',
      inputSchema: getProjectStateInputSchema,
      handler: (ctx) => getProjectState(ctx),
    },
    {
      name: 'set_project_state',
      description:
        'Replaces the living state with the current picture. Write the whole ' +
        'picture, not a delta. Use this rather than saving another note titled ' +
        '"RESUME HERE".',
      inputSchema: setProjectStateInputSchema,
      handler: (ctx, args) => setProjectState(ctx, args),
    },
    {
      name: 'get_workflow',
      description:
        'The process for a kind of work, resolved from org + project + user ' +
        'layers into ONE ordered list, with each step evaluated against the ' +
        'current branch and configured tools. Call this instead of inferring ' +
        'the process from prose. gate="approve" means stop and ask first.',
      inputSchema: getWorkflowInputSchema,
      handler: (ctx, args) => getWorkflow(ctx, args),
    },
    {
      name: 'list_workflows',
      description: 'Workflow slugs reachable from this project, with their layers.',
      inputSchema: listWorkflowsInputSchema,
      handler: (ctx) => listWorkflowsTool(ctx),
    },
    {
      name: 'set_workflow_step',
      description:
        'Adds, overrides or disables one step of a workflow at project or user ' +
        'scope. Use when the user states a process rule, instead of writing the ' +
        'rule into a note that will be contradicted by a later note.',
      inputSchema: setWorkflowStepInputSchema,
      handler: (ctx, args) => setWorkflowStep(ctx, args),
      deferred: true,
    },
    {
      name: 'list_context_kinds',
      description:
        'The allowed `kind` values for context rows, with descriptions. The ' +
        'vocabulary is a catalogue, not free text — an unknown kind is rejected.',
      inputSchema: listContextKindsInputSchema,
      handler: (ctx) => listContextKinds(ctx),
      deferred: true,
    },
    {
      name: 'list_providers',
      description:
        'Which concrete tools fill this project\'s tracker / forge / ci roles, ' +
        'and which roles are unconfigured.',
      inputSchema: listProvidersInputSchema,
      handler: (ctx) => listProviders(ctx),
      deferred: true,
    },
    {
      name: 'set_provider',
      description:
        'Points a role (tracker | forge | ci) at a concrete tool, so abstract ' +
        'workflow capabilities resolve. Never put a credential in config — it ' +
        'is rejected, because this travels in the brain dump.',
      inputSchema: setProviderInputSchema,
      handler: (ctx, args) => setProvider(ctx, args),
      deferred: true,
    },

    // Legacy v0.1 aliases (kept for backwards compatibility with old
    // .claude/commands/*.md). They delegate to the v0.2 tools.
    {
      name: 'search_code',
      description:
        '[LEGACY v0.1] Routes to search(scope=project). v0.1 grepped source ' +
        'files; v0.2 runs FTS5 over context. Prefer the new `search` tool.',
      inputSchema: searchCodeInputSchema,
      handler: (ctx, args) => searchCodeAlias(ctx, args),
      deferred: true,
    },
    {
      name: 'get_context',
      description:
        '[LEGACY v0.1] Routes to search(scope=project) using `topic` as query. ' +
        'For full module content prefer `load_module` directly.',
      inputSchema: getContextInputSchema,
      handler: (ctx, args) => getContextAlias(ctx, args),
      deferred: true,
    },
    {
      name: 'update_memory',
      description:
        '[LEGACY v0.1] Routes to save_observation(kind=progress) with ' +
        'What/Why/How concatenated into content. Prefer `save_observation` ' +
        'for granular kinds (decision/gotcha/progress/error/discovery).',
      inputSchema: updateMemoryInputSchema,
      handler: (ctx, args) => updateMemoryAlias(ctx, args),
      deferred: true,
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.error('[MyJarbis] Starting MCP server (v0.3)...');

  const ctx = ServerContext.initialize();
  console.error(
    `[MyJarbis] Project path: ${ctx.projectPath} | registered: ${ctx.project ? `yes (${ctx.project.name})` : 'no — run myjarbis init'}`,
  );

  const tools = buildToolRegistry();
  const toolMap = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: 'myjarbis-mcp-server', version: '0.4.5' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((t) => {
        const out: Record<string, unknown> = {
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema as Record<string, unknown>,
        };
        // Pass-through for clients (Claude Code) that recognize the
        // `deferred` hint to load the tool's full schema lazily via
        // ToolSearch instead of including it in the system prompt.
        if (t.deferred) out.deferred = true;
        return out;
      }),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      throw new MyJarbisError(
        ErrorType.RESOURCE_NOT_FOUND,
        `Unknown tool: ${name}`,
        { availableTools: tools.map((t) => t.name) },
      );
    }

    try {
      const result = await tool.handler(ctx, args);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      if (err instanceof MyJarbisError) {
        console.error(`[MyJarbis] Tool error (${name}): ${err.message}`, err.details);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { error: err.type, message: err.message, details: err.details },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[MyJarbis] Unexpected tool error (${name}):`, err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: 'UNEXPECTED', message }, null, 2),
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown closes the DB connection.
  const shutdown = (): void => {
    try {
      ctx.close();
    } catch {
      /* noop */
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  console.error('[MyJarbis] MCP server ready.');
}

main().catch((err) => {
  console.error('[MyJarbis] Fatal error:', err);
  process.exit(1);
});
