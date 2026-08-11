/**
 * Opt-in (`WT_PERF=1`) end-to-end input-latency probe: keypress
 * dispatch → the end of the next painted frame. This is the number the
 * user *feels* on j/k, which the loop-lag probe structurally misses —
 * a block has to exceed its threshold to log, while a laggy keystroke
 * is usually several sub-threshold costs stacked (React commit + tree
 * walk + paint + whatever else shared the tick).
 *
 * Wiring (both ends live behind the same env gate and cost nothing
 * when off):
 *  - `markKeypress()` — first line of the TUI's keyboard dispatch.
 *  - `attachInputLatencyProbe(renderer)` — subscribes to the
 *    renderer's `"frame"` event, which fires AFTER the tree walk and
 *    the native paint; the first such event after a marked keypress
 *    closes the sample. NOT a frame callback: those run at the TOP of
 *    the render loop, before layout and paint, so closing there would
 *    exclude exactly the dominant, board-size-dependent cost this
 *    probe exists to catch (`useScrollbarNoFlash` documents the same
 *    ordering). Marks older than a second are dropped (a key that
 *    painted nothing — cursor at a boundary, swallowed key — must not
 *    pin the next unrelated frame on itself).
 *
 * Samples log as a rolled-up histogram line every `SUMMARY_MS` (grep
 * `input-latency`), plus an immediate warn for any single sample over
 * `SLOW_SAMPLE_MS`. The summary also reports the live-mode duty cycle
 * observed over the window: after the shared-ticker change nothing
 * should hold the renderer in continuous "live" mode, and a nonzero
 * duty here is the regression signal (see CLAUDE.md's Timeline trap).
 */
import { createLogger } from "../logger.ts";

const log = createLogger("[perf]");

const SUMMARY_MS = 60_000;
const SLOW_SAMPLE_MS = 100;
/** A mark this stale belongs to a keypress that painted nothing. */
const MARK_TTL_MS = 1_000;

const armed = (): boolean => !!process.env.WT_PERF;

let pendingMarkMs: number | null = null;
let samples: number[] = [];
let liveChecks = 0;
let liveHits = 0;

/** Call at the top of keyboard dispatch. No-op unless WT_PERF is set. */
export function markKeypress(): void {
  if (!armed()) return;
  // Keep the OLDEST unresolved mark in a burst: latency the user feels
  // is from the first key they pressed, not the last one coalesced
  // into the same frame.
  if (pendingMarkMs === null) pendingMarkMs = performance.now();
}

function pct(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
}

type FrameProbeRenderer = {
  /** EventEmitter surface; `"frame"` fires after the native paint. */
  on: (event: "frame", cb: () => void) => unknown;
  off: (event: "frame", cb: () => void) => unknown;
  readonly isRunning?: boolean;
};

/**
 * Attach the frame-side half to the renderer. Returns a detach
 * function; a no-op pair when the probe isn't armed.
 */
export function attachInputLatencyProbe(
  renderer: FrameProbeRenderer,
): () => void {
  if (!armed()) return () => {};
  const onFrame = (): void => {
    if (pendingMarkMs === null) return;
    const latency = performance.now() - pendingMarkMs;
    pendingMarkMs = null;
    if (latency > MARK_TTL_MS) return;
    samples.push(latency);
    if (latency > SLOW_SAMPLE_MS) {
      log.warn("slow input frame", { latencyMs: Math.round(latency) });
    }
  };
  renderer.on("frame", onFrame);
  const summaryTimer = setInterval(() => {
    // Live-mode duty: sampled on the summary cadence AND every check
    // tick below; isRunning true means something re-armed continuous
    // rendering (a Timeline, requestAnimationFrame) — the exact state
    // the shared ticker exists to prevent.
    liveChecks++;
    if (renderer.isRunning) liveHits++;
    if (samples.length > 0) {
      const sorted = [...samples].sort((a, b) => a - b);
      log.info("input-latency", {
        n: sorted.length,
        p50Ms: Math.round(pct(sorted, 0.5)),
        p90Ms: Math.round(pct(sorted, 0.9)),
        maxMs: Math.round(sorted[sorted.length - 1]!),
        liveDutyPct: Math.round((liveHits / Math.max(1, liveChecks)) * 100),
      });
      samples = [];
    }
    if (liveHits > 0) {
      log.warn("renderer observed in live mode", {
        hits: liveHits,
        checks: liveChecks,
      });
    }
    liveChecks = 0;
    liveHits = 0;
  }, SUMMARY_MS);
  return () => {
    clearInterval(summaryTimer);
    renderer.off("frame", onFrame);
    pendingMarkMs = null;
    samples = [];
  };
}
