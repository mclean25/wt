import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

import { createFetchCountStore } from "./fetch-count.ts";

test("fetch count follows starts, completion, errors, cancellation and removal", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createFetchCountStore(client.getQueryCache());
  let notifications = 0;
  const stop = store.subscribe(() => { notifications++; });
  const check = () => expect(store.getSnapshot()).toBe(client.isFetching());
  const first = Promise.withResolvers<string>();
  const second = Promise.withResolvers<string>();
  try {
    const a = client.fetchQuery({ queryKey: ["a"], queryFn: () => first.promise });
    const b = client.fetchQuery({ queryKey: ["b"], queryFn: () => second.promise });
    check();
    expect(store.getSnapshot()).toBe(2);
    client.setQueryData(["unrelated"], "value");
    expect(notifications).toBe(2);
    first.resolve("done");
    await a;
    check();
    second.reject(new Error("fixture failure"));
    await b.catch(() => {});
    check();
    const cancelled = client.fetchQuery({ queryKey: ["cancelled"], queryFn: () => Promise.withResolvers<never>().promise });
    void cancelled.catch(() => {});
    check();
    await client.cancelQueries({ queryKey: ["cancelled"] });
    check();
    const removed = client.fetchQuery({ queryKey: ["removed"], queryFn: () => Promise.withResolvers<never>().promise });
    void removed.catch(() => {});
    check();
    client.removeQueries({ queryKey: ["removed"] });
    check();
    expect(store.getSnapshot()).toBe(0);
  } finally {
    stop();
    client.clear();
  }
});

test("fetch count reseeds across the render-subscribe gap and subscription lifetimes", () => {
  const client = new QueryClient();
  const cache = client.getQueryCache();
  const query = cache.build(client, { queryKey: ["query"] });
  const store = createFetchCountStore(cache);
  expect(store.getSnapshot()).toBe(0);
  query.setState({ fetchStatus: "fetching" });
  const stop = store.subscribe(() => {});
  expect(store.getSnapshot()).toBe(1);
  query.setState({ fetchStatus: "paused" });
  expect(store.getSnapshot()).toBe(client.isFetching());
  query.setState({ fetchStatus: "fetching" });
  query.reset();
  expect(store.getSnapshot()).toBe(0);
  stop();
  query.setState({ fetchStatus: "fetching" });
  const stopAgain = store.subscribe(() => {});
  expect(store.getSnapshot()).toBe(1);
  client.clear();
  expect(store.getSnapshot()).toBe(0);
  stopAgain();
});

test("observer churn and query updates do not rescan the cache", () => {
  const client = new QueryClient();
  const cache = client.getQueryCache();
  const query = cache.build(client, { queryKey: ["query"] });
  let scans = 0;
  const getAll = cache.getAll.bind(cache);
  cache.getAll = () => { scans++; return getAll(); };
  const store = createFetchCountStore(cache);
  let notifications = 0;
  const stop = store.subscribe(() => { notifications++; });
  const initialScans = scans;
  for (let i = 0; i < 1_000; i++) {
    cache.notify({ type: "observerResultsUpdated", query });
    query.setData(i);
    store.getSnapshot();
  }
  expect(scans).toBe(initialScans);
  expect(notifications).toBe(0);
  query.setState({ fetchStatus: "fetching" });
  expect(store.getSnapshot()).toBe(1);
  expect(scans).toBe(initialScans);
  stop();
  client.clear();
});

test("stores stay isolated when the query client changes and ignore removed queries", () => {
  const first = new QueryClient();
  const second = new QueryClient();
  const firstStore = createFetchCountStore(first.getQueryCache());
  const secondStore = createFetchCountStore(second.getQueryCache());
  const stopFirst = firstStore.subscribe(() => {});
  const stopSecond = secondStore.subscribe(() => {});
  const old = first.getQueryCache().build(first, { queryKey: ["same-key"] });
  old.setState({ fetchStatus: "fetching" });
  expect(firstStore.getSnapshot()).toBe(1);
  expect(secondStore.getSnapshot()).toBe(0);
  first.clear();
  old.setState({ fetchStatus: "fetching" });
  expect(firstStore.getSnapshot()).toBe(0);
  const replacement = first.getQueryCache().build(first, { queryKey: ["same-key"] });
  replacement.setState({ fetchStatus: "fetching" });
  old.setState({ fetchStatus: "idle" });
  expect(firstStore.getSnapshot()).toBe(first.isFetching());
  stopFirst();
  stopSecond();
  first.clear();
  second.clear();
});

test("queries added while fetching and multiple subscribers retain the correct count", () => {
  const client = new QueryClient();
  const cache = client.getQueryCache();
  const idle = cache.build(client, { queryKey: ["idle"] });
  const store = createFetchCountStore(cache);
  const stopFirst = store.subscribe(() => {});
  let notifications = 0;
  const stopSecond = store.subscribe(() => { notifications++; });
  cache.build(client, { queryKey: ["already-fetching"] }, {
    ...idle.state,
    fetchStatus: "fetching",
  });
  expect(store.getSnapshot()).toBe(client.isFetching());
  expect(notifications).toBe(1);
  stopFirst();
  client.clear();
  expect(store.getSnapshot()).toBe(0);
  expect(notifications).toBe(2);
  stopSecond();
});
