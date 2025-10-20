# MyJarbis - AI Development Assistant System

> **Persistent memory and structured workflows for Claude Code**

MyJarbis is a development assistant system that enhances Claude Code with:
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

**MyJarbis solves this** by giving Claude a "memory system" and enforcing a structured workflow.

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
│           ~/.myjarbis-global/mcp-server/                │
│              (ONE server for ALL projects)              │
│                                                          │
│  Resources:                                             │
│  • myjarbis://project-name/memory/instructions          │
│  • myjarbis://project-name/memory/project               │
│  • myjarbis://project-name/memory/knowledge             │
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
│  Project A/.myjarbis/        Project B/.myjarbis/       │
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
git clone https://github.com/braiantroncoso/myjarbis.git
cd myjarbis

# Run installation script
./install.sh
```

This will:
1. Copy MyJarbis to `~/.myjarbis-global/`
2. Install and build MCP server
3. Configure Claude Code to use MyJarbis
4. Add `myjarbis` CLI to your PATH

### Verify Installation

```bash
# Check CLI is available
myjarbis --version

# Check MCP server is configured
claude mcp list
# Should show: myjarbis - ✓ Connected
```

---

## Usage

### 1. Initialize a Project

```bash
# Navigate to your project
cd ~/projects/my-laravel-app

# Initialize MyJarbis
myjarbis init
```

This creates:
- `.myjarbis/` folder with context, prompts, and config
- `.claude/commands/` with /plan, /implement, /complete commands
- Auto-detects framework (Laravel, Express, Next.js, etc.)
- Generates project summary and structure

### 2. Start Claude Code

```bash
claude
```

### 3. Initialize Jarbis (IMPORTANT!)

```bash
/jarbis
```

This loads MyJarbis context and configures Claude to use MCP tools automatically.

**You should run `/jarbis` every time you start a new Claude session.**

### 4. Use Structured Workflow

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

MyJarbis enforces **educational mode** - Claude ALWAYS explains:

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

MyJarbis maintains project memory across sessions:

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
myjarbis init

# List all registered projects
myjarbis list

# Generate fresh codebase context
myjarbis context

# Update MyJarbis global installation
myjarbis update

# Show help
myjarbis help
```

---

## Project Structure

After `myjarbis init`, your project will have:

```
your-project/
├── .myjarbis/
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

When Claude Code connects to MyJarbis, it can access:

```
myjarbis://my-laravel-app/memory/instructions
→ Reads: .myjarbis/prompts/system.md
→ Contains: Rules, workflow, educational mode settings

myjarbis://my-laravel-app/memory/project
→ Reads: .myjarbis/context/project-summary.md
→ Contains: Project overview, tech stack, architecture

myjarbis://my-laravel-app/memory/knowledge
→ Reads: .myjarbis/context/knowledge-base.md
→ Contains: Everything we've built, chronological log

myjarbis://my-laravel-app/context/daily
→ Reads: .myjarbis/context/daily.md
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

## Frequently Asked Questions (FAQ)

### Installation & Setup

**Q: Do I need to run `myjarbis init` in every project?**
A: Yes, once per project. This detects the framework and generates initial context files specific to that project.

**Q: Do I need to configure MCP for each project?**
A: No! The MCP server is configured globally during installation. Once you run `./install.sh`, it works for all projects.

**Q: I don't see any MCP logs when starting Claude. Is it working?**
A: Logs are hidden by default. To verify MCP is working:
- Run `claude mcp list` - you should see `myjarbis - ✓ Connected`
- In Claude Code, ask: "What tools from MyJarbis do you have?"
- When Claude uses a tool, you'll see `(MCP)` in the output

