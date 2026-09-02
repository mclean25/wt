import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { makeDebounced } from "./repo-watch.ts";

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
      yield* debounced.cancelEffect;
      yield* debounced.cancelEffect;
      yield* TestClock.adjust(100);
      expect(calls).toBe(0);
    })).pipe(Effect.provide(TestClock.layer())));
  });
});
