# Upgrading MyJarbis on an existing machine

Written for an agent doing the upgrade on a machine it has not seen before.
Every case below was hit for real on 2026-10-14 while taking one machine from
v0.2 to v0.4.2; none of them are hypothetical.

**Read the whole file before running anything.** Several steps are ordered
because doing them in the wrong order makes things worse, not just slower.

---

## 0. Find out where you are

```bash
myjarbis --version                 # installed CLI
myjarbis status                    # schema + brain of the current project
cat ~/.myjarbis-global/mcp-server/package.json | grep version
```

Three numbers that are often different and all matter:

| | what it is | how to change it |
|---|---|---|
| CLI version | the installed copy under `~/.myjarbis-global` | `myjarbis update` |
| schema version | the shape of each `memory.db` | `myjarbis migrate` |
| skill content | rows inside each brain, not files | `myjarbis skill reseed` |
| slash commands | files in each project's `.claude/commands/` | `myjarbis commands sync` |
| hook wiring | a block in each project's `.claude/settings.local.json` | `myjarbis update --projects-only` |

Updating the code does **not** update the schema, and neither of them updates
the skills, the slash commands or the hook wiring. Five separate steps,
deliberately.

The last row is the one that bites, because it fails silently — see §3.

---

## 1. Before anything: back up

The update itself does not touch a `memory.db`, but you are about to run
commands that can. Take a backup you control.

```bash
BK=~/myjarbis-backup-$(date +%Y%m%d)
mkdir -p "$BK/brains"
find ~ -name memory.db -path '*/.myjarbis/*' 2>/dev/null | while read -r db; do
  rel="${db#$HOME/}"; mkdir -p "$BK/brains/$(dirname "$rel")"
  for ext in "" "-wal" "-shm"; do
    [ -f "$db$ext" ] && cp -p "$db$ext" "$BK/brains/$rel$ext"
  done
done
cp -r ~/.myjarbis-global "$BK/global"
du -sh "$BK"
```

**Copy the `-wal` file. It is not optional.** SQLite in WAL mode keeps recent
writes outside the `.db`. On the machine this was written from, 9.6 MB of data
lived in `-wal` files, and on four projects the `-wal` was *larger than the
database it belonged to*. A backup of `memory.db` alone silently loses them.

Verify the copy rather than trusting it:

```bash
find "$BK/brains" -name 'memory.db' | while read -r c; do
  o="$HOME/${c#$BK/brains/}"
  [ "$(sha256sum "$c" | cut -d' ' -f1)" = "$(sha256sum "$o" | cut -d' ' -f1)" ] \
    || echo "MISMATCH $o"
done; echo "checked"
```

---

## 2. Update the code

```bash
cd <checkout> && git pull
myjarbis update
```

### Case: the install is v0.2 — `update` cannot work

**Symptom:** `myjarbis update` prints something about not being a git
repository, reports success, and `myjarbis --version` is unchanged.

**Cause:** the v0.2 updater ran `git pull` inside `~/.myjarbis-global`, which
`install.sh` populates by *copying*. There is no remote there, so it rebuilt
the code already present. It also never re-copied `bin/`, which is why it
could never replace itself.

**Fix — run the updater from the checkout, once:**

```bash
bash <checkout>/bin/myjarbis-update --from=<checkout>
```

From then on `myjarbis update` works normally; the `--from` path is recorded
in `~/.myjarbis-global/.source`.

### Case: `cannot find the source checkout`

`~/.myjarbis-global/.source` does not exist (installs older than v0.3 never
wrote it). Same fix: pass `--from=<checkout>` once.

### Case: `the checkout has uncommitted changes — not pulling`

Not an error. The updater installs the working tree as-is instead of pulling.
That is usually what you want. If you wanted the remote, commit or stash first.

### Case: `myjarbis-update` dies with a bash error on a line that looks fine

**Run `myjarbis update` again. The second run completes.**

The message is different every time, because it depends on where the read
offset happened to land. Both of these are the same bug:

