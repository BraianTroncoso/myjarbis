# SDD — Install MyJarbis from npm

| | |
|---|---|
| **Status** | Implemented on `feat/npm-install`; not published (§10.1) |
| **Branch** | `feat/npm-install` |
| **Scope** | `install`, `cli`, `update`, `doctor`, docs |
| **Date** | 2026-11-04 |

## 1. Problem

Installing MyJarbis today is:

```bash
git clone https://github.com/braiantroncoso/myjarbis.git
cd myjarbis && ./install.sh
source ~/.zshrc
```

That has real costs for a new user:

- **A clone the user has to keep.** `install.sh` records the checkout in
  `~/.myjarbis-global/.source`, and `myjarbis update` pulls from it. Moving or
  deleting the folder breaks updates (`fail "no usable source checkout"`).
- **Editing the shell rc.** `install.sh` appends `export PATH=...` to
  `.zshrc`/`.bashrc`, so the command only works after you source the file or
  open a new shell. Shells other than bash and zsh (fish, nushell) get
  nothing at all, because `SHELL_RC` is detected from `$BASH_VERSION` /
  `$ZSH_VERSION`.
- **A build on the user's machine.** TypeScript is compiled on every install.

The goal is the setup every Node CLI already has: one package-manager
command, the binary on the PATH, and `myjarbis update` that just works.

## 2. Goals

1. `npm i -g myjarbis` puts `myjarbis` on the PATH with no shell-rc edit.
2. One explicit command, `myjarbis setup`, does what `install.sh` steps 2–7 do
   today: install dir, registry, dependencies and build. (MCP registration
   is per project, by `myjarbis init`; see §5.4 step 6.)
3. **Every existing project keeps working with no change.** No re-init, no
   edits to `~/.claude.json`, no re-copied hooks.
4. `myjarbis update` works whichever way you installed (npm or git).
5. A user on the git install can move to npm without losing the registry.
6. A running Claude session survives `setup`/`update` just as well as it
   survives `myjarbis update` today, through the same swap-by-rename.

## 3. Non-goals

- **Windows.** The CLI is bash. The package declares `"os": ["darwin", "linux"]`
  so npm refuses the install there instead of half-installing.
- **Rewriting the bash CLI in Node.** Out of scope. Only the delivery
  mechanism changes.
- **Removing `install.sh`.** The git channel stays for contributors and
  anyone who wants to run from a checkout.
- **Publishing.** This spec makes the package publishable and testable with
  `npm pack`. Claiming the `myjarbis` name and running `npm publish` is the
  maintainer's call (see §10).

## 4. Current state (what the design must not break)

`~/.myjarbis-global` is both the **code** and the **runtime state**, and the
code path is hard-coded **outside this repository**, in places an update can't
reach:

| Where | What it points at | Written by |
|---|---|---|
| `~/.claude.json` → `projects[<path>].mcpServers.myjarbis.args` | `~/.myjarbis-global/mcp-server/build/index.js` | `myjarbis init`, once per project |
| `<project>/.claude-plugin/scripts/*.sh` | `${MYJARBIS_INSTALL_DIR:-$HOME/.myjarbis-global}/mcp-server/build/cli.js` | `myjarbis init`, copied per project |
| `claude mcp` user-scope entry | `~/.myjarbis-global/mcp-server/build/index.js` | `install.sh` step 7 |
| `commands.ts → templatesRoot()` | `<install>/templates`, derived from its own location | — |
| `health.ts`, `org/registry.ts` | `$MYJARBIS_INSTALL_DIR` or `~/.myjarbis-global` | — |

State that also lives there: `projects-registry.json`, `backups/`, `.source`.

`bin/myjarbis-update` already has the hard parts:

- `--from=<dir>` syncs from any directory that looks like a checkout
  (`global/` + `install.sh`) and remembers it in `.source`;
- `--no-pull` skips the `git pull`;
- the sync swaps files by rename, so it never overwrites a script that is
  running (the 2026-10-20 crash);
