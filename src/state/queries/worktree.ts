import { queryOptions } from "@tanstack/react-query";

import { config } from "../../core/config.ts";
import { devServerStatus, type DevServerStatus } from "../../core/dev-server.ts";
import { claudeStatus, type ClaudeStatus } from "../../core/harness/claude/jsonl.ts";
import { branchIsGone, branchIsMerged, effectiveBaseOrTrunk, firstCommitSubject, freshBaseRev, invalidateMainFirstParents, mergeConflictProbe, type MergeConflictProbe } from "../../core/git.ts";
import { gitActivity, type GitActivity } from "../../core/git-activity.ts";
import { lockStatus } from "../../core/locks.ts";
import type {
  LockMeta,
  Worktree,
} from "../../core/types.ts";
import { isOurStageDeployed } from "../../core/stage-safety.ts";
import { fetchOrigin, listWorktrees, syncState, type SyncState, worktreeDirtyFiles } from "../../core/worktree.ts";

import { qk } from "../keys.ts";
import { KEEP_PREV, STALE } from "./shared.ts";

// ---------- Root queries ----------

export const worktreesQuery = () =>
  queryOptions({
    queryKey: qk.worktrees(),
    queryFn: async (): Promise<Worktree[]> => listWorktrees(),
    staleTime: STALE.mid,
  });

export async function fetchOriginNow(): Promise<number> {
  await fetchOrigin();
  invalidateMainFirstParents();
  return Date.now();
}

export const fetchOriginQuery = () =>
  queryOptions({
    queryKey: qk.fetchOrigin(),
    queryFn: fetchOriginNow,
    staleTime: STALE.slow,
  });

// ---------- Per-worktree queries ----------

export const wtDirtyQuery = (wt: Pick<Worktree, "slug" | "path">) =>
  queryOptions({
    queryKey: qk.wt(wt.slug).dirty(),
    queryFn: async (): Promise<readonly string[]> => worktreeDirtyFiles(wt.path),
    staleTime: STALE.fast,
  });

export const wtLockQuery = (wt: Pick<Worktree, "slug">) =>
  queryOptions({
    queryKey: qk.wt(wt.slug).lock(),
    queryFn: async (): Promise<Partial<LockMeta> | null> => lockStatus(wt.slug),
    staleTime: STALE.fast,
    // The lock-dir watcher (`watchLockDir` in the TUI runtime) is the
    // primary trigger — acquire, phase writes, and release all fire it,
    // so busy state tracks any process's lock churn push-based. This
    // while-held poll is the backstop for a missed fs event and keeps
    // the displayed lock age ticking.
    refetchInterval: (query) => (query.state.data ? 2_000 : false),
  });

export const wtDeployQuery = (wt: Pick<Worktree, "slug" | "path">) =>
  queryOptions({
    queryKey: qk.wt(wt.slug).deploy(),
    queryFn: async (): Promise<boolean> => isOurStageDeployed(wt),
    staleTime: STALE.fast,
  });

/**
 * `[dev_server]` state for the slug (tmux session + port probe; cheap
 * and local). `sessionExists` is read by the caller from the batched
 * `tmuxSessionsQuery`'s `dev` set (`null` while that query hasn't
 * loaded yet) and passed through to `devServerStatus` so this query
 * doesn't spawn its own per-worktree `tmux has-session` — the value
 * is also part of the query key, so a session starting/stopping
 * cache-misses into an immediate refetch instead of waiting on this
 * query's own interval. That interval, plus the dev-server start/stop
 * actions' `affects = ["dev"]` invalidation, remain the backstop for
 * the port probe half (a crash, a hand-run `wt dev`).
 */
export const wtDevQuery = (
  wt: Pick<Worktree, "slug" | "path">,
  sessionExists: boolean | null = null,
) =>
  queryOptions({
    queryKey: qk.wt(wt.slug).dev(sessionExists),
    queryFn: async (): Promise<DevServerStatus> =>
      devServerStatus(wt.slug, {
        sessionExists: sessionExists ?? undefined,
        // Enables the rebase-staleness check: one `git merge-base
        // --is-ancestor` (0.1s), which is why it can ride this poll
        // where asking the environment itself (9s) could not.
        path: wt.path,
      }),
    staleTime: STALE.fast,
    refetchInterval: 15_000,
  });

export const wtMergedQuery = (wt: Pick<Worktree, "slug" | "branch" | "path">) =>
  queryOptions({
    queryKey: qk.wt(wt.slug).merged(),
    queryFn: async (): Promise<boolean> =>
      wt.branch ? branchIsMerged({ slug: wt.slug, branch: wt.branch, path: wt.path }) : false,
    staleTime: STALE.mid,
  });

export const wtGoneQuery = (wt: Pick<Worktree, "slug" | "branch" | "path">) =>
  queryOptions({
    queryKey: qk.wt(wt.slug).gone(),
    queryFn: async (): Promise<boolean> =>
      wt.branch ? branchIsGone(wt.branch, wt.path) : false,
    staleTime: STALE.mid,
  });

