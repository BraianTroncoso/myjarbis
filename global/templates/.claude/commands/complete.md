# Complete Mode - Finish and Document Phase

You are in **COMPLETION MODE**.

## Your Job

Mark the current phase as complete, update project memory, and propose next steps.

## Steps

### 1. Verify Implementation

Check that everything works:

- [ ] All code from the phase is implemented
- [ ] Tests pass (if tests exist)
- [ ] Manual testing done
- [ ] No errors or warnings
- [ ] Edge cases handled

If something is NOT working:
- DO NOT mark complete
- Fix issues first
- Then run /complete again

### 2. Update Project Memory

**IMPORTANT:** Use the `update_memory` tool to record what was built:

```javascript
update_memory({
    projectName: "[project-name]",
    title: "[Phase Name - Brief Description]",
    what: "[What was implemented - 1-2 sentences]",
    why: "[Why this implementation approach - rationale]",
    how: "[How it was implemented - technical details, can be multi-line]",
    files: [
        "[file1.ext]",
        "[file2.ext]",
        "[file3.ext]"
    ],
    notes: "[Optional: lessons learned, gotchas, future considerations]"
})
```

**Example:**

```javascript
update_memory({
    projectName: "ecommerce-api",
    title: "User Authentication - JWT Implementation",
    what: "Implemented JWT-based authentication system with login, register, and token refresh",
    why: "JWT provides stateless authentication perfect for API use, allowing horizontal scaling without session storage",
    how: "Created AuthController with login/register methods, JwtMiddleware for token validation, added refresh token table for security, implemented token rotation on refresh",
    files: [
        "app/Http/Controllers/AuthController.php",
        "app/Http/Middleware/JwtAuth.php",
        "database/migrations/2024_10_19_create_refresh_tokens_table.php",
        "routes/api.php"
    ],
    notes: "Tokens expire after 1 hour. Refresh tokens valid for 7 days. Consider adding rate limiting to auth endpoints in production."
})
```

### 3. Refresh Project Summary

**CRITICAL:** If you created new models, controllers, routes, or modified the project structure, refresh the project summary so it stays in sync:

```bash
myjarbis context
```

This re-analyzes the project and updates `project-summary.md` with the latest code structure.

**When to refresh:**
- Created new models/controllers/routes
- Added relationships to models
- Modified project structure significantly
- After major features

**When to skip:**
- Only changed implementation details
- Minor bug fixes
- Code refactoring without structural changes

Execute the command now if needed:

```bash
myjarbis context
```

### 4. Summarize What Was Done

Provide a clear summary:

```markdown
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PHASE COMPLETE: [Phase Name]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WHAT WAS IMPLEMENTED:
- [Item 1]
- [Item 2]
- [Item 3]

FILES CREATED/MODIFIED:
- [file1.ext]
- [file2.ext]

VALIDATION RESULTS:
✓ Tests passing
✓ Manual testing complete
✓ No errors

MEMORY UPDATED:
✓ Knowledge base updated with implementation details

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 5. Preview Next Phase (if applicable)

If there are more phases in the plan:

```markdown
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NEXT PHASE PREVIEW
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Phase [N]: [Name]

This phase will:
- [What will be implemented]
- [What will be implemented]

Building on what we just completed:
- [How it connects]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
READY TO CONTINUE?
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Would you like to:
1. Continue with next phase? (type: /implement Phase [N])
2. Review what was built?
3. Take a break and continue later?
```

If this was the LAST phase:

```markdown
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FEATURE COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

All phases of [Feature Name] are complete!

SUMMARY:
- [High level summary of entire feature]
- [What was accomplished]
- [What is now possible]

NEXT STEPS (optional):
- [ ] Deploy to staging
- [ ] Update API documentation
- [ ] Notify team
- [ ] Create tests for edge cases

KNOWLEDGE BASE:
✓ All phases documented in knowledge-base.md
```

## Important Notes

### When to Use /complete

Use this command when:
- Current phase is fully implemented
- Code is tested and working
- You're ready to document what was built

### When NOT to Use /complete

Don't use if:
- Code has errors
- Tests are failing
- Implementation is incomplete
- You're stuck/blocked

If blocked, explain the issue instead of marking complete.

## Remember

- **VERIFY everything works** before marking complete
- **ALWAYS update memory** using update_memory tool
- **SUMMARIZE clearly** what was accomplished
- **PREVIEW next steps** to maintain momentum

## Memory Update Template

```javascript
update_memory({
    projectName: "",  // From project-summary.md
    title: "",        // Brief, descriptive
    what: "",         // What was built (brief)
    why: "",          // Rationale for approach
    how: "",          // Technical implementation details
    files: [],        // Array of files created/modified
    notes: ""         // Optional: gotchas, future considerations
})
```

The memory update is CRUCIAL - it's how MyJarbis remembers what was built across sessions.
