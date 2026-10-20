# Changelog

## Unreleased

### Fixed

- **`update` overwrote the script it was running.** Step 3 copies `bin/` into
  the install directory, and the script being executed *is*
  `~/.myjarbis-global/bin/myjarbis-update`. `cp` over an existing file rewrites
  it in place — same inode, new bytes — and bash reads a script incrementally,
  by byte offset, rather than loading it whole. So the next read returned the
  new bytes at the old offset and execution resumed mid-token, as
  `line 196: f: command not found` on a line where nothing was wrong. Steps 4
  (rebuild) and 5 (report) never ran.

  It had been latent through every release where the file length barely moved,
  because bash resumed close enough to a statement boundary to keep going. One
  commit that added ~90 lines shifted every offset after step 1 and made it
  deterministic.

  The sync now replaces each file in `bin/` by renaming a copy over it. A
  rename swaps the directory entry and leaves the old inode alive for anyone
  still reading it, so a running script finishes the version it started with.
  The fix sits in the writer rather than in the script being replaced, which
  means anything added to `bin/` later is covered without its author needing to
  know this ever happened. Staging files from a run that died are swept on the
  next one, so re-running is a repair.

  Upgrading *past* this version still hits the old bug once, because the script
  doing the copying is the installed one. Run `myjarbis update` again and it
  completes — the first run installed the fix before dying. See
  `docs/UPGRADING.md` §2.

- **None of the hooks were ever attached.** `init` copied
  `.claude-plugin/` into the project and stopped there, but Claude Code reads
  a plugin's `hooks/hooks.json` only for plugins installed from a marketplace
  — it never auto-discovers a `.claude-plugin/` directory in the working tree.
  With no marketplace to install from, all five events were dead in every
  project MyJarbis ever initialised: no greeting, no module menu, no
  post-compaction snapshot, no `SessionEnd` auto-close. What made it survive
  is that the failure is invisible from the inside — each script works
  perfectly when run by hand, and `doctor` passed green because it asserted
  that `hooks.json` and the scripts existed, never that anything ran them.

  `init` now calls `myjarbis hook install claude`, which writes the binding as
  a `hooks` block in `.claude/settings.local.json`. That file is the right
  home for it: `init` already gitignores it as per-developer state, so the
  wiring leaves nothing to commit in a user's repo — the same reasoning that
  keeps `.claude-plugin/` untracked. The write merges rather than replaces,
  because that file also carries the permission allowlist: unrelated keys and
  hooks the user added themselves survive, only MyJarbis's own entries are
  rewritten on a re-run, and malformed JSON is refused instead of overwritten.

  `myjarbis update --projects` re-asserts the wiring, since refreshing the
  scripts without it would hand an old project new scripts nobody runs.
  Existing projects need one `myjarbis update --projects` and a Claude restart
  — hooks are read at startup.
- **`doctor` reported on the wrong thing.** It checked that
  `.claude-plugin/hooks/hooks.json` existed, which was true and meaningless.
  It now runs `hook install claude --check` and warns when the scripts are
  present but unwired, which is the state it used to pass. Its script list was
  also one short: `session-end.sh` shipped in v0.4.x and was never added, so
  the check that would have caught a missing auto-close hook never ran.
- **Hook timeouts were a thousand times too long.** `hooks.json` declared
  `10000` and `5000` for a field Claude Code reads in **seconds**, i.e. ~3
  hours and ~1.4 hours rather than the intended 10s and 5s. The wiring writes
  seconds. `${CLAUDE_PROJECT_DIR}` is also quoted now, so a project path
  containing a space resolves.
- **The first MyJarbis call of a session failed with `SESSION_NOT_ACTIVE`.**
  The `SessionStart` hook opened a session in its own process and printed the
  banner, but the MCP server — a separate process — held the active session in
  process memory and so believed nothing was open. The agent either errored on
  its first `save_observation` or quietly opened a second session, splitting
  one session's work across two rows. The active session is now resolved from
  the brain, so every process that looks sees the same answer. `search` with
  `scope=module` also reports the module it scoped to; that field was absent,
  which meant a search had silently widened to the whole project.