- `npm install` runs only when the dependencies changed, because it replaces
  `better_sqlite3.node`, which a running server has mapped into memory;
- the build goes into `build.next` and is swapped in by rename, with rollback
  kept in `build.prev`;
- it propagates hooks, commands and skills to registered projects.

## 5. Design

### 5.1 Core decision: npm delivers, `~/.myjarbis-global` stays the runtime

The npm package is a **delivery vehicle**, not the installation. `myjarbis
setup` syncs the package contents into `~/.myjarbis-global` with the same code
path `myjarbis update` already uses. After that, everything runs from
`~/.myjarbis-global` exactly as it does today.

```
npm i -g myjarbis
  └─ <npm-prefix>/lib/node_modules/myjarbis/      ← package (read-only to us)
       ├─ bin/myjarbis            ← on PATH via npm's bin link
       ├─ global/{core,templates,mcp-server/src,…}
       └─ install.sh

myjarbis setup
  └─ myjarbis-update --from=<package dir> --no-pull
       └─ ~/.myjarbis-global/                    ← runtime, unchanged layout
            ├─ bin/  mcp-server/build/  templates/  core/
            ├─ projects-registry.json  backups/
            └─ .source  .channel
```

Why this and not running straight from `node_modules`:

- **Nothing in §4's table changes.** Every `~/.claude.json` entry and every
  copied hook script keeps resolving. A direct-run design would need every
  registered project rewritten, which is a migration with a backup step, for
  no benefit to the user.
- **nvm-proof.** With nvm, the global prefix moves with the Node version
  (`~/.nvm/versions/node/v20.x/lib/node_modules`). A path registered into
  Claude from there breaks the day the user runs `nvm use 22`. The runtime
  path never moves.
- **`npm update -g` can't kill a running session.** npm replaces the package
  directory in place. If the MCP server ran from there, an update would delete
  the `.node` file a live session has mapped. With this design npm only
  touches the package, and the runtime is swapped by `setup`'s rename logic,
  which already handles running sessions.
- **One sync path.** `install.sh`, `update` and `setup` end up as three ways
  into the same code, not three implementations.

### 5.2 The package: zero runtime dependencies

The root `package.json` declares **no `dependencies`**. `better-sqlite3`, the
MCP SDK and TypeScript stay in `global/mcp-server/package.json` and get
installed **in the runtime** by `setup`, with `npm install`, as they are today.

This matters because of the package manager choice:

- **pnpm ≥ 10 blocks dependency build scripts by default.** If the package
  depended on `better-sqlite3` and the user installed with pnpm, the native
  module would never compile and the server would fail at first launch,
  unless the user runs `pnpm approve-builds -g`, which nobody knows to do.
- With zero runtime deps, `pnpm add -g myjarbis`, `bun add -g myjarbis` and
  `npm i -g myjarbis` are all the same instant download. The native build
  always happens via `npm` inside the runtime, which is the path tested
  today.

`npm` is a hard requirement either way (it ships with Node). The docs show
`npm i -g` first; pnpm/bun are listed as equivalent.

`package.json` changes:

```jsonc
{
  "name": "myjarbis",
  "bin": { "myjarbis": "bin/myjarbis" },
  "os": ["darwin", "linux"],
  "engines": { "node": ">=18.0.0" },
  "files": [
    "bin/",
    "install.sh",
    "global/core/",
    "global/templates/",
    "global/mcp-server/src/",
    "global/mcp-server/package.json",
    "global/mcp-server/tsconfig.json",
    "CHANGELOG.md"
  ],
  "scripts": {
    "prepack": "scripts/check-pack.sh"
  }
}
```

The `files` allow-list is the important part. A working checkout piles up
`global/projects-registry.json`, stray `global/**/.myjarbis/memory.db` and
`node_modules/`. `install.sh` step 3 already excludes those by hand. An
allow-list makes it structurally impossible to ship someone's registry to
npm. `scripts/check-pack.sh` runs `npm pack --dry-run --json` and fails if
any path matches `projects-registry.json`, `memory.db`, `.myjarbis/` or
`node_modules/`.

