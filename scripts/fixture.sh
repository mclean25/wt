#!/usr/bin/env bash
# fixture.sh — build a SEALED wt instance whose board carries every shape
# the renderer branches on, then drive a probe against it.
#
# Why this exists: a conditional affordance renders nothing when its input
# is absent, which looks exactly like one that's broken. A board with no
# stacked-and-co-located rows can't show the stack rail; a board whose
# worktrees have no PRs can't show PR badges. Four "regressions" got
# reported off one such board in a morning, three of them were the absent
# input, and the only thing that settled it was CONSTRUCTING the input.
# That should take a minute, not an argument — so this builds a throwaway
# repo, a config pointing at it, and a fabricated fleet:
#
#   scripts/fixture.sh build              # (re)build the fixture from scratch
#   scripts/fixture.sh probe [name] [w] [h]   # build if needed + start a TUI probe
#   scripts/fixture.sh wt <args...>       # run any wt command against it
#   scripts/fixture.sh env                # path to a sourceable env.sh
#   scripts/fixture.sh rm                 # delete it (and kill its tmux servers)
#
# Everything lives under $TMPDIR/wt-fixture (override: WT_FIXTURE_ROOT).
# It is sealed the way docs/configuration.md describes — own config, own
# cache root, own WT_TMUX_SOCKET — so it shares NOTHING with the live
# instance and the probe harness's read-only rules don't apply: destroy
# rows, confirm prompts, exercise anything.
#
# It drives the working tree's code (`bun src/main.ts`), so the fixture
# reflects the change you're validating, and it builds the board through
# public CLI commands only — when a command's contract changes this
# breaks loudly instead of drifting into a lie.
#
# It also configures a real [dev_server] (a `python3 -m http.server` on
# ports 8700+), so `wt dev start/stop`, port allocation, the row's URL and
# the browser-tab cleanup hanging off the port can all be exercised for
# real without touching a project's dev command.
#
# Known gaps (things a local fixture can't fabricate): PR / check /
# merge-queue badges need GitHub, fold state is TUI-only (press Tab on a
# section header), and a stale work status needs a stale timestamp.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FX="${WT_FIXTURE_ROOT:-${TMPDIR:-/tmp}/wt-fixture}"
FX="${FX%/}"
# Resolve symlinks in the path. macOS's $TMPDIR is /var/... which is a
# symlink to /private/var/..., and `git worktree list` reports physical
# paths — a config whose worktree_root is the symlinked spelling
# discovers zero worktrees and renders an empty, blameless board.
mkdir -p "$(dirname "$FX")"
FX="$(cd "$(dirname "$FX")" && pwd -P)/$(basename "$FX")"
CONFIG="$FX/config.toml"
SOCKET=wt-fixture
PROBE=fixture
PREFIX=fx

die() { echo "ERROR: $*" >&2; exit 1; }

# Run wt against the fixture. Every knob is pinned here rather than
# inherited so an ambient WT_CONFIG in the caller's shell can never
# aim these writes at the live instance.
wtfx() {
  WT_CONFIG="$CONFIG" WT_TMUX_SOCKET="$SOCKET" \
    WT_GITHUB=off WT_AUTOMATIONS=off WT_UPDATE=off WT_SKILLS=off \
    bun "$ROOT/src/main.ts" "$@"
}

new_wt() { # slug [base-ref]
  local slug="$1" base="${2:-}"
  if [ -n "$base" ]; then
    wtfx new "$slug" --base "$base" --no-open --no-install >/dev/null
  else
    wtfx new "$slug" --no-open --no-install >/dev/null
  fi
  printf '.'
}

commit_in() { # slug subject
  (
    cd "$FX/wts/$1"
    echo "$2" >> notes.md
    git add notes.md
    git commit -qm "$2"
  )
}

