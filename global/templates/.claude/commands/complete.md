# /complete — Close the phase and the session (v0.2)

The current phase is done (or the unit of work the user wants to
close). Persist progress and close the session so the next opening
of Claude can resume coherently.

## Step 1 — Verify

Before recording anything, confirm:
- All planned work is in.
- Tests / lints / type-check are green.
- Manual smoke if applicable (the user signed off).

If anything is broken, **do not** call `/complete` — fix first.

## Step 2 — Save a progress observation

Call `save_observation` with `kind: "progress"`:

```
save_observation({
  kind: "progress",
  title: "<phase or story closed — imperative, ≤80 chars>",
  content: "What was implemented (1–3 bullets). Then what was
            verified (tests run, smoke done). Then any gotcha
            worth surfacing.",
  story_local_id: "<MM-S1.2 if a story-driven module>",
  files: "<comma-separated paths touched, if relevant>",
  tags: "phase-N, <module>, ..."
})
```

If multiple stories closed in this session, save one progress entry
per story; do not collapse them.

## Step 3 — End the session

Call `end_session` with two fields. **Both must exist**:

```
end_session({
  summary: "<retrospective: 1-3 bullets, what was done. NOT what's
            next. NOT a celebration.>",
  next_session: "<action-oriented "Retomar aquí" — see below>"
})
```

### How to write `next_session` (CRITICAL)

This is the most important artifact MyJarbis produces. It is what
the SessionStart hook injects when Claude opens next time.

Include, in this order:
1. **What's done & approved** (so the next session doesn't redo).
2. **What's open / pending review** (file paths, branch names,
   PR URLs).
3. **The single next concrete action.** Make it executable
   ("run X", "open PR Y", "start MM-S1.4").
4. **Blockers** if any (waiting on review, on data, ...).

Do not write retrospectives here — that's `summary`. Keep
`next_session` action-oriented and ≤ 10 lines.

## Step 4 — Inform the user

Output:

```
✓ /complete

Module: <name>
Phase/Story: <id or name>

Progress saved:
  • <one-liner of what was persisted>

Session #<id> closed.

Next session will resume with:
> <next_session text>
```

## When NOT to use /complete

- The phase is half-done.
- Tests are red.
- The user is just pausing, not finishing — they should just close
  Claude; the open session will be detected on next start.

## After /complete

The session is closed. To start a new piece of work:
- Same module → `/jarbis` (or just send the next message — but
  /jarbis is more explicit).
- Different module → `/module <new-name>`.
