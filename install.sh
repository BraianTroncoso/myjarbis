#!/bin/bash
#
# MyJarbis Global Installation Script
#
# Installs MyJarbis at ~/.myjarbis-global, builds the MCP server,
# registers it with Claude Code, and adds the CLI to PATH.
#

set -e

# Minimal palette: blood red as the only accent.
RED='\033[38;5;88m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# Paths
# Registration goes through `claude mcp add` (step 7), so we deliberately keep
# no path to Claude Code's own config here: it has moved before and would rot.
INSTALL_DIR="$HOME/.myjarbis-global"

section() { echo; echo -e "${RED}${BOLD}$1${NC}"; }
step()    { echo -e "${RED}[$1/7]${NC}  ${BOLD}$2${NC}"; }
ok()      { echo "       OK"; }
note()    { echo -e "       ${DIM}$1${NC}"; }
warn()    { echo -e "       ${RED}WARN${NC}  $1"; }
fail()    { echo -e "       ${RED}${BOLD}FAIL${NC}  $1"; }

echo
echo -e "${RED}${BOLD}MyJarbis${NC} · install"
echo
echo -e "  ${BOLD}Target${NC}  $INSTALL_DIR"
echo -e "  ${BOLD}Author${NC}  Braian Axel Troncoso"
echo -e "  ${BOLD}Repo${NC}    github.com/braiantroncoso/myjarbis"
echo

# ─── preflight ────────────────────────────────────────────────────
if [ ! -f "package.json" ] || [ ! -d "global" ]; then
    echo -e "  ${RED}${BOLD}FAIL${NC}  run this script from the MyJarbis root directory"
    exit 1
fi

# ─── [1/7] prerequisites ──────────────────────────────────────────
step 1 "Check prerequisites"
if ! command -v node &> /dev/null; then
    fail "Node.js not installed (need 18+, https://nodejs.org)"
    exit 1
fi
NODE_MAJOR=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
    fail "Node.js $NODE_MAJOR is too old (need 18+)"
    exit 1
fi
note "Node.js $(node --version)"

if ! command -v npm &> /dev/null; then
    fail "npm not installed"
    exit 1
fi
note "npm $(npm --version)"
ok

