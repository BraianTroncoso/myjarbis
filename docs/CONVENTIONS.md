# MyJarbis conventions

Rules for working in this repository. Loaded into every session as
`project_context kind=convention`, which puts it at precedence #2 — above any
skill, and above whatever an agent would infer on its own.

Keep it short. A convention nobody can recite is not one.

## Language

**Everything written in this repository is in English.** Commit subjects,
commit bodies, code comments, documentation, test names, CLI output, CHANGELOG
entries. No exceptions.

This is not a style preference. The repository is public, and the `git log` is
the part of it that cannot be rewritten later — 182 commits deep, rewriting
subjects would move every SHA and invalidate every tag.

The convention was broken once, in a single session on 2026-10-14, which left
18 consecutive Spanish commits plus two isolated earlier ones. They stay as
they are, for the same reason: rewriting them is not worth moving 62 SHAs and
eight tags. **Do not read them as precedent.** An agent that samples the most
recent commits and generalises will conclude the opposite of this rule — that
is exactly how the drift happened, and why the rule is written here instead of
left to inference.

Conversation with the user is a separate matter: that follows
`interaction-style`, which is per-project and may be any language.

## Commits

```
<type>(<scope>): <imperative description, ≤72 chars, no trailing period>

Why: <the problem or motivation that triggers this change. If a story or
ticket exists, cite it.>

What for: <what changes or becomes possible after this commit. An
observable effect or a new invariant.>

Where: <the seam of the system the change lands in, and where the effect
shows up if that is somewhere else. Omit it when the change is local and
obvious — do not write filler.>
```

`Where:` is **not** the file list. The diff already says that, and repeating it
ages badly the moment a file is renamed. It earns its place when the change and
its consequence live apart: "written in the resolver, visible in every command
that opens a brain".

- **type**: `feat` | `fix` | `refactor` | `chore` | `docs` | `test` | `perf` | `style`
- **scope**: the subsystem — `hooks`, `cli`, `db`, `session`, `skills`, `update`, …

Hard rules:

- **Never** `Co-Authored-By: Claude`, or any Claude signature or trailer. The
  author is the user. Technical mentions of Claude Code in prose are fine.
- **Never** `--no-verify` or `--no-gpg-sign`. If a hook fails, fix the cause.
- **Never** `git add -A` or `git add .`. Stage by name.
- **Never** `--amend` after a push. Before a push it is fine.
- One commit = one logical change.

The older history uses `Por qué:` / `Para qué:` / `Dónde:` as headers, sometimes
with English prose. `Why:` / `What for:` / `Where:` is the form to use from here.

## Branches

The default branch is **`master`**. There is no `main`. A command or document
that says `main` is wrong about this repository.

**Work happens on a branch, never directly on `master`.** One branch per
session — the set of things a session sets out to do, not one per commit. It
gets merged when the work is verified and the user has tested it.

```
<type>/<what-the-session-is-about>
```

Same `type` vocabulary as the commits, kebab-case, English like everything
else. `fix/session-ownership-and-name-scrub`, not `fix/arreglos` and not
`braian-dev`.

Why a branch and not a direct commit: the point is being able to see what a
session did as one unit, and to drop it as one unit if it turns out wrong.
`master` staying clean and pushed is also what lets `project_state` say
"master at <sha>, clean" and have that mean something.

## Verifying a fix

Two rules earned the hard way, both recorded in `project_state`:

- **Validate every new test by reverting the fix.** A test that passes against
  the bug is not a test. If reverting the change does not turn it red, it
  asserts nothing.
- **Checking that an artifact exists does not check that it works.** `doctor`
  passed green for months on hooks that never ran, because it asserted
  `hooks.json` was present rather than that anything read it. Assert the
  effect, not the file.
