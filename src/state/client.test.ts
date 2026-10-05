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

test("canonical wtstate never restores or persists a stale title-lock snapshot", async () => {
  const entries = await persistedSnapshot();
  const legacy = JSON.parse(entries[0]![1]);
  legacy.queryKey = ["wtState"];
  legacy.queryHash = JSON.stringify(legacy.queryKey);
  legacy.state.data = { slugs: { task: { section: null, order: 0 } } };
  const legacyEntry: [string, string] = [`wt-${legacy.queryHash}`, JSON.stringify(legacy)];
  const writes: string[] = [];
  const storage = memoryStorage(Promise.resolve([legacyEntry]), (key) => { writes.push(key); });
  storage.getItem = async () => legacyEntry[1];
  const target = createWtQueryClient(storage);
  try {
    await target.restored;
    expect(target.client.getQueryData(["wtState"])).toBeUndefined();
    const canonical = { slugs: { task: { section: null, order: 0, manualTitle: "Pinned" } } };
    let reads = 0;
    expect(await target.client.fetchQuery<typeof canonical>({
      queryKey: ["wtState"],
      queryFn: async () => { reads++; return canonical; },
    })).toEqual(canonical);
    expect(reads).toBe(1);
    expect(writes).toEqual([]);
  } finally { await target.shutdown(); }
});

test("explicit refresh bypasses cold restoration and persists the fresh result", async () => {
  const entries = await persistedSnapshot();
  const entry = entries.find(([, value]) => JSON.parse(value).queryKey[0] === "normal")!;
  const written = Promise.withResolvers<string>();
  const storage = memoryStorage(Promise.resolve([]), (_key, value) => { written.resolve(value); });
  storage.getItem = async () => entry[1];
  const target = createWtQueryClient(storage);
  try {
    await target.restored;
    let calls = 0;
    expect(await target.client.fetchQuery<string>({
      queryKey: ["normal"], staleTime: 0, meta: { forceFresh: true },
      queryFn: async () => { calls++; return "fresh"; },
    })).toBe("fresh");
    expect(calls).toBe(1);
    expect(JSON.parse(await written.promise).state.data).toBe("fresh");
  } finally { await target.shutdown(); }
});
