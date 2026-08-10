/**
 * Capture surface for errors that would otherwise be printed RAW to
 * stdout/stderr while OpenTUI owns the terminal — Bun's default
 * uncaughtException / unhandledRejection reporters write multi-line
 * stack traces straight into the alternate screen, garbling the panes
 * (that default printer, not any wt code, was the source of the
 * original incident). While the TUI runs, `installProcessErrorCapture`
 * replaces the default with: a small in-memory ring (this module),
 * `log.error` to the daily file, and a `log.event.err` one-liner with
 * `{toast: true}` so the failure flashes in the footer and lands on the
 * attention view even when the overlay can't pop (another modal open).
 * Nothing is EVER written to stdout/stderr while capture is installed.
 *
 * Keep-alive semantics — deliberate: an uncaughtException does NOT
 * exit the process. wt is a long-lived dashboard over external state
 * (tmux sessions, watchers, agent fleets); tearing it down loses more
 * than a possibly-inconsistent internal state costs, and the state
 * sources are re-derived queries that self-heal on the next refetch.
 * The escape hatch is honesty, not death: the capture marks the
 * process DEGRADED (`isProcessDegraded`) and the error overlay renders
 * a "restart when convenient" banner. Unhandled rejections don't set
 * the flag — a dangling promise is annoying, not corrupting.
 * `src/main.ts`'s top-level catch stays the final fallback for errors
 * that escape the TUI entirely (thrown through `runTui()` itself);
 * capture detaches before the renderer is destroyed on that path, so
 * the crash-rollback offer and its verbatim stderr print still work.
 */
import { useSyncExternalStore } from "react";

import { createLogger } from "../core/logger.ts";

const log = createLogger("[error]");

export type ErrorOrigin = "uncaughtException" | "unhandledRejection" | "render";

export type CapturedError = {
  id: number;
  /** First occurrence (ms epoch); `lastAt` tracks dedup repeats. */
  at: number;
  lastAt: number;
  /** Consecutive occurrences with an identical signature. */
  count: number;
  origin: ErrorOrigin;
  name: string;
  message: string;
  /**
   * Full formatted stack, or `String(value)` when the thrown value
   * wasn't an Error. Never trimmed — this is the whole point of the
   * overlay.
   */
  stack: string;
};

/** Ring size: enough to see a cascade's shape, small enough to scan. */
const MAX_ERRORS = 5;

type Listener = () => void;

let ring: readonly CapturedError[] = [];
let nextId = 1;
/** Highest id the user has acknowledged (overlay dismissed). */
let seenThrough = 0;
let degraded = false;
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      // A listener throwing inside error handling must never recurse.
    }
  }
}

function normalize(value: unknown): { name: string; message: string; stack: string } {
  if (value instanceof Error) {
    return {
      name: value.name || "Error",
      message: value.message,
      stack: value.stack ?? `${value.name}: ${value.message}`,
    };
  }
  const text = typeof value === "string" ? value : safeString(value);
  return { name: "thrown value", message: text, stack: text };
}

