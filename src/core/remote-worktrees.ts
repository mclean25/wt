import { Data, Effect } from "effect";

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

export class RemoteWorktreesError extends Data.TaggedError("RemoteWorktreesError")<{
  readonly operation: "handshake" | "snapshot" | "parse";
  readonly message: string;
  readonly cause?: unknown;
}> {}

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
export const fetchRemoteWorktrees = Effect.fn("fetchRemoteWorktrees")(function* (
  remote: RemoteConfig,
  signal?: AbortSignal,
): Effect.fn.Return<RemoteWorktreeSummary[], RemoteWorktreesError> {
  yield* fetchRemoteWorkerInfo(remote).pipe(
    Effect.mapError((cause) => new RemoteWorktreesError({
      operation: "handshake",
      message: `worker handshake failed for ${remote.label}`,
      cause,
    })),
  );
  const result = yield* run(
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
  ).pipe(
    Effect.mapError((cause) => new RemoteWorktreesError({
      operation: "snapshot",
      message: `snapshot command failed for ${remote.label}`,
      cause,
    })),
  );
  if (result.exitCode !== 0) {
    return yield* new RemoteWorktreesError({
      operation: "snapshot",
      message: result.stderr.trim() || result.stdout.trim() || `SSH exited ${result.exitCode}`,
    });
  }
  const rows = yield* Effect.try({
    try: () => parseRemoteWorkerWorktrees(result.stdout, remote.label, remote.host, remote),
    catch: (cause) => new RemoteWorktreesError({
      operation: "parse",
      message: `invalid worker snapshot from ${remote.label}`,
      cause,
    }),
  });
  yield* Effect.sync(() => reapRemoteLayouts(remote.host, new Set(rows.map((row) => row.slug))));
  return rows;
});

export const fetchRemoteWorktreesPromise = (
  remote: RemoteConfig,
  signal?: AbortSignal,
): Promise<RemoteWorktreeSummary[]> =>
  Effect.runPromise(fetchRemoteWorktrees(remote, signal));
