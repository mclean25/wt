#!/usr/bin/env bash
# tui-test.sh — drive a REAL wt TUI in a throwaway tmux session, for
# agents (and humans) validating or investigating TUI behavior.
#
# The instance runs against the user's real config and state, so treat
# it as read-only: navigate, open pickers/overlays, Esc out. NEVER
# confirm destructive prompts (d, c, Ctrl+R), and never press keys that
# attach sessions (F10/F11/F12, ; , . m /) — those hand the terminal to
# wt's private tmux server and the probe pane will just look hung.
# Also never press keys that mutate real state WITHOUT a confirm step:
# a (archive/restore), J/K (move row), L (rename section), ! (actions —
# even opening the picker risks a stray dispatch). A probe once archived
# a real row and another cold-started a live agent session this way.
#
#   scripts/tui-test.sh start [name] [width] [height]  # default: probe 200x50
#   scripts/tui-test.sh keys  <name> <tmux keys...>    # e.g. keys probe j j Escape
#   scripts/tui-test.sh snap  [name]                   # visible pane as plain text
#   scripts/tui-test.sh snap-color [name]              # with SGR codes (verify colors)
#   scripts/tui-test.sh ls                             # list probe sessions
#   scripts/tui-test.sh stop  [name]                   # kill one probe
#   scripts/tui-test.sh stop-all                       # kill the whole probe server
#
# Gotchas:
#   - tmux eats a lone ";" (its command separator) — send '\;' instead.
#   - `keys` sleeps briefly after sending so the next `snap` sees the
#     result; slow paths (github fetch, AI summary) may need re-snaps.
#   - Concurrent probes are fine: give each its own <name>.
#   - `start` arms WT_AUTOMATIONS=off (a probe must never dispatch
#     automations alongside the live instance) and WT_GITHUB=off
#     (probes render PR badges from the persisted cache instead of
#     burning API quota — N probes once ate a day's rate limit).
#     Both can be overridden by exporting them before `start`, but ONLY
#     for a sealed second instance (own WT_CONFIG + WT_TMUX_SOCKET,
#     cache_db relocated) — never against the live config. WT_CONFIG
#     and WT_TMUX_SOCKET pass through when exported.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOCK=wt-tui-test
T() { tmux -L "$SOCK" "$@"; }

cmd="${1:-help}"
shift || true

case "$cmd" in
  start)
    name="${1:-probe}" w="${2:-200}" h="${3:-50}"
    T kill-session -t "$name" 2>/dev/null || true
    T new-session -d -s "$name" -x "$w" -y "$h" \
      -e WT_AUTOMATIONS="${WT_AUTOMATIONS:-off}" -e WT_GITHUB="${WT_GITHUB:-off}" \
      ${WT_CONFIG:+-e WT_CONFIG="$WT_CONFIG"} \
      ${WT_TMUX_SOCKET:+-e WT_TMUX_SOCKET="$WT_TMUX_SOCKET"} \
      ${GH_TOKEN:+-e GH_TOKEN="$GH_TOKEN"} \
      -c "$ROOT" "exec bun src/main.ts"
    # Wait for the first painted frame (bun cold start + cache hydrate).
    for _ in $(seq 1 60); do
      out="$(T capture-pane -pt "$name" 2>/dev/null || true)"
      [ -n "${out//[[:space:]]/}" ] && { echo "started $name (${w}x${h})"; exit 0; }
      sleep 0.25
    done
    echo "ERROR: $name never painted (is another probe wedged? try stop-all)" >&2
    exit 1
    ;;
  keys)
    name="${1:?usage: keys <name> <tmux keys...>}"
    shift
    T send-keys -t "$name" "$@"
    sleep 0.4
    ;;
  snap)
    T capture-pane -pt "${1:-probe}"
    ;;
  snap-color)
    T capture-pane -ept "${1:-probe}"
    ;;
  ls)
    T ls 2>/dev/null || echo "(no probe server running)"
    ;;
  stop)
    name="${1:-probe}"
    # kill-session alone HUPs the pane process, which wt (pre-fix) and a
    # wedged bun can survive headless — reap by pane pid to guarantee
    # death. (33 leaked instances were once found burning CPU this way.)
    pid="$(T display-message -pt "$name" '#{pane_pid}' 2>/dev/null || true)"
    T kill-session -t "$name" 2>/dev/null || true
    # Poll ~3s before SIGKILL: wt's own hangup handler allows teardown
    # up to 2.5s before force-exiting, and the harness must not shoot
    # a probe that's mid-graceful-shutdown (that would skip the log
    # flush and re-create the very leak class this reaping guards).
    if [ -n "$pid" ]; then
      for _ in $(seq 1 15); do
        kill -0 "$pid" 2>/dev/null || exit 0
        sleep 0.2
      done
      kill -9 "$pid" 2>/dev/null || true
    fi
    ;;
  stop-all)
    pids="$(T list-panes -a -F '#{pane_pid}' 2>/dev/null || true)"
    T kill-server 2>/dev/null || true
    for pid in $pids; do
      for _ in $(seq 1 15); do
        kill -0 "$pid" 2>/dev/null || continue 2
        sleep 0.2
      done
      kill -9 "$pid" 2>/dev/null || true
    done
    ;;
  *)
    sed -n '2,27p' "${BASH_SOURCE[0]}"
    ;;
esac