The source is shipped, not the build. The runtime builds with the pipeline
`update` already has (`build.next` → rename). Shipping a prebuilt `build/` is
a possible later optimisation (§10). It is not needed for v1 and would add a
second build path.

### 5.3 `bin/myjarbis` as the npm entry point

npm links `<prefix>/bin/myjarbis` → `<package>/bin/myjarbis`. The dispatcher
already prefers `$INSTALL_DIR/bin/<sub>`, so after `setup` every subcommand
runs the runtime copy. Three additions:

1. **Resolve its own location through symlinks.** `$0` is npm's bin
   symlink. A small `while [ -L ]` loop gives `PKG_DIR` (no `readlink -f`,
   which macOS < 12.3 lacks).
2. **`setup` is routed to the package, never to the runtime.** On a fresh
   machine the runtime doesn't exist yet, and on an upgrade the package is
   the newer of the two.
3. **Version drift hint.** When `PKG_DIR` is an npm install and
   `$PKG_DIR/package.json` version ≠ `$INSTALL_DIR/.version`, print one dim
   line before running the command:
   `myjarbis 0.6.0 installed, runtime is 0.5.1 — run: myjarbis setup`.
   It's a hint, not an automatic sync: `setup` swaps the server build, and
   that decision belongs to the user (see the update preflight).
   If the runtime doesn't exist at all, every command except `setup`,
   `help` and `doctor` fails with
   `MyJarbis is installed but not set up — run: myjarbis setup`.

### 5.4 `myjarbis setup` (new: `bin/myjarbis-setup`)

```
myjarbis setup [--yes] [--dry-run] [--no-projects] [--from=<dir>]
```

