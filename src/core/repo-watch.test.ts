import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  makeDebounced,
  unlockedWatchTargets,
  WorktreeWatchSet,
} from "./repo-watch.ts";

describe("makeDebounced", () => {
  test("retriggering cancels and replaces the pending callback", async () => {
    let calls = 0;
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const debounced = yield* makeDebounced(() => { calls++; }, 100);
      debounced.trigger();
      yield* TestClock.adjust(50);
      debounced.trigger();
      yield* Effect.yieldNow;
      yield* TestClock.adjust(99);
      expect(calls).toBe(0);
      yield* TestClock.adjust(1);
      expect(calls).toBe(1);
    })).pipe(Effect.provide(TestClock.layer())));
  });

  test("scope close interrupts and joins pending callback", async () => {
    let calls = 0;
    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.scoped(Effect.gen(function* () {
        const debounced = yield* makeDebounced(() => { calls++; }, 100);
        debounced.trigger();
        return yield* Effect.never;
      })));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust(100);
      expect(calls).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())));
  });

  test("cancel is idempotent", async () => {
    let calls = 0;
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const debounced = yield* makeDebounced(() => { calls++; }, 100);
      debounced.trigger();
      yield* debounced.cancel;
      yield* debounced.cancel;
      yield* TestClock.adjust(100);
      expect(calls).toBe(0);
    })).pipe(Effect.provide(TestClock.layer())));
  });
});

describe("worktree watcher creation gate", () => {
  test("does not attach during a lock, then attaches once with one catch-up", () => {
    let targets = [{ slug: "slice", path: "/worktrees/slice" }];
    let locked = true;
    const attached: string[] = [];
    const disposed: string[] = [];
    const catchups: string[] = [];
    let changes = 0;
    const watchers = new WorktreeWatchSet(
      () => { changes++; },
      {
        onAttach: (slug) => catchups.push(slug),
        watchDir: (path) => {
          attached.push(path);
          return () => disposed.push(path);
        },
      },
    );

    const reconcile = (): void => {
      watchers.reconcile(unlockedWatchTargets(targets, () => locked));
    };
    reconcile();
    expect(attached).toEqual([]);
    expect(catchups).toEqual([]);
    expect(changes).toBe(0);

    locked = false;
    reconcile();
    reconcile();
    expect(attached).toEqual(["/worktrees/slice"]);
    expect(catchups).toEqual(["slice"]);
    expect(changes).toBe(0);

    // A subsequent destroy lock removes the recursive watcher; a missing
    // row on the next inventory reconciliation disposes it permanently.
    locked = true;
    reconcile();
    expect(disposed).toEqual(["/worktrees/slice"]);
    targets = [];
    locked = false;
    reconcile();
    expect(attached).toEqual(["/worktrees/slice"]);
    expect(catchups).toEqual(["slice"]);
    // Recreating the slug attaches a new watcher exactly once.
    targets = [{ slug: "slice", path: "/worktrees/slice" }];
    reconcile();
    expect(attached).toEqual(["/worktrees/slice", "/worktrees/slice"]);
    expect(catchups).toEqual(["slice", "slice"]);
    watchers.dispose();
  });
});
