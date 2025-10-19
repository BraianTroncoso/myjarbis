# MyJarvis - AI Development Assistant System

> **Persistent memory and structured workflows for Claude Code**

MyJarvis is a development assistant system that enhances Claude Code with:
- **Persistent Memory** via Model Context Protocol (MCP)
- **Structured Workflows** to prevent chaotic development
- **Educational Mode** that explains what, why, and how
- **Multi-Project Support** - install once, use everywhere

---

## What Problem Does This Solve?

When working with AI assistants like Claude Code, you often face:
- **No memory between sessions** - Claude forgets what you built yesterday
- **Chaotic implementations** - jumping into code without planning
- **Context overload** - explaining the same project structure repeatedly
- **No learning trail** - hard to understand what was built and why

**MyJarvis solves this** by giving Claude a "memory system" and enforcing a structured workflow.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    CLAUDE CODE                          │
│         (You interact via /plan, /implement, etc.)      │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ MCP Protocol (Model Context Protocol)
                     ▼
┌─────────────────────────────────────────────────────────┐
│           ~/.myjarvis-global/mcp-server/                │
│              (ONE server for ALL projects)              │
│                                                          │
│  Resources:                                             │
│  • myjarvis://project-name/memory/instructions          │
│  • myjarvis://project-name/memory/project               │
│  • myjarvis://project-name/memory/knowledge             │
│                                                          │
│  Tools:                                                 │
│  • search_code - Intelligent code search                │
│  • get_context - Curated context about topics           │
│  • update_memory - Update knowledge base                │
└────────────────────┬────────────────────────────────────┘
                     │
                     │ Reads/Writes
                     ▼
┌─────────────────────────────────────────────────────────┐
│  Project A/.myjarvis/        Project B/.myjarvis/       │
│  ├── context/                ├── context/               │
│  │   ├── project-summary.md  │   ├── project-summary.md │
│  │   ├── knowledge-base.md   │   ├── knowledge-base.md  │
│  │   └── daily.md            │   └── daily.md           │
│  ├── prompts/                ├── prompts/               │
│  │   └── system.md           │   └── system.md          │
│  └── config/                 └── config/                │
│      └── settings.json           └── settings.json      │
└─────────────────────────────────────────────────────────┘
```

---

## Installation

### Prerequisites
- **Node.js 18+** ([Download here](https://nodejs.org/))
- **Claude Code** ([Get it here](https://claude.ai/claude-code))
- **macOS or Linux** (Windows WSL2 supported)

### Global Installation

```bash
# Clone the repository
git clone https://github.com/braiantroncoso/myjarvis.git
cd myjarvis

# Run installation script
./install.sh
```

This will:
1. Copy MyJarvis to `~/.myjarvis-global/`
2. Install and build MCP server
3. Configure Claude Code to use MyJarvis
4. Add `myjarvis` CLI to your PATH

### Verify Installation

```bash
# Check CLI is available
myjarvis --version

# Check MCP server is configured
cat ~/.config/claude/mcp.json
```

---

## Usage

### 1. Initialize a Project

```bash
# Navigate to your project
cd ~/projects/my-laravel-app

# Initialize MyJarvis
myjarvis init
```

This creates:
- `.myjarvis/` folder with context, prompts, and config
- `.claude/commands/` with /plan, /implement, /complete commands
- Auto-detects framework (Laravel, Express, Next.js, etc.)
- Generates project summary and structure

### 2. Start Claude Code

```bash
claude
```

### 3. Use Structured Workflow

#### Step 1: Plan First
```
/plan

I want to add user authentication with JWT tokens
```

Claude will:
- Ask clarifying questions
- Break work into phases
- Propose architecture
- **NOT implement anything yet**

#### Step 2: Implement Phase by Phase
```
/implement

Let's start with Phase 1: User model and migration
```

Claude will:
- Focus ONLY on current phase
- Explain every decision (educational mode)
- Generate tests
- Update documentation
- Ask before making assumptions

#### Step 3: Complete and Move Forward
```
/complete
```

Claude will:
- Verify implementation works
- Update knowledge-base.md
- Show what was done
- Preview next phase
- Ask if you want to continue

---

## Educational Mode

MyJarvis enforces **educational mode** - Claude ALWAYS explains:

1. **¿Qué hace?** - What does this do?
2. **¿Por qué así?** - Why this approach?
3. **¿Para qué sirve?** - What's the benefit?
4. **¿Cómo se relaciona?** - How does it connect to other parts?

Example:
```markdown
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXPLANATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
We're creating a User model with a "roles" relationship.

WHY: This allows flexible permission systems where users
can have multiple roles (admin, editor, viewer, etc.)

HOW IT WORKS: We'll use a many-to-many relationship via
a pivot table (role_user), which is Laravel's standard
approach for this pattern.

