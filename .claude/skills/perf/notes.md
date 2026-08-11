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

- **The TUI renders continuously, forever — permanent "live mode"**
  (found 2026-08-11, j/k-lag investigation; fix proposed, not yet
  applied). OpenTUI is on-demand by default, but any playing Timeline
  holds a refcounted live request that pins the render loop at
  ~60fps, and `RefreshWave`/`useEased` (spinner.tsx) register
  forever-looping timelines at App mount. Every frame walks the whole
  renderable tree, does a yoga-WASM `getComputedLayout()` per visible
  node (scrollbox children pay this even when culled offscreen), and
  fully repaints into the native buffer. Idle cost ~11-14% CPU per
  instance on a tiny fixture board; scales with tree size (the
  500-event activity feed dominates). In live mode `requestRender()`
  is a no-op, so a keypress commit can't pull a frame forward
  (mean +8ms). This is the root of "j/k laggy when lots is
  happening" — see the proposal in the session that added this note.
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

- **Whole-App re-render per fetch event.** `useIsFetching()` sits in
  App itself (app.tsx), so every fetch start/finish anywhere re-renders
  the entire tree — worst exactly during refresh waves. Keep global
  in-flight counters inside a small leaf component (title bar), never
  at the root.
- **@opentui pinned at 0.1.102; upstream is 0.5.x** with real perf
  work landed since: native yoga (vs WASM here), text-measurement
  callback pressure (0.4.3), stdin-parser stuck-bytes race (#891),
  stale-fps/backpressure fixes (0.4.2), faster FFI layout reads
  (0.5.0). Upstream #1339 (per-frame O(tree) walk) is still open even
  at 0.5.1 — tree size stays a per-frame tax regardless of version.

Measurement traps:

- The loop-lag probe's 50ms threshold misses 16-50ms blocks — one to
  three dropped frames each, exactly the range that makes input feel
  laggy. For latency work, measure end-to-end instead: send a key via
  tmux, poll `capture-pane -e` for the selected-row bg SGR
  (`48;2;59;66;82`) to move (scripts from the 2026-08-11 session:
  `/tmp/wt-perf-jk-latency.pl`, churn generator
  `/tmp/wt-perf-fixture-churn.sh` — recreate from git history of this
  note's session if reaped). Fixture baselines at 110x30: j ~34ms /
  k ~22ms median incl. ~10ms of measurement overhead; under
  file-touch churn: TUI CPU 13%→81%, 9 loop blocks >50ms in ~2min,
  p90 ~50ms.
- OpenTUI has native instrumentation: `OTUI_SHOW_STATS=1` (frame-time
  overlay), `OTUI_TRACE_FFI=1` (per-call FFI trace),
  `renderer.getStats()` after `setGatherStats(true)`. The 0.1.102 FPS
  counter is unreliable (fixed upstream 0.4.2, "stale fps"); trust
  frame times + `ps` over it. Frame times exclude the threaded native
  write.
- `bun --cpu-prof` writes nothing when the app exits via
  `process.exit()` (main.ts does) — use macOS `sample <pid>` for
  native-side confirmation instead.
- tmux probe env: `tui-test.sh start` passes only an allowlist of WT_*
  vars, and an already-running probe server won't inherit fresh
  exports — `tmux -L wt-tui-test set-environment -g NAME val` before
  `start` is the reliable way to arm WT_PERF / OTUI_* on a probe.

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
