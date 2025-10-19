# Jarbis - Initialize MyJarvis Context

Load MyJarvis context and prepare the workspace.

## What to do:

1. **Identify the project name** from the current working directory (use basename)

2. **Read all MyJarvis resources** for this project:
   - Read resource: `myjarvis://{project-name}/memory/instructions`
   - Read resource: `myjarvis://{project-name}/memory/project`
   - Read resource: `myjarvis://{project-name}/memory/knowledge`
   - Read resource: `myjarvis://{project-name}/context/daily`

3. **Acknowledge** you're ready:
   ```
   Jarbis initialized for {project-name}

   Context loaded:
   - System instructions
   - Project summary
   - Knowledge base
   - Daily context

   MCP tools ready: search_code, get_context, update_memory

   How can I help you today?
   ```

## Important reminders after loading:

- Use **search_code** instead of Search/Grep for code searches
- Use **get_context** instead of reading multiple files
- Use **update_memory** when completing features (especially with /complete)
- Follow the educational mode: explain WHAT, WHY, HOW
- Follow structured workflow when using /plan, /implement, /complete

You are now ready to work with MyJarvis.
