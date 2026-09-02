import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { Data, Effect } from "effect";

import { config } from "../../core/config.ts";
import { fetchRemoteWorktreesPromise } from "../../core/remote-worktrees.ts";
import { refreshRemoteWorkerInfo } from "../../core/worker-info.ts";
import { DEV_SERVER_STOPPED } from "../../core/dev-server.ts";
import { qk } from "../keys.ts";

class RemoteQueryError extends Data.TaggedError("RemoteQueryError")<{
  operation: string;
  cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error
      ? this.cause.message
      : String(this.cause);
  }
}

const queryPromise = <A, E>(effect: Effect.Effect<A, E>, signal: AbortSignal) =>
  Effect.runPromise(effect, { signal });

export const remoteWorkerInfoQuery = (remote = config.remote) =>
  queryOptions({
    queryKey: qk.remoteWorkerInfo(remote?.host),
    queryFn: ({ signal }) =>
      queryPromise(
        remote ? refreshRemoteWorkerInfo(remote) : Effect.succeed(null),
        signal,
      ),
    staleTime: Infinity,
    refetchInterval: 15_000,
    retry: false,
  });

export const remoteWorktreesQuery = (remote = config.remote) =>
  queryOptions({
    queryKey: qk.remoteWorktrees(remote?.host),
    queryFn: ({ signal }) =>
      queryPromise(
        remote
          ? Effect.tryPromise({
              try: () => fetchRemoteWorktreesPromise(remote, signal),
              catch: (cause) =>
                new RemoteQueryError({ operation: "fetch worktrees", cause }),
            })
          : Effect.succeed([]),
        signal,
      ),
    // Persisted query data from versions before location-aware fleet keys has
    // no hostKey. Normalize that last-known/offline inventory at the observer
    // boundary so an archive written before the first successful refetch still
    // uses the configured SSH destination rather than the display label.
    select: (rows) =>
      rows.map((row) =>
        typeof (row as Partial<typeof row>).hostKey === "string" &&
        !!(row as Partial<typeof row>).remote
          ? { ...row, dev: row.dev ?? DEV_SERVER_STOPPED }
          : {
              ...row,
              dev: row.dev ?? DEV_SERVER_STOPPED,
              hostKey: remote?.host ?? row.hostLabel,
              remote: remote ?? {
                host: row.hostLabel,
                label: row.hostLabel,
                wtPath: "~/.wt/bin/wt",
              },
            },
      ),
    staleTime: 3_000,
    // Reachability is not membership. Keep the last successful (persisted)
    // inventory visible while a sleeping/offline host rejects refetches.
    placeholderData: keepPreviousData,
    refetchInterval: (query) =>
      query.state.data?.some(
        (row) =>
          row.status.kind === "busy" || row.dev?.starting || row.dev?.waiting,
      )
        ? 2_000
        : 15_000,
    retry: 1,
  });
