import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { Effect } from "effect";

import {
  patchArchivedKeys,
  runOptimisticMutation,
  shouldReapRemoteArchive,
} from "./hooks.ts";

/**
 * Behavioral pins for `runOptimisticMutation` — the TanStack-scoped
 * replacement for the old hand-rolled mutation chain. These encode the
 * three properties the TUI's optimistic mutations depend on:
 *
 *  1. Same-filter calls run serialized, in submission order (scope.id).
 *  2. A failed mutation rolls back to the PRE-mutation snapshot, and a
 *     queued second mutation snapshots AFTER the first settles — so a
 *     rollback can never resurrect another call's optimistic state.
 *  3. A background refetch that lands mid-mutation cannot clobber the
 *     optimistic patch (the cache-subscription guard re-applies it).
 *  4. Nor can one that lands AFTER the mutation resolves — a server
 *     that accepted a write can still serve the pre-write value for a
 *     beat, and the settling invalidate is aimed straight at that
 *     window. The guard releases when a fetch finally AGREES, or when
 *     the mutation failed and the patch was rolled back.
 */

type Data = { v: string };

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = Effect.runPromise(
    Effect.callback<void, Error>((resume) => {
      resolve = () => resume(Effect.void);
      reject = (e) => resume(Effect.fail(e));
    }),
  );
  return { promise, resolve, reject };
}

const tick = () => Effect.runPromise(Effect.sleep(0));

test("archive patches keep the intended state when the settle guard reapplies them", () => {
  const archived = patchArchivedKeys(["existing"], "new", true);
  expect(patchArchivedKeys(archived, "new", true)).toEqual(["existing", "new"]);

  const restored = patchArchivedKeys(archived, "new", false);
  expect(patchArchivedKeys(restored, "new", false)).toEqual(["existing"]);
});

test("remote archive reconciliation requires a successful fetch in this mount", () => {
  expect(
    shouldReapRemoteArchive({ isSuccess: true, isFetchedAfterMount: true }),
  ).toBeTrue();
  expect(
    shouldReapRemoteArchive({ isSuccess: true, isFetchedAfterMount: false }),
  ).toBeFalse();
  expect(
    shouldReapRemoteArchive({ isSuccess: false, isFetchedAfterMount: true }),
  ).toBeFalse();
});

