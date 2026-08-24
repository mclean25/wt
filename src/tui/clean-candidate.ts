import { StatusKind } from "../core/types.ts";
import type { RemoteWorktreeSummary } from "../core/remote-worktrees.ts";
import type { WorktreeRow } from "./hooks/useWorktreeRows.ts";

/** One row shown and dispatched by the fleet-wide `c` cleanup flow. */
export type CleanCandidate =
  | { kind: "local"; row: WorktreeRow }
  | { kind: "remote"; entry: RemoteWorktreeSummary };

/** Remote equivalent of app-helpers.ts's local `isCleanCandidate`. */
export function isRemoteCleanCandidate(
  entry: RemoteWorktreeSummary,
  archived: boolean,
): boolean {
  if (archived || entry.status === StatusKind.Busy) return false;
  return entry.status === StatusKind.Merged || entry.status === StatusKind.Gone;
}

/**
 * What a fleet cleanup would destroy from a remote checkout. Mirrors
 * the local `destroyHazards` list, including its odd one out: an
 * outstanding post-merge verification is not lost DATA, but sweeping
 * the checkout takes the obligation with it and nothing afterwards
 * records that the check never ran. Every candidate here has landed by
 * construction, which is exactly when the check comes due.
 */
export function remoteCleanHazardLabel(
  entry: RemoteWorktreeSummary,
): string | null {
  if (entry.dirty) return "uncommitted changes";
  if (entry.unpushed > 0) {
    return `${entry.unpushed} unpushed commit${entry.unpushed === 1 ? "" : "s"}`;
  }
  if (entry.workVerifyAfterMerge && entry.workState !== "verified") {
    // Same scan-line reasoning as `destroyHazardLabel`, which this
    // mirrors for rows on another host.
    return "post-merge verification still owed";
  }
  return null;
}
