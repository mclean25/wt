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

import {
  devServerCrashSummary,
} from "../../core/dev-server.ts";
import { createLogger } from "../../core/logger.ts";
import { readWorktreeDevLogs } from "../../core/worktree-executor.ts";
import { worktreeLedgerLabel } from "../../core/worktree-ref.ts";
import type { WorktreeModel } from "../worktree-model.ts";

type DevServerEventRow = {
  key: string;
  slug: string;
  archived: boolean;
  dev: { crashed: boolean };
};

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
    void Promise.all(
      keys.map(async (key) => {
        const row = byKey.get(key);
        if (!row) return null;
        const output = await readWorktreeDevLogs(row.target).catch(() => null);
        return {
          key,
          summary: output === null ? null : devServerCrashSummary(output),
        };
      }),
    ).then((events) => {
      for (const event of events) {
        if (!event) continue;
        createLogger(worktreeLedgerLabel(event.key)).attention.err(
          event.summary
            ? `dev server crashed — ${event.summary} · wt dev logs`
            : "dev server crashed — see wt dev logs",
        );
      }
    });
  }, [rows]);
}