- **A project whose hooks were copied but bound to nothing reported as
  healthy.** This is the detector for the bug at the top of this list, and it
  could not see it. The hook state came from diffing
  `.claude-plugin/hooks/hooks.json` against the template and never read the
  settings file that makes those scripts run — so a byte-identical copy with
  no wiring reported `current`, rendered as "up to date". That false reading
  then switched off the repair: `update --projects` gated its refresh loop on
  `hooks != current` and skipped exactly the broken shape. On the machine this
  was found on, **22 of its 23 live projects were unwired** — every one except
  the MyJarbis checkout itself — and the command would have visited none of
  them. All 22 have since been repaired with `hook install claude`.

  That figure was first reported as 6, by a hand-written check that counted a
  project as wired if the string `myjarbis` appeared anywhere in its settings
  file. It matched permission entries. The number only came out right once the
  detector below was doing the counting, which is the argument for having it.

  `wiring` is now its own field — `wired` / `partial` / `unwired` / `unknown`
  — reported beside `hooks` rather than folded into it, because the repairs
  differ: a file copy fixes stale scripts, only `hook install claude` fixes a
  missing binding. `health` counts them in `totals.hooksUnwired` and flags
  them in the fleet table.
- **`update --projects` could overwrite the source checkout with the install
  dir's copy of its own templates.** The installed `templates/` is a snapshot
  of the checkout, so when the two differ it is normally because the checkout
  is ahead. Refreshing it from the snapshot is a revert, not a sync. It now
  refuses and says why.

### Added

- **`/jarbis-save`** — a third slash command: write the session down and keep
  working. Observations + `update_progress` + `set_project_state`, and
  deliberately **no** `end_session`.

  `save_observation` already happened on its own as you worked; the gap was
  `set_project_state`, which only ran at the close. So any session that ended
  without `/jarbis-close` — a crash, a `/clear`, a closed laptop — left the
  next one reading the state of the session before. Invisible: the banner
  prints, the handoff is there, it is simply describing a world that moved on.

  The command fixes the *call sequence*, not the content. What goes in each
  note is still the agent's judgement, which was never the part that failed —
  a bad note gets read and corrected, a skipped `set_project_state` makes no
  sound. It is also now the pre-compaction protocol, replacing a fourth
  separate path that meant the same thing.

  Ships in EN/ES/PT. `tests/v04-commands-sync.sh` now drives its
  "init installs everything" check off `SHIPPED_COMMANDS` instead of a
  hand-written list, so a command added to the product without being installed
  by `init` turns the suite red rather than shipping unreachable.

- **`myjarbis update --projects-only`** — repair every project's hooks without
  the pull, the re-sync or the rebuild. Reaching that step previously meant
  replacing the MCP server build a running Claude session is attached to, for
  the sake of five shell scripts. The skipped steps still announce themselves,
  since the step numbering is how the output gets read.

### Testing

Eighteen suites, 302 assertions.

`v04-hook-wiring` covers the end-to-end claim (`init` leaves the events bound
and every bound command runs), the non-destructive merge, idempotency, the
malformed-JSON refusal, and the `doctor` warning. `v045-session-ownership`
covers the cross-process session. `v045-unwired-detection` covers the fleet
view the other two leave open: scripts-current-but-unwired, a settings file
with no hooks block, partial wiring, a foreign hook not counted as ours,
malformed JSON as `unknown` rather than `unwired`, and the repair acting on a
project it used to skip. All validated by reverting the fix, per
`docs/CONVENTIONS.md` — 16 of the last suite's 18 checks fail without it.

`run-all.sh` now refuses to start when `global/bin/` exists in the checkout.
`bin/myjarbis` prefers `$MYJARBIS_INSTALL_DIR/bin` over its sibling fallback,
so one dev run of `update` pointed at the checkout's own `global/` leaves a
snapshot that every suite then tests instead of `bin/` — passing regardless of
the source, with identical output. This was hit for real while writing the
suite above.

## v0.4.5

Three defects in `myjarbis update`, all found by running it on a real machine
rather than in the suite. Two were silent, which is the worst kind in a tool
whose job is to tell you what is out of date.

### Fixed

