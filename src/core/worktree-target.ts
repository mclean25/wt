import { createHash } from "node:crypto";

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
type WorktreeTargetCommon = {
  slug: string;
  branch: string;
  path: string;
  stage: string;
};

export type WorktreeTarget = WorktreeTargetCommon &
  (
    | {
        ref: Extract<WorktreeRef, { kind: "local" }>;
        location: { kind: "local" };
      }
    | {
        ref: Extract<WorktreeRef, { kind: "remote" }>;
        location: { kind: "remote"; endpoint: RemoteConfig };
      }
  );

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

/**
 * Safe key for the action registry and its tmux session. Local worktrees keep
 * their historical bare slug. Remote rows include a stable host digest so a
 * same-named local/remote pair cannot share one action slot; the digest also
 * avoids tmux's restrictions on punctuation in session names.
 */
export function worktreeActionKey(target: WorktreeTarget): string {
  if (target.location.kind === "local") return target.slug;
  return remoteWorktreeActionKey(target.location.endpoint.host, target.slug);
}

export function remoteWorktreeActionKey(hostname: string, slug: string): string {
  const host = createHash("sha256")
    .update(hostname)
    .digest("hex")
    .slice(0, 10);
  return `remote-${host}-${slug}`;
}

export function isRemoteWorktreeTarget(
  target: WorktreeTarget,
): target is WorktreeTarget & {
  ref: Extract<WorktreeRef, { kind: "remote" }>;
  location: { kind: "remote"; endpoint: RemoteConfig };
} {
  return target.location.kind === "remote";
}