build() {
  # Refuse to rm -rf a path that isn't ours. "Ours" is judged per entry
  # rather than by origin.git alone, because the corpse of a torn-down
  # fixture is a real state: a wt process outliving the last `rm`
  # recreates `cache/locks`, and a guard keyed on origin.git then refuses
  # to rebuild over a directory it created itself.
  if [ -d "$FX" ]; then
    for entry in "$FX"/* "$FX"/.[!.]*; do
      [ -e "$entry" ] || continue
      case "${entry##*/}" in
        origin.git|main-clone|wts|cache|config.toml|env.sh) ;;
        *) die "$FX holds ${entry##*/}, which no fixture creates — refusing to delete it" ;;
      esac
    done
  fi
  # A probe still attached to the old fixture keeps polling git in a
  # directory this is about to delete, and races the rebuild for index
  # locks. Stop it first.
  bash "$ROOT/scripts/tui-test.sh" stop "$PROBE" >/dev/null 2>&1 || true
  tmux -L "$SOCKET" kill-server >/dev/null 2>&1 || true
  rm -rf "$FX"
  mkdir -p "$FX/cache" "$FX/wts"

  # A trunk to fork from. `origin` is a local bare repo, so nothing here
  # ever reaches a remote and `origin/main` resolves for real.
  git init -q --bare "$FX/origin.git"
  git clone -q "$FX/origin.git" "$FX/main-clone" 2>/dev/null   # "cloned an empty repository"
  (
    cd "$FX/main-clone"
    git config user.email fixture@example.invalid
    git config user.name "wt fixture"
    git checkout -q -b main 2>/dev/null || true
    echo "wt render fixture" > README.md
    git add README.md
    git commit -qm "Initial commit"
    git push -q origin main
    git branch -q --set-upstream-to=origin/main main
  )

  cat > "$CONFIG" <<TOML
# Generated by scripts/fixture.sh. Throwaway — rebuild, never hand-edit.
[paths]
main_clone    = "$FX/main-clone"
worktree_root = "$FX/wts"
cache_db      = "$FX/cache/cache.sqlite"

[branch]
prefix = "$PREFIX"
base   = "main"

[ui]
rows = ["branch", "base", "path", "status", "git"]

# A real, supervised, per-worktree dev server — enough to exercise
# \`wt dev start/stop\`, the row's URL, port allocation, and the browser-tab
# cleanup that hangs off the allocated port. Ports sit well clear of any
# real project's range so a fixture server can never be mistaken for one.
[dev_server]
command    = "python3 -m http.server {{port}} --bind 127.0.0.1"
port_base  = 8700
port_range = 50

[skills]
# Never answer the machine-global skills prompt on the human's behalf.
startup_check = false
TOML

  cat > "$FX/env.sh" <<ENV
# source this to point a shell at the fixture instance
export WT_CONFIG="$CONFIG"
export WT_TMUX_SOCKET="$SOCKET"
export WT_GITHUB=off WT_AUTOMATIONS=off WT_UPDATE=off WT_SKILLS=off
ENV

  printf 'building fleet '

  # --- Inbox: the baselines every other row is read against ------------
  new_wt plain-task;  commit_in plain-task  "Plain unstacked row"
  new_wt dirty-task;  commit_in dirty-task  "Row with uncommitted work"
  echo "scratch" >> "$FX/wts/dirty-task/notes.md"   # leaves it dirty
  new_wt fresh-task   # no commits: the title falls back to the slug

  # --- Every work status, so the dot column shows its whole palette ----
  for s in todo working review needs-testing needs-human ready-low ready-high; do
    new_wt "st-$s"
    commit_in "st-$s" "Status sample: $s"
  done
  wtfx section mv st-todo st-working st-review st-needs-testing \
    st-needs-human st-ready-low st-ready-high "Statuses" >/dev/null
  wtfx status st-todo todo >/dev/null
  wtfx status st-working working >/dev/null
  wtfx status st-review review >/dev/null
  wtfx status st-needs-testing needs-testing >/dev/null
  wtfx status st-needs-human needs-human \
    -m "blocked on a 2FA prompt; tried the keychain path and the scripted login" >/dev/null
  wtfx status st-ready-low ready --risk low \
    -m "Sample ready note.
OPS:      none
REVERT:   safe
IF WRONG: nothing real is behind this row" >/dev/null
  wtfx status st-ready-high ready --risk high \
    -m "Sample high-risk note.
