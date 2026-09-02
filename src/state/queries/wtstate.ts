import { queryOptions } from "@tanstack/react-query";
import { Data, Effect } from "effect";

import { readArchived } from "../../core/archive.ts";
import { readWtState, type WtState } from "../../core/wtstate.ts";

import { qk } from "../keys.ts";
import { STALE } from "./shared.ts";

class WtStateQueryError extends Data.TaggedError("WtStateQueryError")<{
  operation: string;
  cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error
      ? this.cause.message
      : String(this.cause);
  }
}

const querySync = <A>(operation: string, evaluate: () => A) =>
  Effect.runPromise(
    Effect.try({
      try: evaluate,
      catch: (cause) => new WtStateQueryError({ operation, cause }),
    }),
  );

export const archiveQuery = () =>
  queryOptions({
    queryKey: qk.archive(),
    queryFn: (): Promise<string[]> =>
      querySync("read archive", () => [...readArchived()]),
    staleTime: STALE.fast,
  });

export const wtStateQuery = () =>
  queryOptions({
    queryKey: qk.wtState(),
    queryFn: (): Promise<WtState> =>
      querySync("read wt state", () => readWtState()),
    staleTime: STALE.fast,
  });
