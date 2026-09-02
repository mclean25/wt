import { queryOptions } from "@tanstack/react-query";

import { readArchived } from "../../core/archive.ts";
import { readWtState, type WtState } from "../../core/wtstate.ts";

import { qk } from "../keys.ts";
import { operationErrors, runQuery } from "./boundary.ts";
import { STALE } from "./shared.ts";

const io = operationErrors("wtstate");

export const archiveQuery = () =>
  queryOptions({
    queryKey: qk.archive(),
    queryFn: ({ signal }): Promise<string[]> =>
      runQuery(io.sync("read archive", () => [...readArchived()]), signal),
    staleTime: STALE.fast,
  });

export const wtStateQuery = () =>
  queryOptions({
    queryKey: qk.wtState(),
    queryFn: ({ signal }): Promise<WtState> =>
      runQuery(io.sync("read wt state", () => readWtState()), signal),
    staleTime: STALE.fast,
  });
