import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Ref, TestClock, TestContext } from "effect";

import { restackBackoffEffect } from "./engine.ts";

describe("restackBackoffEffect", () => {
  test("uses Effect clock for deterministic retry timing", async () => {
    const completed = await Effect.runPromise(
      Effect.gen(function* () {
        const done = yield* Ref.make(false);
        const fiber = yield* Effect.fork(
          restackBackoffEffect(2, 0).pipe(
            Effect.andThen(Ref.set(done, true)),
          ),
        );
        yield* TestClock.adjust(499);
        expect(yield* Ref.get(done)).toBe(false);
        yield* TestClock.adjust(1);
        yield* Fiber.join(fiber);
        return yield* Ref.get(done);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );

    expect(completed).toBe(true);
  });
});
