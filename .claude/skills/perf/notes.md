# perf notes — living state

Companion to SKILL.md. Keep current per its §6: refresh the baseline,
track open issues, grow the ledger, prune ruthlessly.

## Baseline (captured 2026-08-09, commit 31734d2)

Machine: 12 cores / 32 GB (Apple Silicon, macOS 25.5).

A representative working afternoon (live TUI + 6 worktree sessions,
one active agent, dev server up):

- Machine-wide: ~110% of 1200% CPU, ~14 GB memory in use. Load avg ~1.9.
- wt-downstream: ~45-50% of that CPU, ~6.4 GB RSS across ~30 procs.
- The active claude agent dominates (~33%, ~1.1 GB); the TUI itself
  idles at ~13% average / ~0.5-0.7 GB RSS.
- Each *idle* worktree session still holds ~0.5-0.8 GB RSS (a resident
  claude + shells). RSS scales with fleet size even when CPU doesn't.
- Typical biggest outsider: browser (Brave ~40-50% across helpers).

Rule of thumb: an idle-ish fleet under ~150% total with agents quiet is
normal. One core pinned (~100%) by a single wt-category process that
should be idle is a bug, not load (see bare-promise signature below).

## Open issues

- **Destroy dispatch double-fetches GitHub** — two concurrent
  `fetching GitHub...` ~40ms apart (double invalidation while the first
  is in flight). Harmless, minor quota waste. Found in dogfood sweep
  (FINDINGS.md), still unfixed.

## Learnings ledger

Failure signatures (check these first):

- **Bun spins at 100% on a bare pending promise.** `await new
  Promise(() => {})` with no other event-loop handle makes Bun busy-spin
  instead of block (bun 1.3.14; 19h CPU burned in `wt _home` once —
  fixed 4e18459 with an inert `setInterval`). Signature: one
  wt-category process pinned at ~100% while functionally idle. Applies
  to any `_`-prefixed entrypoint meant to just sit there (also a
  CLAUDE.md trap).
- **Leaked headless wt instances.** A dead terminal can orphan the TUI
  to launchd (pre-SIGHUP-handler builds, wedged teardowns); each orphan
  keeps polling GitHub and duplicating attention lines. One sweep found
  33. `wt perf` hunts these itself — LEAKED section with a ready `kill`
  line. Propose the kill, don't run it unasked.
- **Heavy parsing on the render thread.** Codex-events JSONL tailing
  used to block the TUI's single JS thread; moved to a worker in
  61634bc (`core/harness/codex-events-worker.ts`). If the loop-lag
  probe shows blocks correlated with a data source, suspect synchronous
  parsing and reach for the same worker pattern.

Measurement traps:

- `ps` `%CPU` is a lifetime decaying average — a 2s-old process is
  barely averaged, a long-lived one remembers old load. `top -l 2`'s
  second sample is instantaneous; use it to disambiguate.
- `os.freemem()` counts only genuinely-free pages (~90% "used" always);
  vm_stat active+wired+compressor is the honest number (`wt perf` does
  this already).
- The idle TUI intentionally does NOT re-render (structural sharing on
  unchanged refetches). Anything time-derived computed at render time
  freezes — the details pane has a 30s tick for exactly this (50d50c3).
  Don't "fix" idle-freeze symptoms by adding polling; add a tick.

Design rules with perf teeth (from CLAUDE.md, restated here because
perf work is where they get bent):

- The github source is ONE batched GraphQL round trip — never split
  into per-row fetches; new PR fields go into `PR_FRAGMENT`.
- Freshness is push-based; never shorten a staleTime to paper over a
  missing invalidation trigger.
- Perf sampling itself is free when idle: the `P` overlay samples only
  while open, `wt perf` is one-shot, nothing persists to the query
  cache. The loop-lag probe (WT_PERF=1) costs one 100ms interval.

Tooling inventory:

- `wt perf` / `wt perf --json` — one-shot snapshot, agent-friendly
  (added 31734d2; also roots at live wt instances so the TUI counts as
  "us" from the CLI).
- TUI `P` overlay — same sampler, 2s cadence while open; `i` injects
  the report into the wt-source session.
- `WT_PERF=1` loop-lag probe — 100ms sample, warns at >50ms block,
  `grep 'event-loop blocked'` in the daily log. Startup-only.
- `wt-state` skill — read-only cache/tmux/log/lock inspection.
- `scripts/tui-test.sh` — probe harness for reproducing TUI-side
  behavior without touching the live instance (read-only rules apply).
