import type { RemoteConfig } from "./config.ts";
import type { RemoteWorktreeSummary } from "./remote-worktrees.ts";
import type { Worktree } from "./types.ts";
import {
  worktreeLedgerKey,
  type WorktreeRef,
} from "./worktree-ref.ts";

/**
 * One fleet member independent of where its checkout is materialized.
 * Consumers use the common metadata for presentation and inspect `location`
 * only at the I/O boundary.
 */
export type WorktreeTarget = {
  ref: WorktreeRef;
  slug: string;
  branch: string;
  path: string;
  stage: string;
  location:
    | { kind: "local" }
    | { kind: "remote"; endpoint: RemoteConfig };
};

export function localWorktreeTarget(
  wt: Pick<Worktree, "slug" | "branch" | "path" | "stage">,
): WorktreeTarget {
  return {
    ref: { kind: "local", slug: wt.slug },
    slug: wt.slug,
    branch: wt.branch,
    path: wt.path,
    stage: wt.stage,
    location: { kind: "local" },
  };
}

export function remoteWorktreeTarget(
  wt: Pick<
    RemoteWorktreeSummary,
    "slug" | "branch" | "path" | "stage" | "remote"
  >,
): WorktreeTarget {
  return {
    ref: { kind: "remote", host: wt.remote.host, slug: wt.slug },
    slug: wt.slug,
    branch: wt.branch,
    path: wt.path,
    stage: wt.stage,
    location: { kind: "remote", endpoint: wt.remote },
  };
}

export function worktreeTargetKey(target: WorktreeTarget): string {
  return worktreeLedgerKey(target.ref);
}

export function isRemoteWorktreeTarget(
  target: WorktreeTarget,
): target is WorktreeTarget & {
  location: { kind: "remote"; endpoint: RemoteConfig };
} {
  return target.location.kind === "remote";
}
