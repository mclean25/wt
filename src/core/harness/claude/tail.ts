/**
 * Per-worktree tailer for the wt-managed interactive `claude` session
 * jsonl. Powers the activity-pane swap when an F12 session is live —
 * the same `ActionLine[]` shape the action runner produces.
 *
 * # Threading
 *
 * The file side lives in a Worker (`tail-worker.ts`): fs.watch,
 * debounce, the polling backstop, byte-offset reads, and jsonl
 * parsing all happen off the render thread — a streaming agent writes
 * multi-kilobyte lines in bursts, and parsing them inline was
 * measurable input latency (same offload as codex's events worker).
 * This module is the main-thread half: it resolves jsonl paths, keeps
 * the observable `runs` map, applies the worker's parsed deltas, and
 * fires the query-refresh sinks. Lifecycle/seeding/pre-creation-race
 * semantics are documented on the worker.
 *
 * # Lifecycle
 *
 * `ensure(slug, wtPath)` is idempotent. The driver (`tui/hooks/useSessionTailReconcile.ts`)
 * calls it for every slug in the live tmux-session set on every
 * `useEffect`; new entries spin up a tailer, the rest no-op. `stop`
 * unwinds one tailer; `reconcile` runs ensure-and-stop together against
 * a fresh live set.
 */
import { join } from "node:path";
import { Effect, Fiber } from "effect";

import {
  type ActionLine,
  MAX_BUFFERED_LINES,
} from "./events.ts";
import { projectDir as claudeProjectDir, wtSessionUuid } from "./jsonl.ts";
import { createLogger } from "../../logger.ts";
import { type RefreshTarget } from "./refresh-triggers.ts";
import {
  type SessionContextUsage,
  applyEmit,
} from "./tail-parse.ts";
import type {
  TailWorkerMessage,
  TailWorkerResult,
} from "./tail-worker-protocol.ts";
import { claudeSessionName } from "../../tmux.ts";

// Compat re-exports: the parse layer moved to `tail-parse.ts` for the
// worker seam; established importers (tests, the footer's context-%
// math) keep reading from here.
export { contextWindowTokens, parseEntry } from "./tail-parse.ts";
export type { SessionContextUsage } from "./tail-parse.ts";

const log = createLogger("[session-tail]");

// ---------------------------------------------------------------------------
// Refresh triggers
//
// While the live tail is reading the jsonl anyway, the worker scans
// each new entry for Bash tool calls (`gh pr create`, `git push`, …)
// that change GitHub-side state; this side asks the runtime to
// invalidate the matching query — see `refresh-triggers.ts`. Detection
// is per-line; delivery is debounced per target so a burst of git/gh
// calls collapses to one refresh, and so the triggering command has
// finished by the time the refetch fires (we match on tool_use, not
// tool_result).
// ---------------------------------------------------------------------------

/** Debounce window for refresh triggers. See block comment above. */
const TRIGGER_DEBOUNCE_MS = 3_000;

/** Tighter window for the per-slug "this jsonl moved" sink. The worker's
 *  80ms read-debounce already coalesces FSEvents bursts at the file
 *  level; this just collapses a turn's worth of appends into one
 *  invalidation pass so `wtClaudeQuery` (ages, queue counts) snaps on
 *  turn end instead of drifting up to its 5s poll. */
const SLUG_CHANGE_DEBOUNCE_MS = 500;

let triggerSink: ((target: RefreshTarget) => void) | null = null;
const triggerFibers = new Map<RefreshTarget, Fiber.RuntimeFiber<void, never>>();
let slugChangeSink: ((slug: string) => void) | null = null;
const slugChangeFibers = new Map<string, Fiber.RuntimeFiber<void, never>>();

/**
 * Register the refresh-trigger sink. The TUI runtime wires this to the
 * QueryClient so a `gh pr create` in a live session invalidates
 * `["github"]` immediately instead of waiting out its slow staleTime.
 * CLI runs leave it unset — triggers are a silent no-op there. Pass
 * `null` on shutdown; pending debounce timers are cleared.
 */
export function setSessionTriggerSink(
  fn: ((target: RefreshTarget) => void) | null,
): void {
  triggerSink = fn;
  if (!fn) {
    for (const fiber of triggerFibers.values()) Effect.runFork(Fiber.interrupt(fiber));
    triggerFibers.clear();
  }
}

/**
 * Register the per-slug claude-jsonl-moved sink. Fires (debounced) when
 * any live session jsonl for that slug grows — the runtime invalidates
 * `qk.wt(slug).claude()` so the row's last-activity age and queue count
 * snap on turn end. Scoped to one slug; the broader `["github"]` &c
 * still come through `setSessionTriggerSink` only when the parser spots
 * a `gh`/`git` Bash call.
 */
export function setSessionSlugChangeSink(
  fn: ((slug: string) => void) | null,
): void {
  slugChangeSink = fn;
  if (!fn) {
    for (const fiber of slugChangeFibers.values()) Effect.runFork(Fiber.interrupt(fiber));
    slugChangeFibers.clear();
  }
}

