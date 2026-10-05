import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { Effect, Exit } from "effect";

import {
  acquireRuntimeResource,
  invalidateRefQueries,
  isSuccessfulWorktreeInventoryUpdate,
  refreshWorktreeInventory,
} from "./runtime.tsx";
import { unlockedWatchTargets, WorktreeWatchSet } from "../core/repo-watch.ts";
import { qk } from "../state/keys.ts";
import type { Worktree } from "../core/types.ts";

describe("TUI runtime resources", () => {
  test("refs invalidate branch tips used by branch.advanced", () => {
    const keys: unknown[][] = [];

    invalidateRefQueries((key) => keys.push([...key]));

    expect(keys).toContainEqual(["watchedBranchTips"]);
  });

  test("locked watcher resumes only from a successful fresh inventory", async () => {
    const queryClient = new QueryClient();
    const target = { slug: "slice", path: "/worktrees/slice" };
    const initial = [{ ...target, isMain: false }] as Worktree[];
    const attached: string[] = [];
    const disposed: string[] = [];
    const catchups: string[] = [];
    let locked = false;
    const deferred = new Set<string>();
    const watchers = new WorktreeWatchSet(
      () => {},
      {
        onAttach: (slug) => {
          if (deferred.delete(slug)) catchups.push(slug);
        },
        watchDir: (path) => {
          attached.push(path);
          return () => disposed.push(path);
        },
      },
    );
    const reconcile = (rows: Worktree[] | undefined): void => {
      watchers.reconcile(unlockedWatchTargets(rows ?? [], () => locked)
        .map(({ slug, path }) => ({ slug, path })));
    };
    const key = qk.worktrees();
    queryClient.setQueryData(key, initial);
    reconcile(queryClient.getQueryData<Worktree[]>(key));

    let finishFetch!: (rows: Worktree[]) => void;
    const observer = new QueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => {
        const pending = Promise.withResolvers<Worktree[]>();
        finishFetch = pending.resolve;
        return pending.promise;
      },
      staleTime: Infinity,
    });
    const stopObserver = observer.subscribe(() => {});
    const eventTypes: string[] = [];
    const stopCache = queryClient.getQueryCache().subscribe((event) => {
      if (event.query.queryKey[0] !== "worktrees") return;
      if (event.type === "updated") eventTypes.push(String(event.action.type));
      if (!isSuccessfulWorktreeInventoryUpdate(event)) return;
      reconcile(event.query.state.data as Worktree[] | undefined);
    });

    try {
      // Acquire: detach immediately. Once released, a fetch-start event
      // still carries the stale row, so it must not reattach the watcher.
      locked = true;
      deferred.add("slice");
      watchers.suspend("slice");
      locked = false;
      const createRefresh = observer.refetch();
      expect(eventTypes).toContain("fetch");
      expect(attached).toEqual([target.path]);
      finishFetch(initial);
      await createRefresh;
      expect(attached).toEqual([target.path, target.path]);
      expect(catchups).toEqual(["slice"]);

      // A destroy follows the same gate. The stale inventory cannot
      // resurrect its watcher while the refetch is in flight.
      locked = true;
      deferred.add("slice");
      watchers.suspend("slice");
      locked = false;
      const destroyRefresh = observer.refetch();
      expect(eventTypes.filter((type) => type === "fetch")).toHaveLength(2);
      expect(attached).toEqual([target.path, target.path]);
      finishFetch([]);
      await destroyRefresh;
      expect(attached).toEqual([target.path, target.path]);
      expect(disposed).toEqual([target.path, target.path]);
      expect(catchups).toEqual(["slice"]);
    } finally {
      stopCache();
      stopObserver();
      watchers.dispose();
      queryClient.clear();
    }
  });

  test("operation completion replaces an initial inventory fetch with no cached data", async () => {
    const client = new QueryClient();
    const key = qk.worktrees();
    const oldFetch = Promise.withResolvers<string[]>();
    const newFetch = Promise.withResolvers<string[]>();
    const newStarted = Promise.withResolvers<void>();
    const signals: AbortSignal[] = [];
    const observer = new QueryObserver(client, {
      queryKey: key,
      queryFn: ({ signal }) => {
        signals.push(signal);
        if (signals.length === 1) return oldFetch.promise;
        newStarted.resolve();
        return newFetch.promise;
      },
    });
    const stop = observer.subscribe(() => {});
    try {
      expect(client.getQueryData(key)).toBeUndefined();
      const refresh = Effect.runPromise(refreshWorktreeInventory(client));
      await newStarted.promise;
      expect(signals[0]?.aborted).toBe(true);
      oldFetch.resolve([]);
      newFetch.resolve(["created-after-first-fetch"]);
      await refresh;
      expect(client.getQueryData<string[]>(key)).toEqual(["created-after-first-fetch"]);
      expect(signals).toHaveLength(2);
    } finally {
      stop();
      client.clear();
    }
  });

  test("releases every acquired resource when later startup fails", async () => {
    const releases: string[] = [];
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* acquireRuntimeResource(
          Effect.succeed("watcher"),
          (name) => {
            releases.push(name);
          },
        );
        yield* acquireRuntimeResource(
          Effect.succeed("query-client"),
          (name) => {
            releases.push(name);
          },
        );
        return yield* acquireRuntimeResource(
          Effect.fail("renderer startup failed"),
          () => {
            releases.push("renderer");
          },
        );
      }),
    );

    const exit = await Effect.runPromiseExit(program);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(releases).toEqual(["query-client", "watcher"]);
  });

  test("a throwing finalizer does not skip later cleanup", async () => {
    const releases: string[] = [];
    const program = Effect.scoped(
      Effect.gen(function* () {
        yield* acquireRuntimeResource(
          Effect.succeed("first"),
          (name) => {
            releases.push(name);
          },
        );
        yield* acquireRuntimeResource(
          Effect.succeed("throws"),
          (name) => {
            releases.push(name);
            throw new Error("cleanup failed");
          },
        );
        yield* acquireRuntimeResource(
          Effect.succeed("last"),
          (name) => {
            releases.push(name);
          },
        );
      }),
    );

    const exit = await Effect.runPromiseExit(program);

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(releases).toEqual(["last", "throws", "first"]);
  });
});