# ─── [2/7] install directory ──────────────────────────────────────
step 2 "Prepare install directory"
if [ -d "$INSTALL_DIR" ]; then
    warn "$INSTALL_DIR already exists"

    # An existing install almost always wants `myjarbis update`, not this.
    # Reinstalling removes the directory, and the project registry lives in
    # it — so a fresh install silently un-registers every project. Say that
    # out loud, and say how many, before asking.
    EXISTING_REGISTRY="$INSTALL_DIR/projects-registry.json"
    if [ -f "$EXISTING_REGISTRY" ]; then
        REG_COUNT=$(node -e "
          try {
            const r = JSON.parse(require('fs').readFileSync('$EXISTING_REGISTRY','utf8'));
            console.log(Object.keys(r.projects || {}).length);
          } catch { console.log('?'); }
        " 2>/dev/null || echo '?')
        note "it holds a registry with $REG_COUNT registered project(s)"
        note "reinstalling DELETES that registry (your projects' own"
        note ".myjarbis/ data is untouched, but they stop being listed)"
        echo
        note "to upgrade without losing it, cancel and run:"
        note "  myjarbis update"
        echo
        REGISTRY_RESCUE="$(mktemp)"
        cp "$EXISTING_REGISTRY" "$REGISTRY_RESCUE"
    fi

    if [ -n "${MYJARBIS_ASSUME_YES:-}" ]; then
        note "MYJARBIS_ASSUME_YES set, continuing"
    elif [ -t 0 ]; then
        read -p "       Remove and reinstall anyway? (y/n) " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "       Cancelled"
            exit 0
        fi
    else
        fail "refusing to reinstall over an existing install without a terminal"
        note "run 'myjarbis update', or set MYJARBIS_ASSUME_YES=1 to force"
        exit 1
    fi
    rm -rf "$INSTALL_DIR"
fi
mkdir -p "$INSTALL_DIR"

# Put the registry back. The user agreed to reinstall the CODE; there is no
# reason that should also forget which projects exist.
if [ -n "${REGISTRY_RESCUE:-}" ] && [ -f "$REGISTRY_RESCUE" ]; then
    cp "$REGISTRY_RESCUE" "$INSTALL_DIR/projects-registry.json"
    rm -f "$REGISTRY_RESCUE"
    note "existing registry carried over"
fi
ok

# ─── [3/7] copy files ─────────────────────────────────────────────
step 3 "Copy MyJarbis files"
# Copy the code and templates, NOT local state.
#
# `cp -r global/*` used to be the whole step, and it is a trap: a working
# checkout accumulates `global/projects-registry.json` and stray
# `global/**/.myjarbis/memory.db` files (both gitignored), so installing from
# a checkout that had been used for testing would overwrite the user's real
# project registry with whatever the developer's test runs left behind.
# Those two are state, they belong to the installation, and they are excluded
# here. `myjarbis update` excludes them for the same reason.
for item in global/*; do
    base="$(basename "$item")"
    [ "$base" = "projects-registry.json" ] && continue
    cp -r "$item" "$INSTALL_DIR/"
done
cp -r bin "$INSTALL_DIR/"
find "$INSTALL_DIR" -type d -name '.myjarbis' -prune -exec rm -rf {} + 2>/dev/null || true

# Record where this was installed FROM, so `myjarbis update` can pull and
# re-sync without the user having to remember the path. The install dir is a
# copy, not a clone, so it has no remote of its own to pull from — which is
# precisely why `myjarbis update` never actually updated anything before.
printf '%s\n' "$(pwd)" > "$INSTALL_DIR/.source"

CRITICAL_FILES=(
    "$INSTALL_DIR/mcp-server/package.json"
    "$INSTALL_DIR/templates/.claude/commands/jarbis.es.md"
    "$INSTALL_DIR/templates/.claude/commands/jarbis.en.md"
    "$INSTALL_DIR/templates/.claude/commands/jarbis.pt.md"
    "$INSTALL_DIR/templates/auto-memory/MEMORY.md"
    "$INSTALL_DIR/bin/myjarbis"
    "$INSTALL_DIR/bin/myjarbis-init"
    "$INSTALL_DIR/bin/myjarbis-doctor"
    # Every command sources this on its first lines, so a copy that missed it
    # produces five broken commands and no clue which file is absent.
    "$INSTALL_DIR/bin/myjarbis-env.sh"
)
for file in "${CRITICAL_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        fail "critical file missing: $file"
        exit 1
    fi
done
ok

# ─── [4/7] projects registry ──────────────────────────────────────
step 4 "Initialize projects registry"
REGISTRY_FILE="$INSTALL_DIR/projects-registry.json"
if [ ! -f "$REGISTRY_FILE" ]; then
    # Expand the timestamp BEFORE the heredoc. Interpolating it inside a
    # heredoc is what broke this: the delimiter was quoted ('EOF'), so the
    # command substitution stayed literal, and its inner double quotes closed
    # the JSON string early. Every fresh install then died on the first
    # `myjarbis init` with a JSON parse error.
    REGISTRY_NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
    cat > "$REGISTRY_FILE" << EOF
{
  "_comment": "Auto-generated by MyJarbis. Do not edit manually.",
  "_version": "1.0",
  "_lastUpdated": "$REGISTRY_NOW",
  "projects": {}
}
EOF
    if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$REGISTRY_FILE"; then
        fail "wrote an invalid projects registry at $REGISTRY_FILE"
        exit 1
    fi
    ok
else
    note "registry already exists, keeping it"
fi

# ─── [5/7] dependencies ───────────────────────────────────────────
step 5 "Install MCP server dependencies"
note "running npm install (30-60s)..."
cd "$INSTALL_DIR/mcp-server"
npm install 2>&1 | grep -v "npm WARN" || true
ok

# ─── [6/7] build ──────────────────────────────────────────────────
step 6 "Build MCP server"
npm run build 2>&1 | tail -1
if [ -f "build/index.js" ]; then
    ok
else
    fail "build failed — index.js not found"
    exit 1
fi

# ─── [7/7] Claude Code registration ───────────────────────────────
step 7 "Register MCP server with Claude Code"
MCP_SERVER_PATH="$INSTALL_DIR/mcp-server/build/index.js"

if ! command -v claude &> /dev/null; then
    warn "Claude Code CLI not found"
    note "install from https://claude.ai/claude-code, then run:"
    note "  claude mcp add myjarbis node $MCP_SERVER_PATH"
else
    if claude mcp list 2>/dev/null | grep -q "myjarbis"; then
        note "already registered (verify with: claude mcp list)"
    else
        claude mcp add myjarbis node "$MCP_SERVER_PATH" >/dev/null 2>&1
        if claude mcp list 2>/dev/null | grep -q "myjarbis"; then
            note "registered"
        else
            warn "automatic registration failed"
            note "run manually: claude mcp add myjarbis node $MCP_SERVER_PATH"
        fi
    fi
fi
ok

# ─── PATH setup ───────────────────────────────────────────────────
section "PATH"
SHELL_RC=""
if [ -n "$BASH_VERSION" ]; then
    SHELL_RC="$HOME/.bashrc"
elif [ -n "$ZSH_VERSION" ]; then
    SHELL_RC="$HOME/.zshrc"
fi

if [ -n "$SHELL_RC" ]; then
    if ! grep -q "myjarbis-global/bin" "$SHELL_RC"; then
        echo "" >> "$SHELL_RC"
        echo "# MyJarbis CLI" >> "$SHELL_RC"
        echo "export PATH=\"\$HOME/.myjarbis-global/bin:\$PATH\"" >> "$SHELL_RC"
        echo "  added to $SHELL_RC"
        echo -e "  ${RED}WARN${NC}  reload your shell: source $SHELL_RC"
    else
        echo "  already in PATH"
    fi
fi

chmod +x "$INSTALL_DIR/bin/myjarbis"
chmod +x "$INSTALL_DIR/bin/myjarbis-init"
chmod +x "$INSTALL_DIR/bin/myjarbis-update"
chmod +x "$INSTALL_DIR/bin/myjarbis-doctor"

# ─── done ─────────────────────────────────────────────────────────
section "Install complete"
echo
echo -e "  ${BOLD}Installed${NC}  $INSTALL_DIR"
echo -e "  ${BOLD}Commands${NC}   myjarbis, myjarbis init, myjarbis doctor"
echo -e "  ${BOLD}Templates${NC}  Laravel, Express, generic"
echo

section "Next"
echo
if [ -n "$SHELL_RC" ]; then
    echo -e "  ${RED}\$${NC} source $SHELL_RC"
fi
echo -e "  ${RED}\$${NC} myjarbis doctor"
echo -e "  ${RED}\$${NC} cd ~/projects/my-app"
echo -e "  ${RED}\$${NC} myjarbis init"
echo -e "  ${RED}\$${NC} claude"
echo -e "  ${RED}>${NC} /jarbis"
echo
echo -e "  ${DIM}docs: github.com/braiantroncoso/myjarbis${NC}"
echo