```
myjarbis-update: line 196: f: command not found
myjarbis-update: line 335: syntax error near unexpected token `('
```

What identifies it is not the text but the shape: a bash error pointing at a
line where nothing is wrong, after step 3 or later, during an upgrade.

This happens at most once per machine, while upgrading *past* the version that
fixed it. Until that fix, step 3 copied `bin/` over the install directory while
the running script WAS `~/.myjarbis-global/bin/myjarbis-update`. `cp` rewrites
a file in place, and bash reads a script incrementally, by byte offset, so the
next read returned the new bytes at the old offset and execution continued
inside a different file. The run that dies has already installed the fixed
script, which is why running it again is all it takes — and why it cannot
happen a third time.

Nothing is left half-applied: the update re-copies and rebuilds from scratch
every time, preserves the registry explicitly, and sweeps any staging file a
dead run left behind. If you want to check rather than trust,
`myjarbis update --no-pull` and read step 5 — every live project should say
`up to date`.

### Do NOT run `install.sh` to upgrade

It is for first installs. On older versions re-running it un-registered every
project, because the registry lives in the directory it removes. `update` is
the supported path and preserves the registry explicitly.

### Verify

```bash
myjarbis --version
myjarbis update --no-pull          # step 5 lists every project's state
```

Expect every live project to read `up to date`. Entries saying `path is gone`
are dead registry rows — see §6.

---

## 3. Refresh the hooks

```bash
myjarbis update --projects-only      # hooks only, nothing else touched
```

**Worth doing even if you migrate nothing.** This is what installs the
`SessionEnd` hook, which is what makes sessions close themselves.

`--projects-only` skips the pull, the re-sync and the rebuild, so it does not
replace the MCP server build a running Claude session is attached to. Use it
when the code is already current and only the projects are behind. Plain
`--projects` does the same repair at the end of a full update.

Neither opens a database.

### Two different ways a project's hooks can be wrong

They have different repairs, which is why they are reported separately:

| state | what it means | repaired by |
|---|---|---|
| `hooks stale` / `missing` | the scripts in `<project>/.claude-plugin/` differ from the template | a file copy |
| `unwired` | the scripts are fine, but nothing in `.claude/settings.local.json` binds them to an event | `myjarbis hook install claude` |
| `partial` | some events are bound and some are not | same as `unwired` |

**`unwired` is the one that hides.** Claude Code reads a plugin's `hooks.json`
only for plugins installed from a marketplace — it never auto-discovers a
`.claude-plugin/` directory in the working tree. So a project can hold a
byte-identical copy of every script and have all five events dead. Nothing
looks wrong: the scripts run perfectly by hand, and until the fix for this the
fleet report called it `up to date` while `update --projects` skipped it for
being "current". Any project initialised before the wiring existed is in this
state.

`update --projects-only` now repairs both, and wires a project whose scripts
were already current without copying anything over.

### Check before and after

```bash
myjarbis health          # whole machine: look for `unwired` in the flags column
myjarbis doctor          # one project: warns "scripts present but NOT wired"
```

Then reopen Claude — hooks are read at startup, so a running session keeps the
old (absent) wiring. **The repair is not visible until you restart.**

### It replaces `.claude-plugin/` wholesale

If a project has hand-edited hook scripts, copy them aside first. The wiring
half is gentler: it rewrites only hook entries whose commands point into
`.claude-plugin/scripts/`, leaves any hook you added yourself in place, and
refuses outright to touch a `settings.local.json` it cannot parse rather than
overwriting your permission allowlist.

---

## 4. The schema (v3 → v4)

Not automatic, and that is deliberate: a schema change should be something you
chose, with a backup you know about.

```bash
myjarbis migrate --all --dry-run > /tmp/dry.json
```

`--dry-run` upgrades a throwaway copy of each file, so the report comes from
the real code path rather than a prediction. Check per project:

- `fromVersion: 3` → `toVersion: 4`
- `integrity: "ok"` and `foreignKeyViolations: 0`
- `changed` holds only `context_kinds 0 → 24` (the new catalogue seeding)

Then one small project first, then the rest:

```bash
cd <small project> && myjarbis migrate && myjarbis status   # expect Schema v4
myjarbis migrate --all
```

Each run leaves `memory.db.pre-v4.<timestamp>` next to the brain, WAL included.
To roll back, rename it to `memory.db`.

### Case: the brain is on an older CLI

`migrate` refuses to run across versions it does not understand. Do §2 first.

### Case: more brains than the registry knows about

`migrate --all` covers the global brain plus every registered project. Stray
brains elsewhere — left by the pre-v0.3 bug where any command created a
database wherever it ran — are not covered and usually hold zero rows. Find
them, and check before deleting:

```bash
find ~ -name memory.db -path '*/.myjarbis/*' 2>/dev/null
```

---

## 5. Skills live in the database, not in files

This is the step most likely to be forgotten. `update` copies **code**. Skills
are rows inside each project's brain, seeded at `init`, so a newer baseline
reaches new projects and nothing else.

```bash
myjarbis skill reseed --all          # report
myjarbis skill reseed --all --apply  # write
```

It refuses to touch `interaction-style`, which is composed per project from the
user's language and persona. Every project legitimately differs from that
baseline, so a hash comparison flags all of them — applying it would replace
the user's configuration with a placeholder everywhere at once.
`--include-owned` overrides, only if that is genuinely meant.

Then open Claude in a project so `.claude/skills/` re-materialises from the DB.

---

## 5b. Slash commands live in files, and also only reach new projects

Same gap, one layer out: `.claude/commands/*.md` is written by `init` and by
nothing else, so a project created before a command existed never gets it.
On the machine this was written from, all 23 projects were missing
`/jarbis-close` and 21 were still carrying a `/jarbis` from an older version
— including the MyJarbis repo itself, which was running the v0.2 copy.

```bash
myjarbis commands sync --all          # report
myjarbis commands sync --all --apply  # write
```

The report classifies every file, and the classification is the point:

| status | meaning | `--apply` writes it? |
|---|---|---|
| `current` | identical to the template for the project's language | no, nothing to do |
| `new` | the project never got this command | yes |
| `other-language` | matches another language's template, so it is ours and only the language is stale | yes |
| `old-shipped-version` | byte-identical to a template MyJarbis shipped at some earlier commit: ours, just stale | yes |
| `diverged` | matches nothing MyJarbis has ever shipped, so a human edited it | **no** — needs `--force` |

`old-shipped-version` is matched by git object name against the history of the
source checkout, so a hand-edited file cannot be mistaken for one — it would
have to collide byte-for-byte with a version that was actually released. That
is what keeps `--force` meaning "overwrite something a person wrote" rather
than "I could not tell, please decide".

If the source checkout is gone, there is no history to ask and those files
report `diverged` instead. Pass `--from=<checkout>` to `update` once to record
it again (§2).

Diff a `diverged` file before reaching for `--force`:

```bash
diff <project>/.claude/commands/jarbis.md \
     ~/.myjarbis-global/templates/.claude/commands/jarbis.en.md
```

Unlike skills, this takes effect with no re-materialisation — the file on disk
*is* the command.

---

## 6. Clean up what previous versions left behind

```bash
myjarbis gc                 # report
myjarbis gc --apply         # remove
```

Collects dead registry rows, `mcpServers.myjarbis` entries in `~/.claude.json`
for directories that no longer exist, superseded brain backups older than
`--older-than` (30 days), and Claude Code project directories holding nothing
but a generated `MEMORY.md`.

Never collects rollback copies (`.silo-retired-`, `.merged-`) or any directory
containing a session transcript. Backs up the registry and `~/.claude.json`
before editing either.

Expect a lot on a machine that has run the test suite: 198 dead MCP
registrations and 122 project directories on the one this was written from,
both caused by `--skip-memory` being dropped before v0.3.1.

```bash
myjarbis backfill-remotes --apply
```

Records the git remote on projects that predate the field, so resolution
survives a clone to a different path. Pre-v0.3 projects all lack it.

---

## 7. Two leaks worth checking on any machine that ran an older version

**A brain may be sitting un-ignored in a repo.** Before v0.3.1, `migrate` wrote
`memory.db.<label>.<timestamp>` and none of the patterns `init` adds to
`.gitignore` matched it. A full, readable brain — session summaries, notes,
client names — could be committed by one `git add -A`.

```bash
git log --all -- '*memory.db.pre-v4*'     # in each repo
```

If anything comes back, the history needs rewriting, not just a delete.

**`~/.myjarbis-global/backups/` may already be gone.** Before v0.3.1, `update`
swept every `.myjarbis` directory under the install dir, and each snapshot
under `backups/` contains one by design. Fixed, but the deletion is not
recoverable.

---

## 8. The shared brain is opt-in, and has a second half

Migrating does **not** move anything into `~/.myjarbis/memory.db`. Every
project stays `isolation = silo` unless merged deliberately.

```bash
myjarbis merge --from=<project>/.myjarbis/memory.db --dry-run
myjarbis merge --from=<project>/.myjarbis/memory.db --retire-source
```

**`--retire-source` is the part that makes it take effect.** Resolution prefers
a silo over the shared brain unconditionally, so without it the rows land, the
old file keeps winning, and the copy goes stale immediately. The flag renames
the source aside only after counts, integrity and foreign keys check out —
rename it back to roll the project back to its own brain.

Project names are unique per brain. Check for collisions before merging several
machines' worth of projects into one; `--as <name>` renames on the way in.

---

## 9. Restart Claude Code

Replacing the server's code under a live session kills the MCP connection — the
running process keeps the old code in memory and the tools stop responding.
Expected, and the updater says so.

**Close any MyJarbis session before updating, not after.** If you forget,
nothing is lost, but observations from that session cannot be saved until a
restart. Write them to a file in the meantime.

---

## 10. Verify the whole machine

```bash
myjarbis health
```

One view of every project: brain, schema, activity, modules nobody opened, and
how many projects actually use each shipped feature. After a clean upgrade
expect all projects on the current schema, no `hooks stale`, and no `unwired`.

If `unwired` is still there, the usual cause is an install that predates the
detector — **do §2 before §3**, since the repair ships with the code. An older
`update --projects` will report those projects as "up to date" and skip them.

A feature sitting at `0/N` adoption is worth a look — on the machine this was
written from, three of them were at zero because they were unreachable from the
CLI, not because nobody wanted them.

---

## Order, in one block

```bash
# 1 back up (see §1, include -wal)
cd <checkout> && git pull
myjarbis update              # or: bash <checkout>/bin/myjarbis-update --from=<checkout>
myjarbis update --projects-only     # hooks + wiring, in that order for a reason
myjarbis migrate --all --dry-run    # read it
myjarbis migrate --all
myjarbis skill reseed --all --apply
myjarbis backfill-remotes --apply
myjarbis gc                  # read it, then --apply
myjarbis health              # verify
# restart Claude Code
```

Steps 4–8 are each independently optional. Code and hooks are the only ones
that matter for simply being current.
