import type { RemoteConfig } from "../core/config.ts";
import type { RemoteWorktreeSummary } from "../core/remote-worktrees.ts";

/** Transient row shown until remote `wt ls` discovers the real checkout. */
export type RemoteCreation = {
  remote: RemoteConfig;
  hostKey: string;
  hostLabel: string;
  input: string;
  /** Fleet identities present before this create started. */
  previousKeys: readonly string[];
  status: "creating" | "ready";
};

export type RemoteListEntry = RemoteCreation | RemoteWorktreeSummary;

export function isRemoteSummary(
  entry: RemoteListEntry,
): entry is RemoteWorktreeSummary {
  return "slug" in entry;
}

export function remoteEntryKey(entry: RemoteListEntry): string {
  return `${entry.hostKey}:${isRemoteSummary(entry) ? entry.slug : entry.input}`;
}

export function remoteEntryLabel(entry: RemoteListEntry): string {
  return isRemoteSummary(entry) ? entry.slug : entry.input;
}

/**
 * Find the authoritative inventory row produced by an in-flight create.
 *
 * The input is not an identity: an issue id can receive a generated suffix,
 * and a title is slugified remotely. Reconcile against the host's inventory
 * delta instead, so the usable row replaces the placeholder as soon as
 * `wt ls` can see it rather than when the whole install command exits.
 */
export function discoveredRemoteCreation(
  creation: RemoteCreation,
  rows: readonly RemoteWorktreeSummary[],
): RemoteWorktreeSummary | undefined {
  const previous = new Set(creation.previousKeys);
  return rows.find(
    (row) =>
      row.hostKey === creation.hostKey &&
      !previous.has(remoteEntryKey(row)),
  );
}
