#!/usr/bin/env bash
# tui-test.sh — drive a REAL wt TUI in a throwaway tmux session, for
# agents (and humans) validating or investigating TUI behavior.
#
# The instance runs against the user's real config and state, so treat
# it as read-only: navigate, open pickers/overlays, Esc out. NEVER
# confirm destructive prompts (d, c, Ctrl+R), and never press keys that
# attach sessions (F10/F11/F12, ; , . m /) — those hand the terminal to
# wt's private tmux server and the probe pane will just look hung.
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
      -e WT_AUTOMATIONS=off -e WT_GITHUB=off -c "$ROOT" "exec bun src/main.ts"
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
    T kill-session -t "${1:-probe}" 2>/dev/null || true
    ;;
  stop-all)
    T kill-server 2>/dev/null || true
    ;;
  *)
    sed -n '2,27p' "${BASH_SOURCE[0]}"
    ;;
esac
