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

- **Post-sweep stall (`c`), diagnosed 2026-08-13, fix in review.** After a
  clean sweep the render thread blocks in multi-SECOND chunks (measured on
  a sealed fixture: 4104ms / 4209ms / 2650ms back to back, ~12s of a 14s
  window; the input-latency probe logged n=2 samples for that minute
  because keypresses never reached a painted frame). Cause is in the query
  layer, not rendering — see the `trackProp` signature below. A one-line
  fix (`notifyOnChangeProps` on the `useQueries` batches in
  `useWorktreeRows`) takes the worst block to 507ms; the residue is
  subprocess spawns on the main thread plus `refreshAll`'s
  `invalidateQueries(["wt"])` refetching every field of every row.

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
- **Loop stalls corrupt DATA, not just latency.** A blocked event loop
  makes any timeout-vs-IO race resolve the wrong way (libuv runs timers
  before poll), so a stall shows up as a wrong answer somewhere else
  entirely. The dev-server bolt vanishing off rows "when lots is
  happening" was this: a 400ms socket timeout beating a `connect` that
  had already succeeded, reporting a live server as dead. Signature: a
  correctness symptom that only appears under load and clears on `r`.
  When you get one, look for a deadline racing an IO callback before
  looking for a logic bug — and check `grep 'event-loop blocked'` for
  whether stalls exceed that deadline (574ms is on record).
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

- **Permanent live-mode rendering (RESOLVED 2026-08-11, f54910e…0094b27).**
  OpenTUI Timelines held a renderer-wide live request: continuous
  ~60fps full-tree walk + full repaint, `requestRender()` a no-op (so
  keypresses couldn't pull frames forward), ~13% idle CPU per
  instance, cost scaling with board size — the root of "j/k laggy
  when lots is happening". Fixed as a six-part series: shared
  refcounted 100ms ticker replacing all Timelines (f54910e, idle
  0.1%); `useIsFetching` isolated into a memoized TitleBar +
  `React.memo` on WorktreeList/Details (a152a9a); the events feed
  renders a 120-event window behind an exact-height spacer (d6def0c);
  keypress→frame histogram + live-duty instrumentation (e89602b);
  claude jsonl tailing in a worker + per-key registry selectors
  (c832d3c); @opentui 0.1.102 → 0.5.1, native yoga (0094b27). The
  invariants live in docs/architecture.md#rendering--input-latency
  and the Timeline trap in CLAUDE.md. Signature if it regresses:
  idle TUI CPU >5%, or WT_PERF's `input-latency` line showing
  liveDutyPct > 0.
- **Whole-App re-render per fetch event** (fixed a152a9a): keep
  global in-flight counters inside a small leaf component (title
  bar), never at the root — `useIsFetching()` re-renders per fetch
  start/finish anywhere.
- Upstream opentui #1339 (per-frame O(tree) walk) is still open even
  at 0.5.1 — renderable-tree size stays a per-frame tax regardless of
  version; window unbounded buffers.

- **`useQueries` + `combine` is O(N²) per query update.** query-core's
  `QueriesObserver.#trackResult` wraps every result in a tracked-props
  Proxy whose `onPropTracked` callback loops over ALL observers in the
  batch — so one property read inside `combine` costs N `trackProp`
  calls, and a combine reading P props over N queries costs N×P×N. It
  re-runs on EVERY query update in the batch. `useWorktreeRows` puts
  worktrees × 10 fields in one batch: at 28 rows that's 280 queries ×
  5 props × 280 = 392k `trackProp` calls per update, and a `c` sweep
  fires hundreds of updates. Signature: a `bun:jsc` sampling profile
  where `trackProp @ queryObserver.js` is >50% SELF time, under
  `#combineResult` → `performProxyObjectGet`. The escape hatch is
  declaring `notifyOnChangeProps` on the queries — query-core then skips
  the proxy entirely (`!match.defaultedQueryOptions.notifyOnChangeProps`
  is the branch). It is quadratic in BOARD SIZE, so it degrades as the
  fleet grows and is invisible on a small one.
- **React was not the culprit and a React Profiler proved it in one
  run.** Wrapping the root in `<Profiler onRender>` during a 3.6s block
  showed 21 commits totaling 59ms. Do this before chasing render cost —
  it separates "the tree is expensive" from "something else owns the
  thread" for the price of five lines.
- **`sample <pid>` can't symbolicate JIT frames; `bun:jsc` can.**
  `sample` shows the main thread deep in unnamed `??? (in bun)` frames,
  which is only enough to rule out native work. `import {
  startSamplingProfiler, samplingProfilerStackTraces } from "bun:jsc"`,
  dump on SIGUSR2, and you get named JS frames with source URLs —
  that is what named `trackProp` above. Works on a live TUI, unlike
  `--cpu-prof`.
- **fs.watch on macOS coalesces deletes; it is not a storm.** Deleting a
  20k-file tree under a `recursive: true` watch delivered 233 events and
  3.4ms of callback time total. Rule out the watcher hypothesis with a
  10-line standalone script before designing around it.
- **A heavy sealed fixture reproduces this in ~2 minutes.**
  `scripts/fixture.sh build`, then add landed rows carrying an
  APFS-cloned (`cp -c -R`) 30k-file `node_modules` (gitignore it via
  `main-clone/.git/info/exclude`, or the rows read dirty and the sweep
  keeps them), arm `WT_PERF` on the probe server
  (`tmux -L wt-tui-test set-environment -g WT_PERF 1`) and press `c`.

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
- `WT_PERF=1` loop-lag probe — 100ms sample, warns at >20ms block,
  `grep 'event-loop blocked'` in the daily log. Startup-only.
- `WT_PERF=1` input-latency probe (same arming) — keypress→painted-
  frame histogram, one `input-latency` INFO line per minute
  (p50/p90/max + liveDutyPct), immediate warn on any >100ms sample.
  Samples close on the renderer's post-paint `"frame"` EVENT — a
  frame CALLBACK runs before layout+paint and would exclude exactly
  the board-size-dependent cost (an early probe build did; its 4/6ms
  figures were pre-paint). Fixture baseline, corrected instrument:
  idle p50 5ms / p90 6ms; under file-touch churn p50 6ms / p90 19ms /
  max 20ms; duty 0. TUI CPU: idle ~0-1% (was ~13%), churn ~4%
  (was 81%).
- `wt-state` skill — read-only cache/tmux/log/lock inspection.
- `scripts/tui-test.sh` — probe harness for reproducing TUI-side
  behavior without touching the live instance (read-only rules apply).
