import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";

import type { LockHandle } from "../locks.ts";
import { withLockHandles } from "./shared.ts";

function handle(onRelease: () => void): LockHandle {
  return {
    path: "/tmp/test.lock",
    fd: -1,
    phase: () => {},
    release: onRelease,
  };
}

describe("withLockHandles", () => {
  test("releases every lock when interrupted", async () => {
    let releases = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          withLockHandles(
            [handle(() => releases++), handle(() => releases++)],
            Effect.never,
          ),
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(releases).toBe(2);
  });

  test("releases locks after success", async () => {
    let releases = 0;
    const value = await Effect.runPromise(
      withLockHandles([handle(() => releases++)], Effect.succeed(42)),
    );

    expect(value).toBe(42);
    expect(releases).toBe(1);
  });
});
