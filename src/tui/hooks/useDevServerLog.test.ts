import { describe, expect, test } from "bun:test";
import { Effect, Fiber, TestClock, TestContext } from "effect";

import { devServerLogPollEffect } from "./useDevServerLog.ts";

describe("devServerLogPollEffect", () => {
  test("a rejected read does not stop later polls", async () => {
    let reads = 0;
    const outputs: Array<string | null> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          devServerLogPollEffect(
            () =>
              ++reads === 1
                ? Promise.reject(new Error("temporary"))
                : Promise.resolve("ready"),
            (output) => outputs.push(output),
            100,
          ),
        );
        yield* Effect.yieldNow();
        expect(reads).toBe(1);
        expect(outputs).toEqual([]);
        yield* TestClock.adjust(100);
        yield* Effect.yieldNow();
        expect(reads).toBe(2);
        expect(outputs).toEqual(["ready"]);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
  });
});