**Q: The installation says "Claude Code CLI not found". What should I do?**
A: Install Claude Code first from [https://claude.ai/claude-code](https://claude.ai/claude-code), then re-run `./install.sh`.

### Using MyJarbis

**Q: How do I know if Claude is using MyJarbis tools?**
A: When Claude uses MyJarbis tools, you'll see them marked with `(MCP)`:
```
myjarbis - search_code (MCP)(projectName: "my-app", query: "User")
```

**Q: What's the difference between MyJarbis tools and Claude Code's native tools?**
A:
- **Native tools** (Read, Edit, Bash): Direct file/system operations
- **MyJarbis tools**: Project-aware search, curated context, and persistent memory
- MyJarbis tools are optimized to save tokens and provide better context

**Q: Can I use MyJarbis without the /plan, /implement, /complete workflow?**
A: Yes! The workflow commands are optional. You can use MyJarbis tools directly at any time:
```
Use search_code to find authentication logic in Backend
Use get_context to understand how payments work
```

**Q: Do I have to use the structured workflow (/plan → /implement → /complete)?**
A: It's recommended but not required. The workflow prevents chaotic development and maintains memory, but you can work freely if you prefer.

### Memory & Context

**Q: Where is project memory stored?**
A: In your project's `.myjarbis/context/` folder:
- `knowledge-base.md` - What you've built (append-only log)
- `project-summary.md` - Project overview and structure
- `daily.md` - Today's focus and recent changes

**Q: How do I update the project context after making changes?**
A: Run `myjarbis context` to refresh the project summary. This re-analyzes your codebase structure.

**Q: Does MyJarbis send my code anywhere?**
A: No. Everything runs locally. MyJarbis only reads/writes files in your project's `.myjarbis/` folder and communicates with Claude Code via MCP (local protocol).

**Q: Can team members see the same context?**
A: Yes! Commit `.myjarbis/` files (except `codebase.txt` which is in `.gitignore`). Team members will share the same knowledge base and project summary.

### Troubleshooting

**Q: Claude doesn't recognize MyJarbis tools. What's wrong?**
A:
1. Verify MCP is configured: `claude mcp list`
2. If not listed, run: `claude mcp add myjarbis node ~/.myjarbis-global/mcp-server/build/index.js`
3. Restart Claude Code
4. Check the project is registered: `myjarbis list`

**Q: `myjarbis init` fails with "framework not detected"**
A: MyJarbis will use generic templates. You can manually edit `.myjarbis/prompts/system.md` to add framework-specific instructions.

**Q: The project summary is outdated after I added new models/controllers**
A: Run `myjarbis context` to regenerate `project-summary.md` with latest code structure.

**Q: Can I use MyJarbis in Windows?**
A: Yes, via WSL2 (Windows Subsystem for Linux). MyJarbis requires a Unix-like environment.

**Q: Error: "Project not found in registry"**
A: The project wasn't initialized. Run `myjarbis init` in the project directory.

### Advanced

**Q: Can I customize the system prompts?**
A: Yes! Edit `.myjarbis/prompts/system.md` in your project. This controls Claude's behavior and guidelines.

**Q: Can I add custom commands beyond /plan, /implement, /complete?**
A: Yes! Add custom `.md` files to `.claude/commands/` in your project.

**Q: How do I use MyJarbis with monorepos?**
A: Run `myjarbis init` in each subproject that needs its own context. Each will be registered independently.

**Q: Can I use multiple MCP servers alongside MyJarbis?**
A: Yes! Claude Code supports multiple MCP servers. Use `claude mcp add` to configure additional servers.

**Q: How do I uninstall MyJarbis?**
A:
```bash
# Remove MCP configuration
claude mcp remove myjarbis

# Remove global installation
rm -rf ~/.myjarbis-global

# Remove CLI from PATH (edit your shell RC file)
# Remove the line: export PATH="$HOME/.myjarbis-global/bin:$PATH"
```

---

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing`)
3. Commit with clear messages
4. Push and create a Pull Request

---

## License

MIT License - feel free to use MyJarbis in your projects!

---

## Issues & Support

- **Bug reports**: [GitHub Issues](https://github.com/braiantroncoso/myjarbis/issues)
- **Questions**: [GitHub Discussions](https://github.com/braiantroncoso/myjarbis/discussions)

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