- **The fleet report could not see a shared brain.** It looked for
  `<project>/.myjarbis/memory.db` with `existsSync`, and the v4 migration
  retired those local files. On this machine that meant printing "no brain
  yet" for all 23 projects, every one of which has a brain. The real cost was
  downstream: the "N project(s) are on an older schema" warning became dead
  code on exactly the configuration the project recommends, so a pending
  `migrate` would never be announced again. The report now asks
  `health --json`, because `collectHealth()` already resolves each project the
  way the rest of the system does and already returns schema, isolation and
  hook staleness — the 30 lines of node embedded in bash were a worse copy of
  tested code. Each line also names where the brain lives now (`shared` or
  `silo`), which is the field whose absence hid the bug: everything read "no
  brain yet" and looked fine.
- **Updating broke a running Claude session with no warning.** The rebuild
  replaces `mcp-server/build` in place, which is the exact build an open
  session is attached to, so every `mcp__myjarbis__*` call starts failing with
  "Connection closed" mid-session. There is now a preflight check before step
  1 — nothing has been touched yet, so declining leaves the installation
  untouched. It asks when there is a terminal (the same `[ -t 0 ]` idiom
  `myjarbis init` uses) and warns and proceeds when there is not, because
  blocking non-interactive callers would make updating impossible from inside
  Claude, which is where it is most often requested. `--yes` skips the
  question but never the warning.
- **The log claimed more than it did:** "refreshing hooks + commands" while
  the loop only copies `.claude-plugin/`. Commands have their own propagation
  path, `myjarbis commands sync`, which the report now points at.

### Testing

Fifteen suites, 248 assertions — unchanged, and stated plainly: `myjarbis
update` has no suite coverage and still does not. It is a bash installer that
runs `npm install` and a build, so putting it in `run-all.sh` would make the
suite slow and network-dependent. What is covered is the calculation it now
shares with `health`.

Verified by hand instead, on the machine where the false negative appeared: all
23 projects moved from "no brain yet" to `shared · up to date`, and a
deliberately downgraded fixture on schema 3 reports `silo · schema v3` with the
older-schema warning firing — something it could not do for anyone before. The
interactive prompt itself was not verified: the agent that wrote this has no
TTY, so only the no-terminal and `--yes` branches were exercised.

## v0.4.4

A patch for one bug, found by walking the conversational surface instead of
the CLI. v0.4.3 was tested from two seats — the developer's and the new
user's — but both typed commands. Nobody had tried *talking* to it.

### Fixed

- **Changing the language by asking for it only half-applied.** The language
  lives in two places: the `interaction-style` skill, which the agent reads,
  and `settings.json`, which the SessionStart hook reads because it runs
  before any agent exists and cannot ask anyone. Persisting to
  `settings.json` was bolted onto the CLI path only, so the documented
  conversational route — the user says "settings, switch me to English" —
  changed the agent and left the terminal printing the old language
  permanently. It was also unrepairable: once the skill matches the request,
  the upsert reports `unchanged` and the function returned early, so asking
  again did nothing either. The write now lives inside
  `applyInteractionStyle`, ahead of that branch, so both doors behave the
  same and a drifted `settings.json` is repaired rather than skipped.
- The naming rule for slash commands is now written down and asserted:
  every shipped command starts with `jarbis`, because the slash menu is a
  flat namespace shared with every other plugin and the prefix is the only
  thing marking a command as ours.

### Testing

Fifteen suites, 248 assertions. The new `v04-chat-triggers` covers the
conversational surface, which had none: `set_interaction_style` and
`myjarbis config language` were not touched by any suite, so the
best-documented trigger in the command file was the least tested thing in
the project.

Validated by reverting the fix — five assertions go red. The first draft of
that suite had one assertion that passed anyway: it checked for ES after
asking for ES, when the previous case had already left the file at es, so it
was reading the fixture rather than the behaviour. The teeth check is what
exposed it; it now forces a third language before measuring.

## v0.4.3

The 0.4 line is about the gap between shipping a mechanism and anyone
receiving it. v0.3 added `topic_key`, `supersedes` and baseline skills;
on a real machine of 23 projects and 1,470 notes, `topic_key` was at 0%
and an improved baseline reached new projects only. Code that nobody can
receive is code that does not exist.

v0.4.0 through v0.4.2 shipped without a changelog entry. This one covers
the line.

### Added