/**
 * Debounced per-target dispatch. Resets the timer on every hit, so a
 * burst collapses to a single refresh `TRIGGER_DEBOUNCE_MS` after the
 * last trigger.
 */
function scheduleTrigger(target: RefreshTarget): void {
  const existing = triggerFibers.get(target);
  if (existing) Effect.runFork(Fiber.interrupt(existing));
  triggerFibers.set(
    target,
    Effect.runFork(Effect.sleep(TRIGGER_DEBOUNCE_MS).pipe(
      Effect.andThen(Effect.sync(() => {
        triggerFibers.delete(target);
        log.debug("refresh trigger fired", { target });
        triggerSink?.(target);
      })),
    )),
  );
}

function scheduleSlugChange(slug: string): void {
  if (!slugChangeSink) return;
  const existing = slugChangeFibers.get(slug);
  if (existing) Effect.runFork(Fiber.interrupt(existing));
  slugChangeFibers.set(
    slug,
    Effect.runFork(Effect.sleep(SLUG_CHANGE_DEBOUNCE_MS).pipe(
      Effect.andThen(Effect.sync(() => {
        slugChangeFibers.delete(slug);
        slugChangeSink?.(slug);
      })),
    )),
  );
}

/**
 * Composite identifier for a session tail. By construction the same
 * string as the underlying tmux session name (`<slug>` for primary,
 * `<slug>~<name>` for named) — sharing one composition rule means the
 * tail-registry map and tmux's session list always agree on keys.
 */
export function tailKey(slug: string, name: string | null): string {
  return claudeSessionName(slug, name);
}

export type SessionRun = {
  slug: string;
  /** `null` = primary, otherwise the user-typed name. */
  name: string | null;
  startedAt: number;
  lines: readonly ActionLine[];
  /** Latest observed context usage; null until an assistant turn lands. */
  lastUsage: SessionContextUsage | null;
};

type Listener = () => void;

/**
 * Description of one live claude session for reconciliation. The
 * registry needs (slug, name, wtPath) per session: slug+name compose
 * the tail key; wtPath resolves the jsonl path via `wtSessionUuid`.
 */
export type LiveSessionDesc = {
  slug: string;
  /** `null` = primary. */
  name: string | null;
  wtPath: string;
};

class SessionTailRegistry {
  // Keys here are tail keys (tmux session names) — `<slug>` for
  // primary, `<slug>~<name>` for named. Multiple sessions per slug
  // coexist as separate entries.
  private runs: ReadonlyMap<string, SessionRun> = new Map();
  /** Resolved jsonl path + current generation per tracked key. The
   *  path drives ensure idempotence; the generation gates results (see
   *  the protocol's `gen` doc — a stale in-flight delta for a
   *  same-key-different-path predecessor must not land on the fresh
   *  buffer). */
  private tracked = new Map<string, { path: string; gen: number }>();
  private nextGen = 1;
  private listeners = new Set<Listener>();
  private worker: Worker | null = null;

  /**
   * Idempotent. Spins up a worker-side tailer for the (slug, name)
   * session's wt-managed jsonl if not already running; safe to call on
   * every render-driven reconcile.
   */
  ensure(slug: string, wtPath: string, name: string | null = null): void {
    const key = tailKey(slug, name);
    const uuid = wtSessionUuid(wtPath, name);
    const projectDir = claudeProjectDir(wtPath);
    const jsonlName = `${uuid}.jsonl`;
    const path = join(projectDir, jsonlName);
    const existing = this.tracked.get(key);
    if (existing !== undefined) {
      // Already tracking — only restart if the resolved path changed
      // (e.g. a destroy+recreate cycle re-pointed the slug at a
      // different worktree path within the same TUI run).
      if (existing.path === path) return;
      this.stopByKey(key);
    }
    const gen = this.nextGen++;
    this.tracked.set(key, { path, gen });
    const startedAt = Date.now();
    this.commit((m) =>
      m.set(key, { slug, name, startedAt, lines: [], lastUsage: null }),
    );
    this.post({
      type: "ensure",
      key,
      gen,
      slug,
      name,
      path,
      projectDir,
      jsonlName,
    });
  }

  stop(slug: string, name: string | null = null): void {
    this.stopByKey(tailKey(slug, name));
  }

  /**
   * Sync tracked tailers to a live session set. Spins up tailers for
   * new live sessions, stops tailers for sessions no longer live.
   * Designed to be called from a reactive effect with the current
   * tmux-session list.
   */
  reconcile(live: readonly LiveSessionDesc[]): void {
    const liveKeys = new Set<string>();
    for (const desc of live) {
      liveKeys.add(tailKey(desc.slug, desc.name));
      this.ensure(desc.slug, desc.wtPath, desc.name);
    }
    for (const key of [...this.tracked.keys()]) {
      if (!liveKeys.has(key)) this.stopByKey(key);
    }
  }

