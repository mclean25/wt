import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";

import { restackBackoffEffect } from "./engine.ts";

describe("restackBackoffEffect", () => {
  test("uses Effect clock for deterministic retry timing", async () => {
    const completed = await Effect.runPromise(
      Effect.gen(function* () {
        const done = yield* Ref.make(false);
        const fiber = yield* Effect.forkChild(
          restackBackoffEffect(2, 0).pipe(
            Effect.andThen(Ref.set(done, true)),
          ),
        );
        yield* TestClock.adjust(499);
        expect(yield* Ref.get(done)).toBe(false);
        yield* TestClock.adjust(1);
        yield* Fiber.join(fiber);
        return yield* Ref.get(done);
      }).pipe(Effect.provide(TestClock.layer())),
    );

    expect(completed).toBe(true);
  });
});