OPS:      none
REVERT:   no: fixture rows are not revertable, they are fabricated
IF WRONG: nothing real is behind this row
UNTESTED: everything, by construction" >/dev/null

  # --- A chain: depth 0/1/2, co-located, so the rail has somewhere to go
  new_wt chain-root;                            commit_in chain-root "Chain root lays the schema"
  new_wt chain-mid  "$PREFIX/chain-root";       commit_in chain-mid  "Chain middle adds the reader"
  new_wt chain-leaf "$PREFIX/chain-mid";        commit_in chain-leaf "Chain leaf wires the cache"
  # Deliberately never committed: a stacked worktree between `wt new` and
  # its first commit shares its parent's tip, which is the population the
  # vacuous-containment guard protects (an empty branch is "not started",
  # never "merged"). Its title falls back to the slug for the same reason.
  new_wt chain-unstarted "$PREFIX/chain-root"
  wtfx section mv chain-root "Chain" >/dev/null   # a stack moves as a unit

  # --- A fan: two siblings off one parent, no order between them -------
  new_wt fan-root;                              commit_in fan-root  "Fan root extracts the client"
  new_wt fan-left  "$PREFIX/fan-root";          commit_in fan-left  "Fan left adds the writer"
  new_wt fan-right "$PREFIX/fan-root";          commit_in fan-right "Fan right adds the reporter"
  wtfx section mv fan-root "Fan" >/dev/null

  # --- A split stack: parent filed away from its children --------------
  # The children draw no rail (it would point at a row that isn't above
  # them) and carry a reference to the section their parent went to.
  new_wt split-parent;                          commit_in split-parent  "Split parent finishes the gate"
  new_wt split-kid-a "$PREFIX/split-parent";    commit_in split-kid-a   "Split child A scopes the brand"
  new_wt split-kid-b "$PREFIX/split-parent";    commit_in split-kid-b   "Split child B retries the lookup"
  wtfx section mv split-parent "Hold: Verify on Dev" --only >/dev/null
  echo " done"

  cat <<'BOARD'

board:
  Inbox                 plain / dirty / no-commit rows, plus the two split
                        children (no rail, "-> Hold: Verify on Dev" reference)
  Statuses              one row per work state, ready at low and high risk
  Chain                 depth 0/1/2 co-located: rail steps right per level,
                        plus a stacked row with zero commits of its own
  Fan                   two siblings sharing depth 1: no implied merge order
  Hold: Verify on Dev   the split parent its two inbox children point at

can't be fabricated locally: PR / check / merge-queue badges (need GitHub),
fold state (press Tab on a section header), stale work statuses (need age).
BOARD
  echo
  echo "probe it:  scripts/fixture.sh probe"
  echo "drive it:  scripts/fixture.sh wt ls"
}

cmd="${1:-build}"
shift || true

case "$cmd" in
  build)
    build
    ;;
  probe)
    name="${1:-$PROBE}" w="${2:-200}" h="${3:-50}"
    [ -f "$CONFIG" ] || build
    WT_CONFIG="$CONFIG" WT_TMUX_SOCKET="$SOCKET" \
      bash "$ROOT/scripts/tui-test.sh" start "$name" "$w" "$h"
    echo "snap:  scripts/tui-test.sh snap $name"
    echo "keys:  scripts/tui-test.sh keys $name j j Tab   (anything goes — it's sealed)"
    ;;
  wt)
    [ -f "$CONFIG" ] || die "no fixture yet — run: scripts/fixture.sh build"
    wtfx "$@"
    ;;
  env)
    [ -f "$FX/env.sh" ] || die "no fixture yet — run: scripts/fixture.sh build"
    echo "$FX/env.sh"
    ;;
  rm)
    bash "$ROOT/scripts/tui-test.sh" stop "$PROBE" >/dev/null 2>&1 || true
    tmux -L "$SOCKET" kill-server >/dev/null 2>&1 || true
    rm -rf "$FX"
    echo "removed $FX"
    ;;
  *)
    sed -n '2,30p' "$0"
    exit 2
    ;;
esac
