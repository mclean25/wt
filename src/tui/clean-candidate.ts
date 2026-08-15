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

/** What a fleet cleanup would destroy from a remote checkout. */
export function remoteCleanHazardLabel(
  entry: RemoteWorktreeSummary,
): string | null {
  if (entry.dirty) return "uncommitted changes";
  if (entry.unpushed > 0) {
    return `${entry.unpushed} unpushed commit${entry.unpushed === 1 ? "" : "s"}`;
  }
  return null;
}
