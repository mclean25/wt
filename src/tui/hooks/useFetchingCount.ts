import { useCallback, useMemo, useSyncExternalStore } from "react";
import { notifyManager, useQueryClient } from "@tanstack/react-query";

import { createFetchCountStore } from "../../state/fetch-count.ts";

/** Keep the global refresh indicator local without scanning on every event. */
export function useFetchingCount(): number {
  const cache = useQueryClient().getQueryCache();
  const store = useMemo(() => createFetchCountStore(cache), [cache]);
  const subscribe = useCallback(
    (onChange: () => void) => store.subscribe(notifyManager.batchCalls(onChange)),
    [store],
  );
  return useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot);
}
