import { describe, expect, test } from "bun:test";
import { Effect, Fiber, TestClock, TestContext } from "effect";

import { pollUntilEffect } from "./poll.ts";

describe("pollUntilEffect", () => {
  test("checks immediately and then on the configured cadence", async () => {
    let checks = 0;
    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.fork(pollUntilEffect({
        check: () => ++checks === 3,
        budgetMs: 1_000,
        intervalMs: 100,
      }));
      yield* Effect.yieldNow();
      expect(checks).toBe(1);
      yield* TestClock.adjust(199);
      expect(checks).toBe(2);
      yield* TestClock.adjust(1);
      expect(yield* Fiber.join(fiber)).toBeTrue();
    }).pipe(Effect.provide(TestContext.TestContext)));
  });

  test("interrupting during sleep performs no later checks", async () => {
    let checks = 0;
    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.fork(pollUntilEffect({
        check: () => { checks++; return false; },
        budgetMs: 1_000,
        intervalMs: 100,
      }));
      yield* Effect.yieldNow();
      yield* Fiber.interrupt(fiber);
      yield* TestClock.adjust(1_000);
      expect(checks).toBe(1);
    }).pipe(Effect.provide(TestContext.TestContext)));
  });

  test("returns false at the deadline", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.fork(pollUntilEffect({
        check: () => false,
        budgetMs: 200,
        intervalMs: 100,
      }));
      yield* TestClock.adjust(200);
      expect(yield* Fiber.join(fiber)).toBeFalse();
    }).pipe(Effect.provide(TestContext.TestContext)));
  });
});
