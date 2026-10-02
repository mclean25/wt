import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { Effect } from "effect";

import { refreshCreatedWorktree } from "./hooks.ts";
import { qk } from "./keys.ts";

test("creation refreshes inventory and the created row without reloading the fleet", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const refreshed: string[] = [];
  const keys = {
    inventory: qk.worktrees(),
    state: qk.wtState(),
    createdDirty: qk.wt("created").dirty(),
    createdLock: qk.wt("created").lock(),
    existingDirty: qk.wt("existing").dirty(),
    existingSync: qk.wt("existing").sync("origin/main"),
    origin: qk.fetchOrigin(),
    github: qk.github(["existing"]),
    remote: qk.remoteWorktrees(),
  };
  const subscriptions = Object.entries(keys).map(([name, queryKey]) => {
    const observer = new QueryObserver(qc, {
      queryKey,
      initialData: "before",
      staleTime: Infinity,
      queryFn: async () => {
        refreshed.push(name);
        return "after";
      },
    });
    return observer.subscribe(() => {});
  });
  try {
    await Effect.runPromise(refreshCreatedWorktree(qc, "created"));
    expect(refreshed.sort()).toEqual(["createdDirty", "createdLock", "inventory", "state"]);
    expect(qc.getQueryData<string>(keys.createdDirty)).toBe("after");
    expect(qc.getQueryData<string>(keys.existingDirty)).toBe("before");
    expect(qc.getQueryState(keys.existingDirty)?.isInvalidated).toBe(false);
  } finally {
    for (const unsubscribe of subscriptions) unsubscribe();
    qc.clear();
  }
});

test("creation marks a not-yet-observed created row stale", async () => {
  const qc = new QueryClient();
  const key = qk.wt("created").dirty();
  qc.setQueryData(key, ["mid-install"]);
  try {
    await Effect.runPromise(refreshCreatedWorktree(qc, "created"));
    expect(qc.getQueryState(key)?.isInvalidated).toBe(true);
  } finally {
    qc.clear();
  }
});