BENEFIT: You can easily check permissions like:
if ($user->hasRole('admin')) { ... }

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IMPLEMENTATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[Code here...]
```

---

## Memory System

MyJarvis maintains project memory across sessions:

### Context Files

| File | Purpose | Updated |
|------|---------|---------|
| `project-summary.md` | High-level project overview | Once at init |
| `knowledge-base.md` | What we've built (append-only log) | After each phase |
| `daily.md` | Today's focus and recent changes | Daily |
| `system.md` | Claude's instructions and rules | Rarely |

### How Memory Works

1. **Every session**, Claude reads:
   - Project summary (what this project is)
   - Knowledge base (what we've built)
   - Daily context (what we're working on now)

2. **After each phase**, Claude updates:
   - Knowledge base with new implementations
   - Daily context with progress

3. **You always have**:
   - A searchable log of decisions
   - Context for new team members
   - Understanding of why things were built a certain way

---

## CLI Commands

```bash
# Initialize current project
myjarvis init

# List all registered projects
myjarvis list

# Generate fresh codebase context
myjarvis context

# Update MyJarvis global installation
myjarvis update

# Show help
myjarvis help
```

---

## Project Structure

After `myjarvis init`, your project will have:

```
your-project/
├── .myjarvis/
│   ├── bin/
│   │   ├── generate-context.sh    # Generate codebase.txt
│   │   └── daily.sh                # Update daily.md
│   ├── context/
│   │   ├── project-summary.md      # Project overview
│   │   ├── knowledge-base.md       # Implementation log
│   │   ├── daily.md                # Today's context
│   │   └── codebase.txt            # Auto-generated code dump
│   ├── prompts/
│   │   └── system.md               # Claude's instructions
│   └── config/
│       └── settings.json           # Project settings
│
└── .claude/
    └── commands/
        ├── plan.md                 # /plan command
        ├── implement.md            # /implement command
        └── complete.md             # /complete command
```

---

## How MCP Resources Work

When Claude Code connects to MyJarvis, it can access:

```
myjarvis://my-laravel-app/memory/instructions
→ Reads: .myjarvis/prompts/system.md
→ Contains: Rules, workflow, educational mode settings

myjarvis://my-laravel-app/memory/project
→ Reads: .myjarvis/context/project-summary.md
→ Contains: Project overview, tech stack, architecture

myjarvis://my-laravel-app/memory/knowledge
→ Reads: .myjarvis/context/knowledge-base.md
→ Contains: Everything we've built, chronological log

myjarvis://my-laravel-app/context/daily
→ Reads: .myjarvis/context/daily.md
→ Contains: Today's focus, recent changes
```

Claude automatically reads these on session start.

---

## Workflow Example

### Scenario: Add Email Verification

```bash
# 1. Start Claude Code
cd ~/projects/my-laravel-app
claude
```

```
# 2. Plan the feature
/plan

I want to add email verification for new users
```

Claude responds:
```markdown
PLANNING: Email Verification Feature

Let me ask some questions first:

1. Should existing users be affected?
2. Can unverified users log in but with limited access?
3. Do you want a custom verification email template?
4. Should verification links expire? If yes, after how long?

Based on your answers, I propose these phases:
- Phase 1: Database migration (add email_verified_at)
- Phase 2: Verification email and routes
- Phase 3: Middleware for protected routes
- Phase 4: Tests and edge cases

Please answer the questions above, then we can proceed.
```

```
# 3. Answer questions and implement
Answers: 1) No, 2) Yes but can't post, 3) Yes, 4) Yes, 24 hours

/implement Phase 1
```

Claude implements Phase 1 with explanations:
```markdown
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EXPLANATION: Database Migration
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

We're adding an `email_verified_at` timestamp column.

WHY: Laravel's built-in verification system uses this exact
column name. By following conventions, we get free helpers
like $user->hasVerifiedEmail()

[... detailed implementation with comments ...]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VALIDATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Run: php artisan migrate
Expected: New column appears in users table
```

```
# 4. Mark complete and continue
/complete

Great! Let's continue with Phase 2.

/implement Phase 2
```

**Result:** Your knowledge-base.md now contains a permanent record of this implementation.

---

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Commit with clear messages
4. Push and create a Pull Request

---

## License

MIT License - feel free to use MyJarvis in your projects!

---

## Issues & Support

- **Bug reports**: [GitHub Issues](https://github.com/braiantroncoso/myjarvis/issues)
- **Questions**: [GitHub Discussions](https://github.com/braiantroncoso/myjarvis/discussions)

---

## Credits

Built with:
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) by Anthropic
- [Claude Code](https://claude.ai/claude-code) by Anthropic
- Inspired by the need for better AI-assisted development workflows

---

## Roadmap

- [x] Phase 1: Project structure
- [ ] Phase 2: MCP server foundation
- [ ] Phase 3: MCP tools implementation
- [ ] Phase 4: Installation scripts
- [ ] Phase 5: Project initialization system
- [ ] Phase 6: Claude commands
- [ ] Phase 7: Framework analyzers (Laravel, Express, Next.js)
- [ ] Phase 8: Advanced context tools
- [ ] Phase 9: Team collaboration features
- [ ] Phase 10: VS Code extension

---

**Made with care for better AI-assisted development**

*"Give your AI assistant a memory, get a development partner."*