**`myjarbis review`** (v0.4.0). Groups notes that are successive versions
of one topic: the newest gets a `topic_key`, the older ones chain behind
it through `supersedes`. Nothing is deleted and nothing is merged — the
destructive reading of the word is not on offer. Clustering is title
overlap within one module and one kind, blunt on purpose, because a wrong
grouping costs a key that can be rewritten while inferring intent from
note content is the kind of cleverness that makes a cleanup tool
untrustworthy.

**`myjarbis skill reseed`** (v0.4.0). Propagates baseline skills to
projects that already exist, which is what makes editing a baseline worth
doing. Refuses `interaction-style`, which is composed per project from the
user's language and persona — every project legitimately differs from that
baseline, so a hash comparison flags all of them and applying it would
replace the user's configuration with a placeholder everywhere at once.
`--include-owned` overrides, only if that is genuinely meant.

**`/jarbis-close`** (v0.4.3). The second and last slash command. Closing a
session well used to be a sentence typed every time; the `SessionEnd` hook
already closes it for you, but with a synthetic summary that records
activity instead of handing off — it says three commits happened, not what
to do tomorrow. The command runs the whole ritual without asking, because
typing it is the confirmation: check the tree and state whether tests ran,
save pending observations, rewrite `project_state`, then `end_session`
with both texts written by the agent rather than requested from the user.

**`myjarbis commands sync`** (v0.4.3). The propagation path for slash
commands, which are files in each project's `.claude/commands/` written
only by `init`. Classifies before writing: `new`, `current`,
`other-language` (ours, with a stale language, corrected without asking)
and `diverged` — matching nothing shipped, so either hand-edited or from
an older version. Nothing distinguishes those two, so `diverged` stops and
requires `--force` rather than guessing. On the machine this was written
from: 23 of 23 projects were missing `/jarbis-close` and 21 carried a
`/jarbis` from an older version, including this repo, which was dogfooding
the v0.2 copy.

**`myjarbis health`, `gc`, `backfill-remotes`** (v0.4.0). The fleet seen at
once — schema, activity, what is going cold — plus collection of the litter
previous versions left, and the git remote recorded on projects that
predate the field.

### Fixed

- **A hand-written handoff could be buried by an automatic one.** The
  synthetic close is always the newest close, so it won every "last closed
  session" lookup and pushed the real note one level down each time it
  happened. `start_session` and `resume` now return `curatedResume` when
  the newest close is synthetic, with its own staleness clock and the
  burial count. Found in the wild: a 3,546-char handoff where the agent
  read a 124-char synthetic one and told the user there was no resume point.
- **The burial count ordered by id.** Session ids are not in close order —
  a session started months ago and auto-closed today has a low id and a
  recent `ended_at`. Recency is `(ended_at, id)` everywhere now.
- **`migrate` deleted settings keys it did not know about.** The v0.2 bump
  rebuilt the settings object from a hardcoded template, so anything a user
  had added by hand vanished mid-migration. One project lost `language=es`
  and `brain.auto_export_on_session_end`, which silently froze its
  committed brain dump for a week. Unknown keys now survive through a
  spread, not an allow-list, so the next key added is already covered.
- **`init` left generated files untracked in the user's repo.** The
  `.gitignore` block covered the brain, `active` and the materialised
  skills but not the generated command files or
  `.claude/settings.local.json` — the local-override half of Claude Code's
  settings pair, which accumulates absolute paths from one machine. Found
  by walking the newcomer path rather than the developer one. The block's
  header also no longer carries a version that goes stale.
- **A raw NUL byte made `review.ts` binary to git.** A composite map key
  used a literal control character instead of its escape; one byte is
  enough for git to stop diffing an 8 KB source file, so v0.4's first
  feature entered the repo unreadable as a diff.
- `myjarbis status` suggested `module use`, which `myjarbis help`
  described as existing only in `add/list`.

### Testing

Fourteen E2E suites, 237 assertions, each generating its own fixture —
`tests/run-all.sh`.

**The suite could not fail.** Thirteen assertions across three suites used
`node -e "..." | while read`, and the pipe put the counter in a subshell,
so every increment was discarded: the suites printed their ✗ lines and
exited 0 anyway. That was 104 of the project's checks at the time, none of
which could turn the build red. Found by reverting a fix on purpose to see
whether its new test had teeth. Assertions are read through a helper that
runs in the current shell now, and reverting the fix is how both of this
release's new suites were validated.