export const wtSyncQuery = (
  wt: Pick<Worktree, "slug" | "path">,
  effectiveBase?: string | null,
) => {
  const base = effectiveBase ?? `origin/${config.branch.base}`;
  return queryOptions({
    queryKey: qk.wt(wt.slug).sync(base),
    queryFn: async (): Promise<SyncState> => syncState(wt.path, base),
    staleTime: STALE.mid,
    ...KEEP_PREV,
  });
};

export const wtClaudeQuery = (wt: Pick<Worktree, "slug" | "path">) =>
  queryOptions({
    queryKey: qk.wt(wt.slug).claude(),
    queryFn: async (): Promise<ClaudeStatus> =>
      claudeStatus({ slug: wt.slug, path: wt.path }),
    staleTime: STALE.fast,
    // The session-tail slug sink is the primary trigger: it invalidates
    // this query the moment a live session's jsonl grows, so turn ends
    // and queue-count changes snap immediately. The interval only keeps
    // the *displayed age* ("2m ago") ticking and covers sessions the
    // tailer isn't watching — minute-granularity display needs no 5s
    // loop. State (working/waiting/abandoned/idle) is derived in the
    // row via `useClaudeSessionsForSlug`, which subscribes to
    // `tmuxSessionsQuery` (its own poll loop). A tmux state change
    // re-renders the row without rerunning this query.
    refetchInterval: 15_000,
  });

export const wtGitActivityQuery = (
  wt: Pick<Worktree, "slug" | "path" | "branch">,
  effectiveBase?: string | null,
) => {
  const base = effectiveBase ?? `origin/${config.branch.base}`;
  return queryOptions({
    queryKey: qk.wt(wt.slug).gitActivity(base),
    queryFn: async (): Promise<GitActivity> =>
      gitActivity({ path: wt.path, branch: wt.branch }, base),
    staleTime: STALE.mid,
    ...KEEP_PREV,
  });
};

/**
 * Rebase-conflict pre-flight: a `git merge-tree` dry-run of this
 * worktree's HEAD against its effective base (the parent branch for a
 * stacked slice, `origin/<trunk>` otherwise). Side-effect-free — never
 * touches the working tree. Keyed by base like `sync` / `gitActivity`;
 * the `.git/refs` watcher's `["wt"]` invalidation refetches it on any
 * commit / fetch / push, so it tracks reality without its own trigger.
 *
 * The base is run through `effectiveBaseOrTrunk` (same as the diff /
 * gitActivity) so a stacked slice's bare parent name resolves to the
 * local branch OR `origin/<parent>` — the latter is the only ref a rift
 * checkout has for a sibling slice. Without it a rift slice's probe
 * either finds a stale/polluted local ref (a phantom conflict) or nothing
 * at all; the shared resolution keeps the probe honest across backends.
 */
export const wtConflictQuery = (
  wt: Pick<Worktree, "slug" | "path">,
  effectiveBase?: string | null,
) => {
  const base = effectiveBase ?? `origin/${config.branch.base}`;
  return queryOptions({
    queryKey: qk.wt(wt.slug).conflict(base),
    queryFn: async (): Promise<MergeConflictProbe> =>
      mergeConflictProbe("HEAD", await effectiveBaseOrTrunk(wt.path, base), wt.path),
    staleTime: STALE.mid,
    ...KEEP_PREV,
  });
};

/**
 * Subject of the oldest commit on the branch — fallback title when
 * there's no PR yet. Cheap (one `git log`); short staleTime.
 *
 * `baseBranch` is the worktree's RECORDED fork base, and passing it is
 * load-bearing for stacked worktrees: measured against the trunk, a
 * child with no commits of its own walks its parent's history and
 * resolves to the PARENT's oldest commit — so every sibling of a fan
 * renders the same title and two different tasks become
 * indistinguishable in the list. Measured against its own base the
 * range is empty, the title falls back to the slug, and the rows are
 * telling apart again. The base is part of the query key so a `wt base`
 * edit or a restack reconcile refetches.
 *
 * The same failure has a second cause with nothing to do with stacking,
 * and it reaches ORDINARY trunk worktrees: under `rift` a checkout's
 * own `origin/<trunk>` is only as fresh as its last fetch, so
 * `origin/<trunk>..HEAD` on a branch with NO commits of its own is the
 * run of trunk commits it is behind by — and the oldest of those is a
 * colleague's. Measured live: a row with 0 files and 0 lines changed
 * titled itself "Make the pgTAP suite green and seed-independent",
 * another worktree's work. So the base resolves through `freshBaseRev`,
 * which substitutes the main clone's tip when this checkout already has
 * the object. It is the read-side floor under `freshenWorktreeTrunkRefs`
 * rather than a replacement for it: a title is a claim about THIS
 * branch, and a wrong one is indistinguishable from a right one.
 */
export const wtFirstCommitQuery = (
  wt: Pick<Worktree, "slug" | "path">,
  baseBranch?: string | null,
) =>
  queryOptions({
    queryKey: qk.wt(wt.slug).firstCommit(baseBranch ?? null),
    queryFn: async (): Promise<string | null> =>
      firstCommitSubject(
        wt.path,
        await freshBaseRev(wt.path, await effectiveBaseOrTrunk(wt.path, baseBranch)),
      ),
    staleTime: STALE.mid,
  });
