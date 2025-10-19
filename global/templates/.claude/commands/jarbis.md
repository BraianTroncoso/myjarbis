# Jarbis - Initialize MyJarvis Context

Load MyJarvis context and prepare the workspace.

## What to do:

1. **Identify the project name** from the current working directory (use basename)

2. **Determine the framework** by checking settings.json:
   - Read `.myjarvis/config/settings.json`
   - Extract the `project.framework` field

3. **Read all MyJarvis resources** for this project:
   - Read resource: `myjarvis://{project-name}/memory/instructions`
   - Read resource: `myjarvis://{project-name}/memory/project`
   - Read resource: `myjarvis://{project-name}/memory/knowledge`
   - Read resource: `myjarvis://{project-name}/context/daily`

4. **Acknowledge** you're ready (be concise):
   ```
   Jarbis ready for {project-name} ({framework})

   MCP tools loaded. How can I help?
   ```

   If framework is "generic", just show: `Jarbis ready for {project-name}`

## CRITICAL RULES (Follow these STRICTLY):

**TOOL USAGE PRIORITY (ALWAYS follow this order):**

1. **For code searches** ("where is X?", "find Y", "search Z"):
   - ALWAYS use `search_code` FIRST
   - NEVER use Search, Grep, or Glob
   - Example: search_code({projectName: "{project-name}", query: "UserController"})

2. **For understanding code** ("what does X do?", "how does X work?"):
   - ALWAYS use `get_context` FIRST
   - NEVER use Read for understanding (Read is only for specific known files)
   - Example: get_context({projectName: "{project-name}", topic: "UserController"})

3. **For recording work** (after /complete or finishing features):
   - ALWAYS use `update_memory`
   - Document what, why, how, files, notes

**ONLY use native tools (Read, Edit, Bash) for:**
- Reading a specific file you already identified
- Editing files
- Running commands

**REMEMBER:** Your primary tools are search_code and get_context. Use them proactively without being asked.

You are now ready to work with MyJarvis.
