import { keepPreviousData, queryOptions } from "@tanstack/react-query";

import { config } from "../../core/config.ts";
import { reapRemoteArchived } from "../../core/archive.ts";
import { fetchRemoteWorktrees } from "../../core/remote-worktrees.ts";
import { qk } from "../keys.ts";

export const remoteWorktreesQuery = (remote = config.remote) =>
  queryOptions({
    queryKey: qk.remoteWorktrees(remote?.host),
    queryFn: async ({ signal }) => {
      if (!remote) return [];
      const rows = await fetchRemoteWorktrees(remote, signal);
      reapRemoteArchived(remote.host, new Set(rows.map((row) => row.slug)));
      return rows;
    },
    // Persisted query data from versions before location-aware fleet keys has
    // no hostKey. Normalize that last-known/offline inventory at the observer
    // boundary so an archive written before the first successful refetch still
    // uses the configured SSH destination rather than the display label.
    select: (rows) =>
      rows.map((row) =>
        typeof (row as Partial<typeof row>).hostKey === "string" &&
        !!(row as Partial<typeof row>).remote
          ? row
          : {
              ...row,
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
      query.state.data?.some((row) => row.status === "busy") ? 2_000 : 15_000,
    retry: 1,
  });