  /** Stop every tailer + the worker. Used on TUI shutdown. */
  stopAll(): void {
    // No per-key "stop" posts here: the worker is being terminated in
    // the next statement, and thread death reclaims its watchers and
    // timers wholesale — messages posted now would never be dequeued.
    this.tracked.clear();
    this.commit((m) => m.clear());
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // already gone
      }
      this.worker = null;
    }
    // Drop any pending debounce timers — no tailer is left to have
    // produced them, and a late fire would invalidate queries on a
    // torn-down client. Both maps, symmetrically: the runtime also nulls
    // the sinks on shutdown, but stopAll shouldn't depend on that.
    for (const fiber of triggerFibers.values()) Effect.runFork(Fiber.interrupt(fiber));
    triggerFibers.clear();
    for (const fiber of slugChangeFibers.values()) Effect.runFork(Fiber.interrupt(fiber));
    slugChangeFibers.clear();
  }

  /**
   * Lookup by (slug, name). Convenience overload `get(slug)` returns
   * primary — same as the prior single-session API.
   */
  get(slug: string, name: string | null = null): SessionRun | null {
    return this.runs.get(tailKey(slug, name)) ?? null;
  }

  getSnapshot = (): ReadonlyMap<string, SessionRun> => this.runs;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  // ---------- internals ----------

  private stopByKey(key: string): void {
    if (!this.tracked.delete(key)) return;
    this.post({ type: "stop", key });
    this.commit((m) => {
      m.delete(key);
    });
  }

  private post(msg: TailWorkerMessage): void {
    // stop/stop-all with no worker alive means nothing is tailing —
    // don't spawn one just to tell it that.
    if (!this.worker && msg.type !== "ensure") return;
    try {
      this.ensureWorker().postMessage(msg);
    } catch (err) {
      log.warn("tail worker post failed", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./tail-worker.ts", import.meta.url).href);
    worker.addEventListener("message", (event: MessageEvent) => {
      this.onResult(event.data as TailWorkerResult);
    });
    worker.addEventListener("error", (event) => {
      log.warn("tail worker error", { err: event.message });
    });
    worker.addEventListener("close", () => {
      // Deliberate teardown nulls `worker` first (stopAll); anything
      // else is a crash. Clearing `tracked` makes the next reconcile's
      // ensure() calls miss the idempotence check, spawn a fresh
      // worker, and re-seed every live tail — and that reconcile is
      // never far away: the effect driving it re-fires whenever the
      // row pipeline re-derives, which the per-field polls (isFetching
      // flips) cause within seconds even on a quiet board. Until the
      // re-seed lands, ensure() resets each buffer to empty — a brief
      // blank pane, then full history again.
      if (this.worker === worker) {
        log.warn("tail worker exited; will respawn on next reconcile");
        this.worker = null;
        this.tracked.clear();
      }
    });
    // Idle worker must not keep wt alive during shutdown.
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private onResult(msg: TailWorkerResult): void {
    if (msg.type === "warn") {
      log.warn("tail worker", { message: msg.message, key: msg.key });
      return;
    }
    // Drop results whose key was stopped while the worker had them in
    // flight, and results from a superseded generation (same key
    // re-ensured with a new path) — either would land stale content on
    // a buffer that no longer describes that file.
    if (this.tracked.get(msg.key)?.gen !== msg.gen) return;
    if (msg.type === "seed") {
      this.update(msg.key, (r) => ({
        ...r,
        lines: msg.lines,
        lastUsage: msg.hasUsage ? msg.usage : r.lastUsage,
      }));
      return;
    }
    // delta: the jsonl grew — `claudeStatus` reads it directly for the
    // row's last-activity age + queue count, so a slug-scoped
    // invalidation fires regardless of whether the batch produced a
    // UI-visible emit (system events, queue-ops, etc).
    scheduleSlugChange(msg.slug);
    for (const target of msg.triggers) scheduleTrigger(target);
    if (msg.emits.length === 0 && !msg.hasUsage) return;
    this.update(msg.key, (r) => {
      let next: ActionLine[] = r.lines.slice();
      for (const emit of msg.emits) next = applyEmit(next, emit);
      const lines =
        next.length > MAX_BUFFERED_LINES
          ? next.slice(-MAX_BUFFERED_LINES)
          : next;
      return {
        ...r,
        lines,
        lastUsage: msg.hasUsage ? msg.usage : r.lastUsage,
      };
    });
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // sink errors must not break dispatch
      }
    }
  }

  private commit(mut: (m: Map<string, SessionRun>) => void): void {
    const next = new Map(this.runs);
    mut(next);
    this.runs = next;
    this.notify();
  }

  private update(key: string, mut: (r: SessionRun) => SessionRun): void {
    const cur = this.runs.get(key);
    if (!cur) return;
    this.commit((m) => m.set(key, mut(cur)));
  }
}

export const sessionTailRegistry = new SessionTailRegistry();
