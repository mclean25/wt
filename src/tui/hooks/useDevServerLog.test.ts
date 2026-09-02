import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { devServerLogPoll } from "./useDevServerLog.ts";

describe("devServerLogPoll", () => {
  test("a rejected read does not stop later polls", async () => {
    let reads = 0;
    const outputs: Array<string | null> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          devServerLogPoll(
            Effect.suspend(() =>
              ++reads === 1
                ? Effect.fail("temporary" as const)
                : Effect.succeed("ready"),
            ),
            (output) => outputs.push(output),
            100,
          ),
        );
        yield* Effect.yieldNow;
        expect(reads).toBe(1);
        expect(outputs).toEqual([]);
        yield* TestClock.adjust(100);
        yield* Effect.yieldNow;
        expect(reads).toBe(2);
        expect(outputs).toEqual(["ready"]);
        yield* Fiber.interrupt(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  });
});
