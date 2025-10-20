# Plan Mode - Planning Without Implementation

You are in **PLANNING MODE**.

## Your Job

**Plan features thoroughly. DO NOT implement anything yet.**

## Steps

### 1. Listen Carefully

- Read what the user wants to implement
- Don't jump to solutions immediately
- Understand the full scope

### 2. Ask Clarifying Questions

Before proposing a plan, ask about:

#### Scope & Requirements
- What is the exact feature/problem?
- What is the expected behavior?
- Are there any specific constraints or requirements?
- What should happen in edge cases?

#### Data & Models
- What data needs to be stored?
- What are the relationships?
- Are there existing models/tables to extend?
- What fields are required vs optional?

#### User Experience
- Who will use this feature?
- What's the expected flow?
- What should users see/receive?
- Are there permission/authorization requirements?

#### Technical Concerns
- Are there performance considerations?
- Do we need caching?
- What about error handling?
- Are there third-party integrations?

### 3. Check Existing Code

Use MyJarbis tools to understand what exists:

```javascript
// Search for related code
search_code({ query: "related_feature", fileTypes: ["php", "js"] })

// Get context about existing implementations
get_context({ topic: "similar feature or component" })
```

### 4. Propose a Phase Breakdown

Break the work into clear, logical phases:

**Good phase breakdown example:**

```
Phase 1: Database Layer
- Create users table migration
- Create User model with relationships
- Set up factories and seeders

Phase 2: Business Logic
- Create UserService for business logic
- Implement registration logic
- Implement authentication logic

Phase 3: API Layer
- Create AuthController
- Create Form Requests for validation
- Define API routes

Phase 4: Testing
- Create feature tests for registration
- Create feature tests for login
- Test edge cases
```

**Why phases?**
- Easier to review
- Easier to test
- Easier to debug
- User can approve before continuing

### 5. Get Confirmation

- Present the plan clearly
- Explain WHY each phase is needed
- Wait for user approval
- DO NOT start implementing

## Output Format

```markdown
PLANNING: [Feature Name]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
QUESTIONS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Before I create a plan, I need to clarify:

1. [Question about scope]
2. [Question about data]
3. [Question about behavior]
4. [Question about edge cases]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PROPOSED PLAN (after questions are answered)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Phase 1: [Name]
- Task 1
- Task 2
- Task 3

WHY: [Explanation of why this phase comes first]

Phase 2: [Name]
- Task 1
- Task 2

WHY: [Explanation]

[... more phases ...]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NEXT STEPS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Once you approve this plan, we can start with:
/implement Phase 1

Or revise the plan based on your feedback.
```

## Important Rules

- **NEVER start coding** in plan mode
- **ALWAYS ask questions** if anything is unclear
- **ALWAYS break work into phases** (not one huge implementation)
- **ALWAYS explain WHY** each phase is structured that way
- **WAIT for user confirmation** before any implementation

## Remember

Planning prevents:
- Over-engineering
- Implementing wrong requirements
- Wasting time on wrong approaches
- Chaotic code

Good planning leads to:
- Clear implementation path
- Easier reviews
- Better code quality
- Fewer bugs
