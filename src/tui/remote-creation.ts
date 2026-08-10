import type { RemoteConfig } from "../core/config.ts";
import type { RemoteWorktreeSummary } from "../core/remote-worktrees.ts";

/** Transient row shown until remote `wt ls` discovers the real checkout. */
export type RemoteCreation = {
  remote: RemoteConfig;
  hostKey: string;
  hostLabel: string;
  input: string;
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
