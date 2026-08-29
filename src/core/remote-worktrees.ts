import type { RemoteConfig } from "./config.ts";
import { run } from "./proc.ts";
import { remoteWtCommand } from "./remote-protocol.ts";
import { fetchRemoteWorkerInfo } from "./worker-info.ts";
import {
  parseWorkerSnapshot,
  type WorktreeSnapshot,
} from "./worktree-snapshot.ts";
import { reapRemoteLayouts } from "./wtstate.ts";

/**
 * A location-neutral execution snapshot plus the controller's routing and
 * presentation identity. `section` is joined exclusively from controller
 * state after fetching; a worker never owns layout.
 */
export type RemoteWorktreeSummary = WorktreeSnapshot & {
  /** Complete endpoint captured with the row; never resolve via a singleton. */
  remote: RemoteConfig;
  /** Stable SSH destination used for local fleet-ledger identity. */
  hostKey: string;
  hostLabel: string;
  section: string | null;
};

export function parseRemoteWorkerWorktrees(
  raw: string,
  hostLabel: string,
  hostKey: string = hostLabel,
  remote: RemoteConfig = {
    host: hostKey,
    label: hostLabel,
    wtPath: "~/.wt/bin/wt",
  },
): RemoteWorktreeSummary[] {
  return parseWorkerSnapshot(raw).worktrees.map((snapshot) => ({
    ...snapshot,
    remote,
    hostKey,
    hostLabel,
    section: null,
  }));
}

/** Read the authoritative execution snapshot from one configured SSH worker. */
export async function fetchRemoteWorktrees(
  remote: RemoteConfig,
  signal?: AbortSignal,
): Promise<RemoteWorktreeSummary[]> {
  await fetchRemoteWorkerInfo(remote, signal);
  const result = await run(
    [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      remote.host,
      remoteWtCommand(remote, ["_snapshot"]),
    ],
    { cwd: process.cwd(), timeoutMs: 15_000, signal },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `SSH exited ${result.exitCode}`);
  }
  const rows = parseRemoteWorkerWorktrees(
    result.stdout,
    remote.label,
    remote.host,
    remote,
  );
  reapRemoteLayouts(remote.host, new Set(rows.map((row) => row.slug)));
  return rows;
}
