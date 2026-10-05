import { expect, test } from "bun:test";

import { createWtQueryClient } from "./client.ts";
import type { AsyncStorageDb } from "./persister.ts";

function memoryStorage(entries: Promise<Array<[string, string]>>, set = (_key: string, _value: string) => {}): AsyncStorageDb {
  return {
    getItem: async () => null,
    setItem: async (key, value) => { set(key, value); },
    removeItem: async () => {},
    entries: () => entries,
    close: async () => {},
  };
}

async function persistedSnapshot(): Promise<Array<[string, string]>> {
  const entries: Array<[string, string]> = [];
  const written = Promise.withResolvers<void>();
  const source = createWtQueryClient(memoryStorage(Promise.resolve([]), (key, value) => {
    entries.push([key, value]);
    if (entries.length === 3) written.resolve();
  }));
  try {
    await source.restored;
    for (const key of ["orphan", "live", "normal"]) {
      await source.client.fetchQuery({ queryKey: [key], queryFn: async () => "old" });
    }
    await written.promise;
    return entries;
  } finally { await source.shutdown(); }
}

test("late cache restoration cannot resurrect evicted keys or overwrite live data", async () => {
  const entries = await persistedSnapshot();
  const pending = Promise.withResolvers<Array<[string, string]>>();
  const target = createWtQueryClient(memoryStorage(pending.promise));
  try {
    target.evict(["orphan"]);
    target.client.setQueryData(["live"], "fresh");
    pending.resolve(entries);
    await target.restored;
    expect(target.client.getQueryData(["orphan"])).toBeUndefined();
    expect(target.client.getQueryData<string>(["live"])).toBe("fresh");
    expect(target.client.getQueryData<string>(["normal"])).toBe("old");
  } finally { await target.shutdown(); }
});

test("a cache read finishing after shutdown does not repopulate the client", async () => {
  const entries = await persistedSnapshot();
  const pending = Promise.withResolvers<Array<[string, string]>>();
  const target = createWtQueryClient(memoryStorage(pending.promise));
  await target.shutdown();
  pending.resolve(entries);
  await target.restored;
  expect(target.client.getQueryCache().getAll()).toHaveLength(0);
});
