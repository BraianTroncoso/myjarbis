# /jarbis-save — Write the session down without closing it

The user typed this because there is something worth not losing and the
work is not over. **The command IS the confirmation** — do not ask "should
I save?". Save, then show them in a few lines what you wrote.

This is `/jarbis-close` minus `end_session`. The session stays open and
you keep working immediately afterwards.

---

## Why it exists

`save_observation` already happens on its own as you work — that part was
never the gap. The gap is `set_project_state`, which until now only
happened at the close. So any session that ended without `/jarbis-close`
— a crash, a closed laptop, a `/clear`, a long session that drifted — left
the next one reading a project state from the session before.

That failure is **invisible**. Nothing looks wrong: the next session opens,
the banner prints, the handoff is there. It is just describing a world that
moved on. You only notice weeks later, when an agent confidently resumes
work that was finished.

So the point of this command is not to think harder about what to save. It
is to make the *call sequence* guaranteed rather than remembered. What goes
in each note is still your judgement — that part works, and nobody needs a
command for it.

---

## Order (it matters)

### 0. Look at the real state first

Run `git status --short`. You are writing down what IS, so find out what is.
If tests exist and you ran them, note the result; if you did not run them,
say that rather than assuming.

Unlike `/jarbis-close`, **uncommitted work is not a reason to stop.** It is
the normal case here — a checkpoint happens mid-work. Record it as part of
the picture.

### 1. Everything from this session not yet saved

For every decision, gotcha, error or piece of progress since the last save:
`save_observation` with the right `kind`, `content` ordered WHY → WHAT →
HOW, and `files`.

For anything with a **current value** rather than a history, call
`suggest_topic_key` first and reuse the key it returns — that updates the
note instead of leaving a rival next to it.

Do not save one note per file touched. Save what would spare an hour to
whoever opens this in three weeks.

### 2. Stories touched → `update_progress`

For each story worked on since the last save: `update_progress(local_id,
progress)` with status (`✅ done` / `🔄 wip` / `🔴 blocked`), commits, date,
smoke notes. This is row-relational state, not a session lesson — do not
use `save_observation` for it.

Skip this step in a module with no stories. Do not invent one.

### 3. `set_project_state` — the step this command exists for

**Never skip it.** If you only do one thing here, do this.

It **replaces** its previous content: write the whole picture, not a delta.
In this order:

- where the work stands right now;
- what is **verified** and what is not (the suite number if you ran it,
  "not run" if you did not);
- the concrete next action;
- what is already measured and settled, so it is not re-litigated.

Write it as if the session ended here — because it might. That is the
assumption that makes this command worth typing.

### 4. Recap, in four lines or fewer

The titles you saved, one line on what `set_project_state` now says, and an
offer to reword either. Then stop talking and go back to the work.

---

## Using it before `/compact`

This is the pre-compaction protocol. Run `/jarbis-save` first, then
`/compact`. Everything above still applies, plus:

- In step 1, add one `save_observation` with `kind: "discovery"` and
  `tags: "pre-compact"` holding the structured snapshot: the open thread,
  the decisions already taken in this session, the paths in play, and
  anything you are holding in your head that is not written anywhere.
- Err long. After the compaction, this note and `project_state` are all
  that survive of the reasoning.

---

## Rules

- **Do not call `end_session`.** That is `/jarbis-close`. If the user
  actually means to stop, say so and point them there.
- **Do not commit or push.** Saving is an act of memory, not of git.
- **Do not invent progress.** If little happened since the last save, the
  state says little happened. An optimistic checkpoint is worse than none,
  because the next session believes it.
- **Do not re-save what is already saved.** Check what this session already
  wrote before adding a second note on the same thing; use
  `update_observation` to correct one in place rather than stacking a
  correction next to it.
- **If no session is open**, say so and still write `set_project_state` —
  it is the part that survives either way.
- Natural language still works. "Save this", "update your memory", "write
  this down before we lose it" mean the same thing. The command only
  guarantees the floor.