| Step | What | Reuses |
|---|---|---|
| 1 | Prerequisites: node ≥ 18, npm, (warn) `claude`, (warn) `python3` (used by `init`) | `install.sh` step 1 |
| 2 | Create `~/.myjarbis-global` if missing; never remove it | — (replaces `install.sh`'s `rm -rf`) |
| 3 | Create `projects-registry.json` if missing | `install.sh` step 4 |
| 4 | Sync from `--from` or `PKG_DIR`: `myjarbis-update --from=<dir> --no-pull` (forwarding `--yes`, `--dry-run`, `--no-projects`) | all of `update` |
| 5 | Write `.channel` (`npm` / `git`) and `.version` | — |
| 6 | Check that `claude` is installed. **Registers nothing** (see below) | — (replaces `install.sh` step 7) |
| 7 | Run `myjarbis doctor` | `doctor` |

Properties:

- **Idempotent.** Running it twice does nothing the second time beyond
  "dependencies unchanged".
- **Never destroys the registry.** `install.sh` today `rm -rf`s the install
  dir and rescues the registry through a temp file. `setup` never deletes
  the directory, so it needs no rescue.
- **No `postinstall`.** npm ≥ 7 hides lifecycle-script output, pnpm and bun
  skip it by default, and changing the user's Claude
  config is not something to do without them seeing it. `setup` is explicit,
  repeatable and loud. The README's install block is two lines.

**No `claude mcp add`.** The first draft kept `install.sh` step 7, and the
smoke test on a real machine showed why that was wrong: without `--scope`,
`claude mcp add` registers for the **current directory**. Run from `~`, it
registered the user's home as a project; `install.sh` registered the
checkout. The registration that counts is per project, written by
`myjarbis init` into `~/.claude.json` with the runtime path. User scope was
the alternative and was rejected: it would load the server in every Claude
session on the machine, MyJarbis project or not.

`update`'s source check (`global/` + `install.sh`) already holds for the
package because `install.sh` is in `files`.

### 5.5 `myjarbis update` by channel

`.channel` decides it. When it's missing (an install from before this change)
the channel is `git`, which is the current behaviour.

| Channel | `myjarbis update` does |
|---|---|
| `git` | Unchanged: pull `.source`, sync, deps, build, propagate. |
| `npm` | 1. `npm i -g myjarbis@latest` (or the package manager that installed it, see below). 2. `exec` the **new** package's `bin/myjarbis-setup --yes-if-given`. |

Step 2 `exec`s the newly installed script rather than continuing in the
running one, the same self-overwrite hazard as 2026-10-20: step 1 just
replaced the file this process is reading.

Package-manager detection, in order: `PKG_DIR` contains `/.pnpm/` or lives
under `pnpm root -g` → pnpm; under `~/.bun/` → bun; otherwise npm. If it
can't tell, it prints the command for the user instead of guessing.

`myjarbis update --from=<checkout>` on the npm channel switches it to `git`.
`myjarbis setup` from a package switches it to `npm`. The channel always
follows where the code came from last.

### 5.6 `install.sh` becomes a thin wrapper

```bash
./install.sh   ≡   bin/myjarbis-setup --from="$(pwd)"   +   the PATH block
```

It keeps the PATH block (a git install has no npm bin link) and drops its
own copy/registry/deps/build/register steps in favour of `setup`. One code
path for both channels. The `rm -rf` reinstall prompt goes away. A user who
really wants a clean slate deletes the directory themselves.

### 5.7 `doctor` additions

- **Channel and versions:** package version (if npm), runtime `.version`,
  build present.
- **Stale PATH entry:** on the npm channel, if `~/.myjarbis-global/bin` is
  still in the shell rc, report it as removable (still harmless: it points
  at the same runtime). Report only, never edit the rc.
- **Native module ABI:** open an in-memory database with
  `<runtime>/mcp-server/node_modules/better-sqlite3` (a bare `require` does
  not load the binding). Catches the nvm case where the `node` Claude spawns
  is not the one the module was built with (`NODE_MODULE_VERSION`
  mismatch). Fix suggested: `npm rebuild better-sqlite3` in the runtime
  under the right Node. Not `myjarbis setup`, which reinstalls dependencies
  only when their list changed. This risk exists today. npm just makes it
  more likely to surface.

## 6. Flows

**Fresh machine**

```bash
npm i -g myjarbis
myjarbis setup
myjarbis init --list ~/projects
myjarbis start
```

**Upgrade (npm)**

```bash
myjarbis update        # = npm i -g myjarbis@latest && myjarbis setup
```

**Migrating from a git install**

```bash
npm i -g myjarbis
myjarbis setup         # syncs over the same ~/.myjarbis-global, keeps the registry
# optional: remove the "# MyJarbis CLI" PATH line from ~/.zshrc (doctor points at it)
```

No project is touched beyond what `update` already propagates (hooks,
commands, skills). The checkout can be deleted afterwards.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Shipping local state to npm (registry, `memory.db`) | `files` allow-list + `prepack` check that fails the pack |
| pnpm blocks native builds | Zero runtime deps. The native build runs in the runtime via npm (§5.2) |
| nvm moves the global prefix | Nothing registers a path inside the prefix. Only the runtime path is registered (§5.1) |
| Node ABI mismatch between npm's node and Claude's node | `doctor` check (§5.7). Pre-existing |
| `npm update -g` while Claude runs | npm only touches the package. The runtime swap is `update`'s existing preflight + rename (§5.1) |
| `update` replacing its own script mid-run | The npm channel `exec`s the freshly installed `setup` (§5.5) |
| Two PATH entries after migrating | Both resolve to the same runtime. `doctor` reports the stale one |
| Windows users | `"os"` field makes npm refuse with a clear message |

## 8. Alternatives considered

- **Run directly from `node_modules`, register the package path in Claude.**
  Rejected: breaks every existing project (§4), breaks on `nvm use`, and lets
  `npm update -g` delete files a live session has mapped.
- **Symlink `~/.myjarbis-global/{bin,mcp-server,templates}` → package.** Fixes
  the paths but keeps the other two problems: the target still moves with
  nvm and still gets replaced in place by npm.
- **`postinstall` does the setup.** Rejected: invisible on npm ≥ 7, skipped by
  pnpm/bun, and it edits the user's Claude config without them seeing it.
- **Hoist `better-sqlite3` into the root package.** Rejected: the pnpm build
  approval trap (§5.2).
- **`npx myjarbis` without a global install.** Fine for a one-off, but
  `myjarbis start` is meant to be run from anywhere every day. Could be
  documented as a try-out path later.

## 9. Implementation plan

One commit per row, on `feat/npm-install`. Each one leaves `tests/run-all.sh`
green.

| # | Commit | Content |
|---|---|---|
| 1 | `feat(cli): resolve the package dir through npm's bin symlink` | §5.3 points 1–2; `setup` routed to `PKG_DIR` |
| 2 | `feat(setup): add myjarbis setup on top of update --from` | `bin/myjarbis-setup`, §5.4; writes `.channel`/`.version` |
| 3 | `refactor(install): make install.sh a wrapper over setup` | §5.6; drop the `rm -rf` path |
| 4 | `feat(update): update through the package manager on the npm channel` | §5.5 |
| 5 | `feat(cli): hint when the runtime lags the installed package` | §5.3 point 3 |
| 6 | `feat(doctor): report channel, stale PATH entry and native ABI` | §5.7 |
| 7 | `chore(package): make the root package publishable` | `files`, `os`, `bin`, `prepack` check (§5.2) |
| 8 | `test(install): cover setup from a packed tarball` | §9.1 |
| 9 | `docs: install from npm` | README "Start in 30 seconds", `docs/UPGRADING.md` migration section, CHANGELOG |

### 9.1 Test plan

New suite `tests/npm-install.sh`, self-contained like the others (own
`HOME`, own `npm_config_prefix`, own registry):

1. `npm pack` → assert the tarball has no `projects-registry.json`,
   `memory.db`, `.myjarbis/`, `node_modules/`.
2. `npm i -g <tarball>` into a temp prefix → `myjarbis` resolves on that
   prefix's PATH.
3. Any command before `setup` → the "not set up" message, exit ≠ 0.
4. `myjarbis setup --yes` → runtime layout matches what `install.sh`
   produces today; `.channel` = `npm`; `build/index.js` exists.
5. `myjarbis setup --yes` again → no rebuild of deps, exit 0.
6. Pre-seeded registry with two projects → still there after setup.
7. Bump the package version, reinstall → drift hint printed; `setup` clears it.
8. Git-channel install (current `install.sh`) then npm `setup` → registry
   kept, channel flips to `npm`.

Claude Code is a stub on `PATH` that records its arguments, the same
approach as the existing suites, and the suite asserts that setup never
calls `claude mcp add`.

Manual smoke before merging: real `npm i -g ./myjarbis-*.tgz` on this machine
with an existing git install and a running Claude session, then `/jarbis`
in a registered project.

## 10. Open questions

1. **Package name and ownership.** `myjarbis` is free on npm today. Who
   publishes, and under which account? The maintainer of
   `braiantroncoso/myjarbis` decides. Alternatives: a scope
   (`@braiantroncoso/myjarbis`). The bin stays `myjarbis` either way.
2. **Ship a prebuilt `build/`?** Saves the `tsc` run on every setup/update
   (TypeScript is still needed today because `update` builds). Worth it
   only once the build path is unified. Deferred.
3. **Lockfile.** `global/mcp-server/package-lock.json` is gitignored, so
   runtime installs float within the semver ranges. Shipping the lockfile
   and using `npm ci` would make installs reproducible. That's a separate
   decision, and it applies to the git channel too.
4. **Auto-sync on drift** instead of a hint (§5.3). Starting with the hint;
   revisit if users keep forgetting.
