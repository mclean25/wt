import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Ref, TestClock, TestContext } from "effect";

import { waitForNewZedWindowEffect } from "./zed-windows.ts";

describe("waitForNewZedWindowEffect", () => {
  test("finds a window after the polling interval", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          waitForNewZedWindowEffect(
            new Set([1]),
            () => Effect.succeed(new Set([1, 2])),
            { intervalMs: 150, timeoutMs: 3000 },
          ),
        );
        yield* TestClock.adjust(150);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );

    expect(result).toBe(2);
  });

  test("stops at its deadline when no window appears", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          waitForNewZedWindowEffect(
            new Set([1]),
            () => Effect.succeed(new Set([1])),
            { intervalMs: 150, timeoutMs: 3000 },
          ),
        );
        yield* TestClock.adjust(3000);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );

    expect(result).toBeNull();
  });

  test("interruption cancels future polls", async () => {
    const polls = await Effect.runPromise(
      Effect.gen(function* () {
        const count = yield* Ref.make(0);
        const fiber = yield* Effect.fork(
          waitForNewZedWindowEffect(
            new Set([1]),
            () => Ref.update(count, (value) => value + 1).pipe(Effect.as(new Set([1]))),
          ),
        );
        yield* Fiber.interrupt(fiber);
        yield* TestClock.adjust(3000);
        return yield* Ref.get(count);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );

    expect(polls).toBe(0);
  });
});
