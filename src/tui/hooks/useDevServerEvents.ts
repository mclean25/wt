/**
 * Turns supervised dev-server crashes into attention-feed events.
 *
 * The command that starts a server returns once its detached tmux
 * supervisor exists. A dependency failure can park that supervisor a
 * few seconds later, outside the command process, so the row query is
 * the authoritative place to observe it. First observation is seeded
 * silently (persisted crashes are state, not new events); each later
 * non-crashed → crashed transition is narrated once.
 */
import { useEffect, useRef } from "react";
import { Data, Effect, Fiber } from "effect";

import {
  devServerCrashSummary,
} from "../../core/dev-server.ts";
import { createLogger } from "../../core/logger.ts";
import { readWorktreeDevLogsPromise } from "../../core/worktree-executor.ts";
import { worktreeLedgerLabel } from "../../core/worktree-ref.ts";
import type { WorktreeModel } from "../worktree-model.ts";

type DevServerEventRow = {
  key: string;
  slug: string;
  archived: boolean;
  dev: { crashed: boolean };
};

class DevServerEventReadError extends Data.TaggedError(
  "DevServerEventReadError",
)<{ readonly key: string; readonly cause: unknown }> {}

/** Update the seen-state map and return crash transitions in this pass. */
export function newDevServerCrashes(
  rows: readonly DevServerEventRow[],
  seen: Map<string, boolean>,
): string[] {
  const crashed: string[] = [];
  const live = new Set<string>();
  for (const row of rows) {
    if (row.archived) continue;
    const current = row.dev.crashed;
    live.add(row.key);
    if (seen.get(row.key) === false && current) crashed.push(row.key);
    seen.set(row.key, current);
  }
  for (const slug of seen.keys()) {
    if (!live.has(slug)) seen.delete(slug);
  }
  return crashed;
}

export function useDevServerEvents(rows: readonly WorktreeModel[]): void {
  const seenRef = useRef<Map<string, boolean> | null>(null);
  useEffect(() => {
    if (seenRef.current === null) {
      const seed = new Map<string, boolean>();
      newDevServerCrashes(rows, seed);
      seenRef.current = seed;
      return;
    }
    const keys = newDevServerCrashes(rows, seenRef.current);
    if (keys.length === 0) return;
    const byKey = new Map(rows.map((row) => [row.key, row]));
    const fiber = Effect.runFork(
      Effect.forEach(
        keys,
        (key) => {
          const row = byKey.get(key);
          if (!row) return Effect.succeed(null);
          return Effect.tryPromise({
            try: () => readWorktreeDevLogsPromise(row.target),
            catch: (cause) => new DevServerEventReadError({ key, cause }),
          }).pipe(
            Effect.map((output) => ({
              key,
              summary:
                output === null ? null : devServerCrashSummary(output),
            })),
            Effect.orElseSucceed(() => ({ key, summary: null })),
          );
        },
        { concurrency: "unbounded" },
      ).pipe(
        Effect.tap((events) =>
          Effect.sync(() => {
            for (const event of events) {
              if (!event) continue;
              createLogger(worktreeLedgerLabel(event.key)).attention.err(
                event.summary
                  ? `dev server crashed — ${event.summary} · wt dev logs`
                  : "dev server crashed — see wt dev logs",
              );
            }
          }),
        ),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [rows]);
}