New suites: `v04-review-reseed` (weighted toward what those commands must
NOT do — the note count is unchanged after `--apply`, a hand-edited
`interaction-style` survives), `v04-commands-sync` (a hand-edited command
file survives `--apply`; a drift guard asserts the command list in
TypeScript and the install loop in `bin/myjarbis-init` name the same set),
and `v04-close-ritual` (what `/jarbis-close` writes, read back by a fresh
session: the handoff verbatim with no `[auto]` marker, `project_state`
replacing rather than accumulating, one `topic_key` updating in place,
`keep_history` chaining instead, the hook printing the handoff, and a close
with nothing open failing cleanly without leaving a phantom row).

### Known / deliberate

- `review` and `skill reseed` ship built but unapplied; both are dry-run by
  default and neither has been run against a real brain yet.
- `commands sync` writes files, so `diverged` needs `--force` by design.
- A dev checkout must set `MYJARBIS_INSTALL_DIR` and `MYJARBIS_REGISTRY`
  together: the registry otherwise resolves next to the install.

## v0.3.0

v0.2 gave the memory a schema. v0.3 is about what the memory was *still*
doing in prose, and about the layer MyJarbis actually is: something
installed on top of Claude Code that should guarantee its own bookkeeping
rather than hope the agent remembered.

Everything is additive. Existing projects keep working on their current
schema until you choose to run `myjarbis migrate`, which backs up first.

### Added

**Org packs.** Load how an organization works instead of teaching it to
each project. A pack is a directory — `skills/`, `overrides/`,
`context-kinds.yml`, `workflows/`, `providers.yml` — kept in your own
private repo. `overrides/` replaces a baseline skill of the same name;
applying always ends by materialising to `.claude/skills/`, because the
database alone configures nothing the agent can see. `myjarbis org sync`
re-applies to every project of the org in one command.

MyJarbis ships no pack. `examples/pack/` holds a fictional one so the
contract is readable.

**Workflows as data.** Process as rows with org → project → user
inheritance, resolved into one ordered list. Steps name an abstract
`capability` (`tracker.comment`), never a product — which tool that means
comes from the project's `providers` row, so one org workflow serves
clients on different trackers and the core never learns a vendor's name.
Conditions are decidable (`branch ~= release/*`), not free text.

**Notes with identity.** `topic_key` makes saving again *update* a note
instead of adding a rival to it. `refs` + `find_by_ref` answer "did I
already do this?" with a boolean. `update_observation` corrects in place.

**`project_state`.** The living "resume here" as a single row, with an
advisory lock that expires so a dead process cannot wedge the project.

**A context-kind catalogue.** `kind` is no longer free text. Unknown kinds
are rejected with the nearest match; known aliases fold silently.

**Sessions close themselves.** On `SessionEnd`, and again at the next
`start_session` for anything left open — so it survives a killed terminal,
a crash or a reboot. Generated text is labelled `[auto]` and the agent is
told it is machine-written.

**A shared brain, optional.** `~/.myjarbis/memory.db` with `project_id` as
the discriminator, for cross-cutting work. One database per project
(`isolation = silo`) remains the default.

**Resolution by git remote.** A project is found by its remote first, then
by the nearest enclosing registered path — so it resolves from any
subdirectory, and survives being cloned to a different path on another
machine.

**New commands.** `org`, `workflow`, `provider`, `state`, `kinds`,
`migrate`, `merge`, plus `brain export|import|status`. Nothing was
removed; `/jarbis` is still the only slash command.

**Twelve new MCP tools**, bringing the total to 32.

### Changed

- `/jarbis` now states its precedence explicitly: the user's instruction,
  then project conventions, then the resolved workflow and its gates, then
  pack skills, then baselines, and the agent's own defaults last. It does
  **not** override safety or destructiveness, and says so.
- `myjarbis status` reports how the project resolved, its org and pack
  revision, where the brain lives, and the schema version.
- `myjarbis update` was rewritten — see below.
- `myjarbis init` records the git remote and accepts `--org`, `--yes`,
  `--skip-memory` and `--isolation`.

