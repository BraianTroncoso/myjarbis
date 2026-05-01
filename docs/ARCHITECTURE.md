# MyJarbis Architecture

This document explains the technical architecture of MyJarbis.

## Overview

MyJarbis is a development assistant system that enhances Claude Code with persistent memory and structured workflows using the Model Context Protocol (MCP).

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    CLAUDE CODE                          │
│         (AI assistant with MCP support)                 │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ MCP Protocol (stdio)
                     │ Resources & Tools
                     ▼
┌─────────────────────────────────────────────────────────┐
│           ~/.myjarbis-global/mcp-server/                │
│              (Node.js MCP Server)                       │
│                                                          │
│  Resources:                                             │
│  • myjarbis://{project}/memory/instructions             │
│  • myjarbis://{project}/memory/project                  │
│  • myjarbis://{project}/memory/knowledge                │
│  • myjarbis://{project}/context/daily                   │
│                                                          │
│  Tools:                                                 │
│  • search_code - Intelligent code search                │
│  • get_context - Curated context extraction             │
│  • update_memory - Knowledge base updates               │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ File System Access
                     ▼
┌─────────────────────────────────────────────────────────┐
│         ~/.myjarbis-global/projects-registry.json       │
│              (Projects Index)                           │
│                                                          │
│  {                                                      │
│    "my-laravel-app": {                                  │
│      "path": "/home/user/projects/my-app",              │
│      "framework": "laravel",                            │
│      "initialized": "2025-10-19"                        │
│    }                                                    │
│  }                                                      │
└─────────────────────────────────────────────────────────┘
                     │
                     │ Project Paths
                     ▼
┌─────────────────────────────────────────────────────────┐
│     Project A/.myjarbis/        Project B/.myjarbis/    │
│     ├── context/                ├── context/            │
│     │   ├── project-summary.md  │   ├── project-summary │
│     │   ├── knowledge-base.md   │   ├── knowledge-base  │
│     │   └── daily.md            │   └── daily.md        │
│     ├── prompts/                ├── prompts/            │
│     │   └── system.md           │   └── system.md       │
│     └── config/                 └── config/             │
│         └── settings.json           └── settings.json   │
└─────────────────────────────────────────────────────────┘
```

## Components

### 1. MCP Server (`global/mcp-server/`)

**Technology:** Node.js + TypeScript + `@modelcontextprotocol/sdk`

**Responsibilities:**
- Expose resources (memory files) to Claude Code
- Provide tools for code search and context extraction
- Manage multiple projects from a single server instance
- Handle communication via stdio protocol

**Key Files:**
- `src/index.ts` - Main server, request handlers
- `src/types.ts` - TypeScript type definitions
- `src/tools/searchCode.ts` - Code search implementation
- `src/tools/getContext.ts` - Context extraction
- `src/tools/updateMemory.ts` - Knowledge base updates

**Communication:**
- Protocol: MCP over stdio (standard input/output)
- Started by: Claude Code (configured in `~/.config/claude/mcp.json`)
- Lifetime: Runs as long as Claude Code is open

### 2. Analyzers (`global/core/analyzers/`)

**Technology:** Node.js (JavaScript)

**Purpose:** Extract project structure automatically during `myjarbis init`

**Analyzers:**
- `laravel-analyzer.js` - Analyzes Laravel projects
  - Scans `app/Models/` for Eloquent models
  - Extracts relationships (hasMany, belongsTo, etc.)
  - Scans `app/Http/Controllers/` for controllers
  - Reads `routes/api.php` and `routes/web.php`
  - Detects Laravel version and database type

- `express-analyzer.js` - Analyzes Express.js projects
  - Scans `routes/` for route definitions
  - Detects middleware in `middleware/`
  - Identifies Mongoose/Sequelize models
  - Detects entry point (index.js, app.js, server.js)

- `generic-analyzer.js` - Fallback for unknown projects
  - Analyzes file structure
  - Counts files by extension
  - Reads `package.json` dependencies
  - Detects programming languages used

**Output:** Generates `project-summary.md` with real project structure

### 3. CLI Tools (`bin/`)

**Technology:** Bash scripts

**Commands:**
- `myjarbis` - Main CLI entry point
  - `myjarbis init` - Initialize project
  - `myjarbis list` - List registered projects
  - `myjarbis context` - Refresh project analysis
  - `myjarbis update` - Update global installation
  - `myjarbis help` - Show help

- `myjarbis-init` - Project initialization script
  - Detects framework
  - Creates `.myjarbis/` structure
  - Runs appropriate analyzer
  - Copies framework-specific templates
  - Registers project in global registry

- `myjarbis-update` - Global installation updater
  - Pulls latest changes (if git repo)
  - Rebuilds MCP server
  - Updates dependencies

### 4. Templates (`global/templates/` and `global/core/prompts/`)

**Framework-Specific System Instructions:**
- `system-laravel.md` - Laravel-specific guidelines
  - Naming conventions (Model singular, table plural)
  - Eloquent patterns
  - Artisan commands
  - Testing with PHPUnit

- `system-express.md` - Express.js guidelines
  - Router patterns
  - Middleware usage
  - Async/await patterns
  - Testing with Jest

- `system-generic.md` - Universal guidelines
  - General best practices
  - Language-agnostic patterns

**Claude Commands:**
- `plan.md` - Planning mode template
- `implement.md` - Implementation mode template
- `complete.md` - Completion mode template

### 5. Project Structure (`.myjarbis/` in each project)

**Created by:** `myjarbis init`

**Structure:**
```
.myjarbis/
├── bin/
│   ├── generate-context.sh    # Generate codebase.txt
│   └── daily.sh                # Update daily.md
├── context/
│   ├── project-summary.md      # Auto-generated project overview
│   ├── knowledge-base.md       # Implementation history
│   ├── daily.md                # Today's context
│   └── codebase.txt            # Optional full code dump
├── prompts/
│   └── system.md               # Claude's instructions
└── config/
    └── settings.json           # Project configuration
