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
  devServerLogs,
  readDevCrashLog,
} from "../../core/dev-server.ts";
import { createLogger } from "../../core/logger.ts";
import type { WorktreeRow } from "./useWorktreeRows.ts";

type DevServerEventRow = {
  archived: boolean;
  wt: { slug: string };
  fields: { dev: { data: { crashed: boolean } | undefined } };
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
    const slug = row.wt.slug;
    const current = row.fields.dev.data?.crashed ?? false;
    live.add(slug);
    if (seen.get(slug) === false && current) crashed.push(slug);
    seen.set(slug, current);
  }
  for (const slug of seen.keys()) {
    if (!live.has(slug)) seen.delete(slug);
  }
  return crashed;
}

export function useDevServerEvents(rows: readonly WorktreeRow[]): void {
  const seenRef = useRef<Map<string, boolean> | null>(null);
  useEffect(() => {
    if (seenRef.current === null) {
      const seed = new Map<string, boolean>();
      newDevServerCrashes(rows, seed);
      seenRef.current = seed;
      return;
    }
    const slugs = newDevServerCrashes(rows, seenRef.current);
    if (slugs.length === 0) return;
    void Promise.all(
      slugs.map(async (slug) => {
        const output =
          (await devServerLogs(slug).catch(() => null)) ?? readDevCrashLog(slug);
        return { slug, summary: output === null ? null : devServerCrashSummary(output) };
      }),
    ).then((events) => {
      for (const { slug, summary } of events) {
        createLogger(slug).attention.err(
          summary
            ? `dev server crashed — ${summary} · wt dev logs`
            : "dev server crashed — see wt dev logs",
        );
      }
    });
  }, [rows]);
}
