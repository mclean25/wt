#!/usr/bin/env bash
#
# Blast-radius check: break one module, see which commands still run.
#
# `cli/index.ts` loads commands lazily so that a broken module takes out
# only the commands that actually need it — the property this asserts.
# It once didn't, and one bad export cost every `wt` subcommand on the
# machine for 15 minutes, including the `wt status` agents use to report
# they're stuck.
#
#   scripts/broken-module-check.sh [module] [command…]
#
# `module` is repo-relative (default: the message transport). Each
# `command` is a full argv line, run as-is — pass only argv that is safe
# to execute. The defaults are all `--help`, which is enough: the failure
# being probed happens at import, before any command runs.
#
# Runs against a COPY of src/ in $TMPDIR. The working tree is never
# touched, and neither is any real worktree.
set -u

repo=$(cd "$(dirname "$0")/.." && pwd)
module=${1:-src/core/harness/claude/inject.ts}
shift 2>/dev/null || true

if [ "$#" -gt 0 ]; then
  commands=("$@")
else
  commands=(
    "status --help"
    "ls --help"
    "edge --help"
    "section --help"
    "manager report --help"
    "claude --help"
    "rm --help"
  )
fi

tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
cp -R "$repo/src" "$tmp/src" || exit 1
cp "$repo/package.json" "$tmp/" 2>/dev/null
ln -s "$repo/node_modules" "$tmp/node_modules" 2>/dev/null

if [ ! -f "$tmp/$module" ]; then
  echo "no such module: $module" >&2
  exit 2
fi

# The real outage's shape: a name the module no longer exports. Import
# resolution fails at load, so every importer fails with it.
printf '\nexport { __brokenModuleCheck } from "./%s";\n' \
  "$(basename "$module")" >> "$tmp/$module"

echo "broke: $module"
echo
cd "$tmp" || exit 1
survived=0
broke=0
for cmd in "${commands[@]}"; do
  # shellcheck disable=SC2086
  if err=$(bun src/main.ts $cmd 2>&1 >/dev/null); then
    echo "  ok      wt $cmd"
    survived=$((survived + 1))
  else
    echo "  BROKEN  wt $cmd"
    echo "          $(echo "$err" | head -1)"
    broke=$((broke + 1))
  fi
done
echo
echo "$survived survived, $broke broken"