describe("runOptimisticMutation", () => {
  test("applies patch optimistically and settles", async () => {
    const qc = new QueryClient();
    qc.setQueryData<Data>(["github", "x"], { v: "server" });
    const gate = deferred();
    const done = runOptimisticMutation<Data>(qc, {
      filter: { queryKey: ["github"] },
      patch: (prev) => (prev ? { v: "optimistic" } : prev),
      run: () => gate.promise,
    });
    await tick();
    expect(qc.getQueryData<Data>(["github", "x"])?.v).toBe("optimistic");
    gate.resolve();
    await done;
    expect(qc.getQueryData<Data>(["github", "x"])?.v).toBe("optimistic");
  });

  test("serializes same-filter calls in submission order", async () => {
    const qc = new QueryClient();
    qc.setQueryData<Data>(["github", "x"], { v: "server" });
    const order: string[] = [];
    const gateA = deferred();
    const a = runOptimisticMutation<Data>(qc, {
      filter: { queryKey: ["github"] },
      patch: (prev) => prev,
      run: async () => {
        order.push("a-start");
        await gateA.promise;
        order.push("a-end");
      },
    });
    const b = runOptimisticMutation<Data>(qc, {
      filter: { queryKey: ["github"] },
      patch: (prev) => prev,
      run: async () => {
        order.push("b-start");
      },
    });
    await tick();
    expect(order).toEqual(["a-start"]); // b queued behind a's scope
    gateA.resolve();
    await Promise.all([a, b]);
    expect(order).toEqual(["a-start", "a-end", "b-start"]);
  });

  test("failed call rolls back; queued call snapshots post-settle state", async () => {
    const qc = new QueryClient();
    qc.setQueryData<Data>(["github", "x"], { v: "server" });
    const gateA = deferred();
    const a = runOptimisticMutation<Data>(qc, {
      filter: { queryKey: ["github"] },
      patch: () => ({ v: "a-optimistic" }),
      run: () => gateA.promise,
    });
    // B queues behind A while A's optimistic patch is visible.
    const gateB = deferred();
    const b = runOptimisticMutation<Data>(qc, {
      filter: { queryKey: ["github"] },
      patch: () => ({ v: "b-optimistic" }),
      run: () => gateB.promise,
    });
    await tick();
    expect(qc.getQueryData<Data>(["github", "x"])?.v).toBe("a-optimistic");
    // A fails → rolls back to "server" BEFORE b snapshots/patches.
    gateA.reject(new Error("a failed"));
    await expect(a).rejects.toThrow("a failed");
    await tick();
    expect(qc.getQueryData<Data>(["github", "x"])?.v).toBe("b-optimistic");
    // B fails too → must restore "server", not a's optimistic value.
    gateB.reject(new Error("b failed"));
    await expect(b).rejects.toThrow("b failed");
    expect(qc.getQueryData<Data>(["github", "x"])?.v).toBe("server");
  });

  test("mid-flight background refetch cannot clobber the patch", async () => {
    const qc = new QueryClient();
    qc.setQueryData<Data>(["github", "x"], { v: "server" });
    const gate = deferred();
    const done = runOptimisticMutation<Data>(qc, {
      filter: { queryKey: ["github"] },
      patch: (prev) => (prev ? { v: "optimistic" } : prev),
      run: () => gate.promise,
    });
    await tick();
    // A background refetch starts DURING the mutation (after
    // cancelQueries) and resolves with pre-mutation server truth.
    await qc.fetchQuery<Data>({
      queryKey: ["github", "x"],
      queryFn: async () => ({ v: "stale-refetch" }),
      staleTime: 0,
    });
    await tick();
    // Guard re-applied the patch on top of the refetched data.
    expect(qc.getQueryData<Data>(["github", "x"])?.v).toBe("optimistic");
    gate.resolve();
    await done;
  });

  // The regression this exists for: GitHub's GraphQL reads lag its own
  // mutations, so `onSettled`'s invalidate routinely refetches
  // pre-mutation data. Releasing the guard at `run` meant the badge
  // flipped back to draft moments after a successful mark-ready and
  // self-corrected on the next fetch — read as "it didn't work".
  test("a post-settle refetch that lands stale is still re-patched", async () => {
    const qc = new QueryClient();
    qc.setQueryData<Data>(["github", "x"], { v: "server" });
    const done = runOptimisticMutation<Data>(qc, {
      filter: { queryKey: ["github"] },
      patch: (prev) => (prev ? { v: "optimistic" } : prev),
      run: async () => {},
    });
    await done;
    await tick();
    await qc.fetchQuery<Data>({
      queryKey: ["github", "x"],
      queryFn: async () => ({ v: "server" }),
      staleTime: 0,
    });
    await tick();
    expect(qc.getQueryData<Data>(["github", "x"])?.v).toBe("optimistic");
  });

  // The guard's only real end condition. It has to self-terminate:
  // pinning the patch forever would suppress a genuine later change by
  // someone else (a PR re-drafted from the web UI).
  test("a fetch the patch no longer changes releases the guard", async () => {
    const qc = new QueryClient();
    qc.setQueryData<Data>(["github", "x"], { v: "server" });
    const done = runOptimisticMutation<Data>(qc, {
      filter: { queryKey: ["github"] },
      patch: (prev) => (prev ? { v: "optimistic" } : prev),
      run: async () => {},
    });
    await done;
    await tick();
    // The server caught up.
    await qc.fetchQuery<Data>({
      queryKey: ["github", "x"],
      queryFn: async () => ({ v: "optimistic" }),
      staleTime: 0,
    });
    await tick();
    // Now somebody else changes it. The guard is gone, so it sticks.
    await qc.fetchQuery<Data>({
      queryKey: ["github", "x"],
      queryFn: async () => ({ v: "someone-else" }),
      staleTime: 0,
    });
    await tick();
    expect(qc.getQueryData<Data>(["github", "x"])?.v).toBe("someone-else");
  });

  test("a failed mutation releases the guard instead of re-patching", async () => {
    const qc = new QueryClient();
    qc.setQueryData<Data>(["github", "x"], { v: "server" });
    await expect(
      runOptimisticMutation<Data>(qc, {
        filter: { queryKey: ["github"] },
        patch: (prev) => (prev ? { v: "optimistic" } : prev),
        run: async () => {
          throw new Error("nope");
        },
      }),
    ).rejects.toThrow("nope");
    await tick();
    expect(qc.getQueryData<Data>(["github", "x"])?.v).toBe("server");
    // A refetch after the rollback must not resurrect the patch.
    await qc.fetchQuery<Data>({
      queryKey: ["github", "x"],
      queryFn: async () => ({ v: "server" }),
      staleTime: 0,
    });
    await tick();
    expect(qc.getQueryData<Data>(["github", "x"])?.v).toBe("server");
  });

  test("the settle deadline releases the subscription and stops pinning the patch", async () => {
    const qc = new QueryClient();
    qc.setQueryData<Data>(["github", "x"], { v: "server" });
    await runOptimisticMutation<Data>(qc, {
      filter: { queryKey: ["github"] },
      patch: (prev) => (prev ? { v: "optimistic" } : prev),
      run: async () => {},
      settleGuardMs: 0,
    });
    await tick();
    await qc.fetchQuery<Data>({
      queryKey: ["github", "x"],
      queryFn: async () => ({ v: "someone-else" }),
      staleTime: 0,
    });
    await tick();
    expect(qc.getQueryData<Data>(["github", "x"])?.v).toBe("someone-else");
  });

  test("non-matching entries are untouched by patch and guard", async () => {
    const qc = new QueryClient();
    qc.setQueryData<Data>(["github", "x"], { v: "server" });
    qc.setQueryData<Data>(["other"], { v: "other" });
    const gate = deferred();
    const done = runOptimisticMutation<Data>(qc, {
      filter: { queryKey: ["github"] },
      patch: () => ({ v: "optimistic" }),
      run: () => gate.promise,
    });
    await tick();
    expect(qc.getQueryData<Data>(["other"])?.v).toBe("other");
    gate.resolve();
    await done;
    expect(qc.getQueryData<Data>(["other"])?.v).toBe("other");
  });
});
