import type { Query, QueryCache } from "@tanstack/react-query";

/** Global fetch count, updated from the changed query instead of rescanning. */
export function createFetchCountStore(cache: QueryCache) {
  const fetching = new Set<Query>();
  const listeners = new Set<() => void>();
  let initialized = false;
  let unsubscribe: (() => void) | undefined;

  const seed = () => {
    fetching.clear();
    for (const query of cache.getAll()) {
      if (query.state.fetchStatus === "fetching") fetching.add(query);
    }
    initialized = true;
  };
  const getSnapshot = () => {
    if (!initialized) seed();
    return fetching.size;
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (!unsubscribe) {
      // Subscribe before taking the baseline: a query may have started
      // between React's render snapshot and this subscription.
      unsubscribe = cache.subscribe((event) => {
        if (event.type !== "added" && event.type !== "removed" && event.type !== "updated") return;
        const previous = fetching.size;
        const query = event.query;
        if (event.type !== "removed" && cache.get(query.queryHash) === query && query.state.fetchStatus === "fetching") {
          fetching.add(query);
        } else {
          fetching.delete(query);
        }
        if (fetching.size !== previous) {
          for (const notify of listeners) notify();
        }
      });
      seed();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        unsubscribe?.();
        unsubscribe = undefined;
        fetching.clear();
        initialized = false;
      }
    };
  };
  return { getSnapshot, subscribe };
}
