import { useEffect, useRef, useState } from "react";
import { Data, Effect, Fiber } from "effect";

import { createLogger } from "../../core/logger.ts";
import { latestLogFor } from "../../core/logs.ts";
import { streamLinesEffect, terminateSubprocessEffect } from "../../core/proc.ts";
import { StatusKind } from "../../core/types.ts";
import type { WorktreeRow } from "./useWorktreeRows.ts";

type Tail = {
  fiber: Fiber.Fiber<void, never> | null;
  token: object;
};

class LogTailSpawnError extends Data.TaggedError("LogTailSpawnError")<{
  readonly cause: unknown;
}> {}

/**
 * Tail log files for any worktree currently running a background job.
 * Each tail's lines are funneled into the global event log under the
 * worktree's slug. Returns the set of slugs currently being tailed so
 * callers can render a visual indicator.
 */
export function useLogTails(rows: WorktreeRow[]): Set<string> {
  const tails = useRef<Map<string, Tail>>(new Map());
  const mounted = useRef(true);
  const [active, setActive] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    const wanted = new Map<string, string>();
    for (const r of rows) {
      if (r.status.kind !== StatusKind.Busy) continue;
      const log = latestLogFor(r.wt.slug);
      if (log) wanted.set(r.wt.slug, log);
    }

    // Stop tails that are no longer wanted.
    for (const [slug, tail] of tails.current) {
      if (!wanted.has(slug)) {
        tails.current.delete(slug);
        if (tail.fiber) Effect.runFork(Fiber.interrupt(tail.fiber));
      }
    }

    // Start new tails.
    for (const [slug, logPath] of wanted) {
      if (tails.current.has(slug)) continue;
      const log = createLogger(slug);
      const token = {};
      const entry: Tail = { fiber: null, token };
      tails.current.set(slug, entry);
      const program = Effect.acquireUseRelease(
        Effect.try({
          try: () =>
            Bun.spawn(["tail", "-n", "50", "-F", logPath], {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
            }),
          catch: (cause) => new LogTailSpawnError({ cause }),
        }),
        (proc) => {
          const stdout = proc.stdout as
            | ReadableStream<Uint8Array>
            | undefined;
          return Effect.all(
            [
              stdout
                ? streamLinesEffect(stdout, (line) => {
                    if (line.trim()) log.event.dim(line);
                  })
                : Effect.void,
              Effect.promise(() =>
                new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
              ),
              Effect.promise(() => proc.exited),
            ],
            { concurrency: "unbounded", discard: true },
          );
        },
        (proc) => terminateSubprocessEffect(proc),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => log.event.dim("tail exited; will restart if still busy")),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            const cause =
              "cause" in error ? error.cause : error;
            const message =
              cause instanceof Error ? cause.message : String(cause);
            log.event.err(`tail failed: ${message}`);
            log.error(cause instanceof Error ? cause : message);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (tails.current.get(slug)?.token !== token) return;
            tails.current.delete(slug);
            if (mounted.current) setActive(new Set(tails.current.keys()));
          }),
        ),
      );
      log.event.info(`tailing ${logPath}`);
      entry.fiber = Effect.runFork(program);
    }

    setActive((prev) => {
      const next = new Set(wanted.keys());
      if (prev.size === next.size && [...prev].every((s) => next.has(s))) return prev;
      return next;
    });
  }, [rows]);

  // Hard-stop on unmount so the TUI can exit cleanly.
  useEffect(() => {
    return () => {
      mounted.current = false;
      for (const [, tail] of tails.current) {
        if (tail.fiber) Effect.runFork(Fiber.interrupt(tail.fiber));
      }
      tails.current.clear();
    };
  }, []);

  return active;
}
