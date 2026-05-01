# /implement — Execute the current phase (v0.2)

You are in **implementation mode**. A `/plan` already produced a
phased breakdown; you implement the current phase. Nothing more.

## Pre-flight

Confirm we're inside an active session. If not, run `/jarbis` first.
Check there is a phase in scope — either the user said "Phase 1" or
the previous `/plan` left one queued. If neither, ask.

## Loop (per logical commit)

For each meaningful chunk of the phase:

1. **Implement.** Edit/create the files. Follow the project's
   conventions surfaced in `project_context` (kind=`practice` /
   `convention`).

2. **Verify.** Run tests / linters / type-check as the project
   demands. If something fails, fix before continuing.

3. **Commit.** Format from the project's WORKFLOW context
   (e.g., for MM: `feat(mm-e1): <desc> (MM-S1.2)`). Stage by name.
   No `git add -A`. No `--no-verify`.

4. **Save the decision.** Call `save_observation`:
   ```
   save_observation({
     kind: "decision",
     title: "<≤80 chars imperative>",
     content: "WHY first. Then WHAT. Then HOW.",
     story_local_id: "<id-if-applicable>",
     files: "<comma-separated paths edited>",
     tags: "<phase, story, etc.>"
   })
   ```
   This is **non-negotiable** — every commit-worthy decision lands
   in the session log so the next session knows why.

## When you hit a gotcha

If something behaves unexpectedly (an undocumented quirk, a config
that bit you, a workaround you adopted), call:
```
save_observation({ kind: "gotcha", title, content, files? })
```
BEFORE moving on, while it's fresh.

## Boundaries

- **One phase only.** Don't jump ahead.
- **No new features "just in case".**
- **Ask before assuming.** If the AC of a story is ambiguous, ask
  the user; do not invent.
- If a decision changes architecture broadly, escalate to `/plan`
  again instead of pushing through.

## Educational tone (when adding non-obvious code)

For pieces with non-obvious WHY, leave a one-line code comment
explaining the constraint or invariant. Avoid comments restating
the WHAT — that's already in the code.

## After the phase is done

Run `/complete` to:
- Save a `kind=progress` observation for the whole phase.
- Close the session with `summary` + `next_session` (the "Retomar
  aquí" the next session will read).
