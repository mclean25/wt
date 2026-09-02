/**
 * Main-thread client for the Codex activity-pane event poller.
 *
 * The worker does the synchronous rollout-tree scan, file reads, and
 * JSON parsing. This module only samples the current active Codex
 * slots from the query cache, posts them to the worker, and forwards
 * worker-emitted event records through the normal logger so file +
 * activity-pane output stay unchanged.
 */
import { createLogger } from "../../logger.ts";
import { Effect, Fiber } from "effect";

import type {
  ActiveCodexSlug,
  CodexEventsWorkerMessage,
  CodexEventsWorkerResult,
} from "./events-protocol.ts";

export type { ActiveCodexSlug };

const log = createLogger("[codex]");
const POLL_INTERVAL_MS = 2_500;

export type CodexEventsWorker = Pick<Worker, "postMessage" | "addEventListener" | "terminate"> & {
  unref?(): void;
};

function post(worker: CodexEventsWorker, msg: CodexEventsWorkerMessage): void {
  worker.postMessage(msg);
}

function emit(result: CodexEventsWorkerResult, onActivity?: () => void): void {
  if (result.type === "warn") {
    log.warn("worker poll failed", { err: result.message });
    return;
  }
  if (result.events.length > 0) onActivity?.();
  for (const event of result.events) {
    log.event[event.level](event.text);
  }
}

/**
 * Start polling codex rollouts for active slots.
 *
 * @param getActiveSlugs - Called on every tick; must return the current
 *   list of active codex tmux slots (slug + worktree path). The caller
 *   should keep this cheap (a Map lookup, not a scan).
 * @param onActivity - Called once per tick that actually observed a
 *   real event (not on an empty/no-change poll). The TUI runtime uses
 *   this to invalidate `codexUsage` — token usage changes exactly when
 *   codex activity happens, so this is a cheap push trigger instead of
 *   leaving that query on poll-only.
 * @returns A cleanup function that stops the interval and terminates
 *   the worker. Call it during TUI shutdown.
 */
export function codexEventPollingEffect(
  getActiveSlugs: () => ReadonlyArray<ActiveCodexSlug>,
  onActivity?: () => void,
  options: {
    workerFactory?: () => CodexEventsWorker;
    intervalMs?: number;
  } = {},
): Effect.Effect<never, never, never> {
  return Effect.scoped(Effect.gen(function* () {
    const worker = yield* Effect.acquireRelease(
      Effect.sync(() =>
        options.workerFactory?.() ??
        new Worker(new URL("./events-worker.ts", import.meta.url).href)),
      (worker) => Effect.sync(() => {
        try { post(worker, { type: "stop" }); } catch { /* terminating below */ }
        try { worker.terminate(); } catch { /* already gone */ }
      }),
    );
    let disposed = false;
    let inFlight = false;

    worker.addEventListener("message", (event: MessageEvent) => {
      inFlight = false;
      if (disposed) return;
      emit(event.data as CodexEventsWorkerResult, onActivity);
    });
    worker.addEventListener("error", (event) => {
      inFlight = false;
      if (disposed) return;
      log.warn("worker error", { err: event.message });
    });
    worker.addEventListener("close", () => {
      inFlight = false;
      if (disposed) return;
      log.warn("worker exited");
    });
    worker.unref?.();

    const tick = (): void => {
      if (disposed || inFlight) return;
      const active = getActiveSlugs();
      if (active.length === 0) {
        post(worker, { type: "poll", active });
        return;
      }
      inFlight = true;
      post(worker, { type: "poll", active });
    };

    const tickEffect = Effect.sync(() => {
      try {
        tick();
      } catch (err) {
        inFlight = false;
        log.warn("poll tick failed", { err: String(err) });
      }
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => { disposed = true; }));
    return yield* Effect.sleep(options.intervalMs ?? POLL_INTERVAL_MS).pipe(
      Effect.andThen(tickEffect),
      Effect.forever,
    );
  }));
}

/** TUI lifecycle adapter. */
export function startCodexEventPolling(
  getActiveSlugs: () => ReadonlyArray<ActiveCodexSlug>,
  onActivity?: () => void,
): () => Promise<void> {
  const fiber = Effect.runFork(codexEventPollingEffect(getActiveSlugs, onActivity));
  return () => Effect.runPromise(Fiber.interrupt(fiber).pipe(Effect.asVoid));
}
