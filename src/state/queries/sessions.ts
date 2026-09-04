import { queryOptions } from "@tanstack/react-query";
import { Effect } from "effect";

import {
  getHarness,
  type HarnessId,
  type HarnessSession,
} from "../../core/harness/index.ts";
import {
  listSessions,
  type ClaudeSessionEntry,
} from "../../core/tmux.ts";

export type { ClaudeSessionEntry };

import { qk } from "../keys.ts";
import { operationErrors, runQuery } from "./boundary.ts";
import { STALE } from "./shared.ts";

const io = operationErrors("sessions");

export type TmuxSessionsData = {
  /**
   * Every live claude session, including primary and named. Multiple
   * entries can share a slug. Drives the sessions picker; consumers
   * that just want "any live claude" should use `slugsByHarness.claude`.
   */
  claude: ClaudeSessionEntry[];
  /**
   * Live-session slug lists keyed by harness id. `claude` is the
   * unique-slug projection of the `claude` entry list (a worktree can
   * host several named claude sessions); `codex` contains the
   * single-slot slugs. One uniform `Record<HarnessId, string[]>` so
   * consumers index by harness id instead of branching on it. Arrays
   * (not Sets) because this query is persisted.
   */
  slugsByHarness: Record<HarnessId, string[]>;
  /** Slugs with a live diff session. */
  diff: string[];
  /** Slugs with a live shell session. */
  shell: string[];
  /** Slugs with a live action session (wt-managed wrapper). */
  action: string[];
  /**
   * Slugs with a live `[dev_server]` supervisor session (`<slug>-dev`).
   * `wtDevQuery` reads this instead of spawning its own per-worktree
   * `tmux has-session` — one batched shell-out already knows.
   */
  dev: string[];
  /**
   * Raw set of every live tmux session name on the wt-private server.
   * Consumers that need to know whether a specific harness's tmux name
   * is live (e.g. `useHarnessSessions`) read this rather than running
   * a second `list-sessions`. Stored as an array for serialisation;
   * convert to a Set in the consumer hook if needed.
   */
  all: string[];
};

/**
 * Slugs with live wt-private tmux sessions, partitioned by kind. One
 * CLI shell-out per refresh covers every worktree and both kinds at
 * once — far cheaper than per-row `has-session` polling or two
 * parallel queries. Push triggers do the fast work: explicit
 * invalidation fires on enter/detach/kill, and the claude-registry
 * watcher invalidates on claude process start/exit. The 5s interval is
 * a backstop for lifecycle events with no trigger (a shell/diff
 * session's process exiting on its own, external `tmux kill-session`).
 */
export const tmuxSessionsQuery = () =>
  queryOptions({
    queryKey: qk.tmuxSessions(),
    queryFn: ({ signal }): Promise<TmuxSessionsData> =>
      runQuery(
        Effect.gen(function* () {
          const {
            claude,
            claudeSlugs,
            codex,
            diff,
            shell,
            action,
            dev,
            all,
          } = yield* listSessions();
          return {
            claude,
            slugsByHarness: {
              claude: [...claudeSlugs],
              codex: [...codex],
            },
            diff: [...diff],
            shell: [...shell],
            action: [...action],
            dev: [...dev],
            all: [...all],
          };
        }),
        signal,
      ),
    staleTime: STALE.fast,
    refetchInterval: 5_000,
  });

/**
 * Per-(slug, harness) session discovery. Each impl returns whatever it
 * can derive from its own state stores; this query caches it so the
 * picker / row don't pay the cost on every render. Liveness is NOT
 * baked into the cached value — the consumer hook reannotates against
 * the live tmux name set so a tmux flip doesn't invalidate the
 * discovery cache. `isLive` (the caller's read of that same tmux name
 * set, via `slugsByHarness`) is deliberately NOT part of the query
 * key for the same reason — it only gates `refetchInterval` below.
 *
 * `enabled` short-circuits to false when wtPath is empty (defensive —
 * the row pipeline can briefly show empty paths during reordering).
 */
export const harnessSessionsQuery = (
  harnessId: HarnessId,
  slug: string,
  wtPath: string,
  isLive: boolean,
) =>
  queryOptions({
    queryKey: qk.harnessSessions(harnessId, slug),
    queryFn: ({ signal }): Promise<HarnessSession[]> => {
      const harness = getHarness(harnessId);
      return runQuery(
        io.promise("discover harness sessions", () =>
          harness.discoverSessions({ slug, wtPath, signal }),
        ),
        signal,
      );
    },
    staleTime: STALE.fast,
    // Claude session state is kept fresh by `watchRegistry` invalidation
    // (its status lives in the fs-watched registry). Codex bakes its
    // state into discovery and has no such watcher, so a working
    // session would otherwise show stale state until spawn/kill/refresh —
    // poll while the tmux slot is CURRENTLY live (not merely "ever had a
    // session on disk" — a worktree with old rollouts but no live
    // tmux slot must not poll forever).
    refetchInterval: () =>
      harnessId === "claude" ? false : isLive ? 3_000 : false,
    enabled: wtPath !== "",
  });

/**
 * Persisted primary harness id. Read once on mount; mutate via
 * `usePrimaryHarness().setPrimary(id)`. Tiny query, refreshed only on
 * explicit invalidation.
 */
export const primaryHarnessQuery = () =>
  queryOptions({
    queryKey: qk.primaryHarness(),
    queryFn: ({ signal }) =>
      runQuery(
        io.promise("read primary harness", () =>
          import("../../core/harness/primary.ts").then(
            ({ readPrimaryHarness }) => readPrimaryHarness(),
          ),
        ),
        signal,
      ),
    staleTime: Infinity,
  });