function safeString(value: unknown): string {
  try {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * Record an error into the ring + daily log. Consecutive captures with
 * an identical signature COLLAPSE into the newest entry (`count`++,
 * `lastAt` refreshed) and skip the log/toast side effects — a throwing
 * interval would otherwise flood the file and pin a permanent toast.
 * The first occurrence of each distinct error always logs (full stack
 * in the file via `log.error` ctx) and flashes a footer toast.
 */
export function captureError(origin: ErrorOrigin, value: unknown): CapturedError {
  const n = normalize(value);
  if (origin === "uncaughtException") degraded = true;
  const last = ring[ring.length - 1];
  if (
    last &&
    last.origin === origin &&
    last.name === n.name &&
    last.message === n.message &&
    last.stack === n.stack
  ) {
    const bumped: CapturedError = { ...last, count: last.count + 1, lastAt: Date.now() };
    ring = [...ring.slice(0, -1), bumped];
    notify();
    return bumped;
  }
  const entry: CapturedError = {
    id: nextId++,
    at: Date.now(),
    lastAt: Date.now(),
    count: 1,
    origin,
    ...n,
  };
  ring = [...ring, entry].slice(-MAX_ERRORS);
  // File record carries the full stack; the pane/toast line stays a
  // one-liner (multi-line event text would fan out one pane row per
  // stack frame). `err` level already surfaces on the attention view,
  // so no attention.* double-emit.
  log.error(`unhandled ${origin}: ${n.message}`, { stack: n.stack, origin });
  log.event.err(`unhandled ${origin}: ${n.name}: ${n.message}`, { toast: true });
  notify();
  return entry;
}

/** Oldest → newest, max `MAX_ERRORS`. */
export function getCapturedErrors(): readonly CapturedError[] {
  return ring;
}

export function latestCapturedError(): CapturedError | undefined {
  return ring[ring.length - 1];
}

/** True once an uncaughtException escaped the event loop this run. */
export function isProcessDegraded(): boolean {
  return degraded;
}

/** Unacknowledged errors exist — drives the overlay auto-pop. */
export function hasUnseenErrors(): boolean {
  const last = ring[ring.length - 1];
  return last !== undefined && last.id > seenThrough;
}

/**
 * Acknowledge everything currently captured. Called when the overlay
 * is dismissed (or handed off via `i`) — a RECURRENCE of the same
 * collapsed entry after acknowledgment stays quiet (same id), while
 * any new distinct error re-pops the overlay.
 */
export function markErrorsSeen(): void {
  seenThrough = nextId - 1;
}

export function subscribeCapturedErrors(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useCapturedErrors(): readonly CapturedError[] {
  return useSyncExternalStore(subscribeCapturedErrors, getCapturedErrors, getCapturedErrors);
}

/** One clipboard/prompt-ready block for a captured error. */
export function formatCapturedError(e: CapturedError): string {
  const when = new Date(e.at).toISOString();
  const repeat = e.count > 1 ? ` (x${e.count}, last ${new Date(e.lastAt).toISOString()})` : "";
  return [`[${e.origin}] ${when}${repeat}`, e.stack].join("\n");
}

/** The `i` investigate prompt — mirrors `buildPerfInvestigationPrompt`. */
export function buildErrorInvestigationPrompt(e: CapturedError): string {
  return [
    "This unhandled error occurred in the running wt TUI — investigate and fix.",
    "",
    "It was captured by the process-level error handler (src/tui/error-store.ts)",
    "instead of being printed to the terminal. Find the throwing code path,",
    "figure out why it escaped its local handling, and fix it at the source.",
    "",
    "---",
    "",
    formatCapturedError(e),
  ].join("\n");
}

/**
 * Install the process-level capture. TUI-only — CLI runs keep Bun's
 * default reporter, whose verbatim stderr print is exactly right when
 * nothing owns the screen. Returns a detach that restores the default
 * (call it AFTER `renderer.destroy()` so a teardown-window error goes
 * back to plain stderr, where `main.ts` can show it).
 *
 * Presence of these listeners is what disables Bun's print-and-exit
 * default; the handlers themselves only record. Nothing here rethrows.
 */
export function installProcessErrorCapture(): () => void {
  const onUncaught = (err: unknown): void => {
    captureError("uncaughtException", err);
  };
  const onRejection = (reason: unknown): void => {
    captureError("unhandledRejection", reason);
  };
  process.on("uncaughtException", onUncaught);
  process.on("unhandledRejection", onRejection);
  const disarmDebugThrow = armDebugThrow();
  return () => {
    process.off("uncaughtException", onUncaught);
    process.off("unhandledRejection", onRejection);
    disarmDebugThrow();
  };
}

/**
 * Permanent env-gated test hook for the capture path (there is no
 * legitimate keybinding that throws, and probes need SOMETHING that
 * does). `WT_DEBUG_THROW=1` (or `=uncaught`) throws from a timer ~1.5s
 * after the TUI starts — an event-loop-level uncaughtException, the
 * exact shape of the original incident. `WT_DEBUG_THROW=rejection`
 * leaves a rejected promise dangling instead. Checked once at startup;
 * inert unless set.
 */
function armDebugThrow(): () => void {
  const mode = process.env.WT_DEBUG_THROW;
  if (!mode) return () => {};
  const timer = setTimeout(() => {
    if (mode === "rejection") {
      void Promise.reject(
        new Error("WT_DEBUG_THROW: synthetic unhandled rejection (test hook)"),
      );
      return;
    }
    throw new Error("WT_DEBUG_THROW: synthetic uncaught exception (test hook)");
  }, 1500);
  timer.unref?.();
  return () => clearTimeout(timer);
}