### Fixed

Several of these were load-bearing failures that had gone unnoticed
because they fail silently.

- **`install.sh` wrote an invalid project registry.** A quoted heredoc
  left `$(date ...)` literal, and its inner quotes closed the JSON string
  early — so every fresh install shipped a registry that fails to parse,
  and the first `myjarbis init` died with `SyntaxError`. Installation was
  a hard blocker for anyone new.
- **`myjarbis update` never updated anything.** It ran `git pull` inside
  the install directory, which `install.sh` populates by copying — there
  was no remote, so it rebuilt the code already present and reported
  success. It also never copied `bin/` or `templates/`, so a new hook
  could not reach an existing installation even in principle.
- **Installing from a working checkout could overwrite your registry**
  with the developer's test projects, because `cp -r global/*` includes a
  gitignored `projects-registry.json` if one is present.
- **Re-running `install.sh` silently un-registered every project**, since
  the registry lives in the directory it removes. It now says so, offers
  `myjarbis update`, and preserves the registry anyway.
- **Any command created a database wherever it ran**, and running one in a
  subdirectory registered a *second* project pointing at that
  subdirectory. Only `init` creates a brain now.
- **Opening a brain migrated it.** Resolution touches every candidate
  database, so merely looking for a project could rewrite the schema of a
  file you never named. Migration is now `myjarbis migrate` alone.
- **The v4 migration could kill itself on a healthy database.** The
  backfill is an `UPDATE`, which fires the FTS sync trigger, which issues
  a `'delete'` op for a row that may not be in the contentless index —
  returning `SQLITE_CORRUPT_VTAB`, "database disk image is malformed". The
  migration now rebuilds the index first, which also repairs a stale one.
- **A multi-statement migration could half-apply** while still bumping the
  version, leaving a database that claims to be migrated but is missing
  columns.
- **`resume` could return the wrong session.** `ended_at` is second-
  granular, so two sessions closed in the same second tied and SQLite was
  free to return either. Automatic closing made that collision ordinary.
- **`skill edit` ignored `--content-from`**, making it unusable from a
  script.
- **`doctor` compared against a hardcoded schema version**, so every
  healthy project was reported as wrong.
- **`init` overwrote Claude Code's `MEMORY.md`**, destroying a running
  session's index of its own memories. It now appends.
- **`myjarbis update --projects` dropped its own flags** (`exec` without
  `"$@"`).
- `myjarbis status` printed `null closed` — `SUM()` over zero rows.
- The README documented `search` as a CLI verb; it is an MCP tool only.

### Security

- Reads are scoped to the connection, not to each query. A read with no
  scope **fails** rather than returning every project; passing another
  project's id is refused; crossing projects requires an explicit scope
  **and a stated reason**. Asserted five ways in `tests/v03-isolation.sh`.
- `providers.config` rejects anything that looks like a credential, both
  on write and again on export — the brain dump is meant to be committed.
  Pointer keys (`token_file`, `token_env`) are allowed; their values are
  still scanned.
- `brain export` is scoped to one project. Unscoped, it would have written
  every tenant's rows into one project's repository.
- `brain import` refuses a brain holding more than one project rather than
  deleting the others, and points at `myjarbis merge`.
- `jira_rules` was removed as a core context kind in favour of
  `tracker_rules`. A vendor's name has no place in the one vocabulary that
  has to be portable across clients.

### Testing

Nine E2E suites, 138 assertions, each generating its own fixture so they
run on any checkout — `tests/run-all.sh`. The three new ones cover tenant
isolation, migrate/merge against three synthetic projects (verifying row
counts arithmetically, that no foreign key crosses a project, that the
self-referential `supersedes` link survives the id remap, and that the
rebuilt FTS index resolves to the *right* rows), and the org pack.

`tests/v03-benchmark.sh` measures reading the brain against searching it.

### Known / deliberate

- Schema upgrades are never automatic. `myjarbis migrate --dry-run` first.
- A shared brain is opt-in; `silo` is still the default.
- `brain import` into a shared brain is unsupported by design; use `merge`.

## v0.2.0

SQLite + FTS5 backend, per-module sessions, a single `/jarbis` command,
git-like CLI, living draw.io diagrams, and the NDJSON brain dump.
