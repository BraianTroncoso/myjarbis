#!/bin/bash
#
# Refuse to pack anything that is state rather than product.
#
# A working checkout accumulates a project registry, stray memory.db files
# from test runs, and node_modules. install.sh used to skip them by name,
# one `continue` at a time. The `files` allow-list in package.json is what
# keeps them out of the npm package now; this is the check that the
# allow-list still does, run as `prepack` so `npm pack` and `npm publish`
# both stop before a registry with someone's project paths leaves the
# machine.
#
# --ignore-scripts: this IS the prepack script, and `npm pack` runs prepack.

set -euo pipefail
cd "$(dirname "$0")/.."

LIST="$(npm pack --dry-run --json --ignore-scripts 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const f of JSON.parse(s)[0].files)console.log(f.path)})')"

BAD="$(printf '%s\n' "$LIST" | grep -E '(^|/)(projects-registry\.json|memory\.db[^/]*|\.myjarbis/|node_modules/|build(\.next|\.prev)?/)' || true)"
if [ -n "$BAD" ]; then
    echo "✗ the package would ship state, not product:" >&2
    printf '    %s\n' $BAD >&2
    echo "  tighten \"files\" in package.json" >&2
    exit 1
fi

# And the other direction: what setup needs to find in the package.
for need in bin/myjarbis bin/myjarbis-setup bin/myjarbis-update install.sh \
            global/mcp-server/package.json global/mcp-server/tsconfig.json \
            global/templates/.claude-plugin/hooks/hooks.json; do
    if ! printf '%s\n' "$LIST" | grep -qx "$need"; then
        echo "✗ the package is missing $need, which setup needs" >&2
        exit 1
    fi
done

echo "✓ pack contents: $(printf '%s\n' "$LIST" | wc -l | tr -d ' ') files, no state"