```

## Data Flow

### Session Start Flow

```
1. User opens Claude Code:
   claude

2. Claude Code reads ~/.config/claude/mcp.json:
   {
     "mcpServers": {
       "myjarbis": {
         "command": "node",
         "args": ["~/.myjarbis-global/mcp-server/build/index.js"]
       }
     }
   }

3. Claude Code starts MCP server via stdio

4. MCP server loads projects registry:
   ~/.myjarbis-global/projects-registry.json

5. Claude Code requests available resources:
   → ListResourcesRequest

6. MCP server responds with all resources:
   [
     "myjarbis://my-app/memory/instructions",
     "myjarbis://my-app/memory/project",
     "myjarbis://my-app/memory/knowledge",
     "myjarbis://my-app/context/daily"
   ]

7. Claude Code automatically reads these resources:
   → ReadResourceRequest for each

8. MCP server reads files from project:
   /home/user/projects/my-app/.myjarbis/prompts/system.md
   /home/user/projects/my-app/.myjarbis/context/project-summary.md
   etc.

9. Claude receives context and is ready
```

### Tool Execution Flow (search_code example)

```
1. User asks: "Find the User model"

2. Claude decides to use search_code tool

3. Claude sends CallToolRequest:
   {
     "name": "search_code",
     "arguments": {
       "projectName": "my-app",
       "query": "class User",
       "fileTypes": ["php"]
     }
   }

4. MCP server executes searchCode function:
   a. Gets project path from registry
   b. Executes ripgrep with filters:
      rg "class User" --glob="*.php" --glob="!node_modules/**" /path/to/project
   c. Parses results
   d. Formats output

5. MCP server responds:
   {
     "content": [
       {
         "type": "text",
         "text": "Found in app/Models/User.php line 8: class User extends Model"
       }
     ]
   }

6. Claude receives results and uses them in response
```

### Memory Update Flow (update_memory example)

```
1. User runs /complete after implementing feature

2. Claude executes update_memory tool:
   {
     "name": "update_memory",
     "arguments": {
       "projectName": "my-app",
       "title": "Product Model Implementation",
       "what": "Created Product model with relationships",
       "why": "Needed product catalog feature",
       "how": "Created migration, model with relations to User and Category",
       "files": ["app/Models/Product.php", "database/migrations/..."]
     }
   }

3. MCP server:
   a. Validates entry
   b. Formats as markdown
   c. Appends to knowledge-base.md:

      ## 2025-10-19 - Product Model Implementation

      **What:** Created Product model with relationships
      **Why:** Needed product catalog feature
      **How:** Created migration, model with relations to User and Category
      **Files:**
      - app/Models/Product.php
      - database/migrations/...

4. Next session, Claude reads updated knowledge-base.md
   → Knows about Product model
```

## Security Considerations

**File Access:**
- MCP server only reads files in registered project directories
- Cannot access files outside of `.myjarbis/` without explicit project registration
- No write access except to `.myjarbis/context/knowledge-base.md`

**Command Execution:**
- Tools use `ripgrep` with strict filters
- No arbitrary command execution
- Paths are validated before access

**Data Storage:**
- All data stored locally (no cloud)
- Projects registry in `~/.myjarbis-global/`
- Project data in project's `.myjarbis/` folder

## Performance

**MCP Server:**
- Lightweight (< 20MB memory)
- Fast resource reads (< 10ms)
- Tool execution depends on project size

**Analyzers:**
- Laravel: ~2-5 seconds for medium projects
- Express: ~1-3 seconds
- Generic: ~1-2 seconds

**search_code Tool:**
- Uses ripgrep (fastest code search)
- Filters node_modules, vendor, .git automatically
- Returns results in < 1 second for most projects

**get_context Tool:**
- Analyzes only relevant files
- Limits output to 3KB
- Typically < 2 seconds

## Scalability

**Multiple Projects:**
- Single MCP server serves all projects
- No performance degradation with many projects
- Registry lookup is O(1)

**Large Codebases:**
- Tools use streaming where possible
- Result limits prevent memory issues
- Works well with projects up to 100K+ files

## Future Improvements

1. **Auto-detect project changes** - Re-analyze when code changes
2. **Incremental analysis** - Only analyze changed files
3. **Caching** - Cache analyzer results
4. **VS Code extension** - Direct IDE integration
5. **Team collaboration** - Shared knowledge bases
6. **Multi-language support** - More framework analyzers
