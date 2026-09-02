import { describe, expect, test } from "bun:test";
import { Effect, Fiber, TestClock, TestContext } from "effect";

import type { GhActionResult } from "../../core/github/types.ts";
import {
  autoMergeRetryPending,
  autoMergeRetryEffect,
  cancelAutoMergeRetry,
  RETRY_LIMIT_MS,
  startAutoMergeRetry,
} from "./auto-merge-retry.ts";

const gap: GhActionResult = { ok: false, error: "is expected", retryable: true };
const hard: GhActionResult = { ok: false, error: "head oid does not match" };

/** Settle the loop without sleeping a real interval. */
function tick(ms = 8): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("startAutoMergeRetry", () => {
  test("keeps asking while the refusal stays retryable, then arms", async () => {
    let calls = 0;
    let armed = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          autoMergeRetryEffect(
            async () => (++calls < 3 ? gap : { ok: true }),
            {
              onArmed: () => void armed++,
              onFailed: () => {},
              onGaveUp: () => {},
            },
            { everyMs: 100 },
          ),
        );
        for (let attempt = 0; attempt < 3; attempt++) {
          yield* TestClock.adjust(100);
          yield* Effect.yieldNow();
        }
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
    expect(calls).toBe(3);
    expect(armed).toBe(1);
  });

  test("a refusal that is NOT the gap ends it immediately", async () => {
    // The whole safety argument: a genuine problem must not be able to
    // hide inside a retry loop.
    let calls = 0;
    const errors: string[] = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          autoMergeRetryEffect(
            async () => {
              calls++;
              return hard;
            },
            {
              onArmed: () => {},
              onFailed: (error) => void errors.push(error),
              onGaveUp: () => {},
            },
            { everyMs: 100 },
          ),
        );
        yield* TestClock.adjust(100);
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
    expect(calls).toBe(1);
    expect(errors).toEqual(["head oid does not match"]);
  });

  test("gives up once the budget is spent rather than looping forever", async () => {
    let gaveUp = 0;
    let nowCalls = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          autoMergeRetryEffect(
            async () => gap,
            {
              onArmed: () => {},
              onFailed: () => {},
              onGaveUp: () => void gaveUp++,
            },
            {
              everyMs: 100,
              now: () => (nowCalls++ === 0 ? 0 : RETRY_LIMIT_MS + 1),
            },
          ),
        );
        yield* Effect.yieldNow();
        yield* TestClock.adjust(100);
        yield* Effect.yieldNow();
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestContext.TestContext)),
    );
    expect(gaveUp).toBe(1);
  });

  test("cancel stops it and reports whether there was anything to stop", async () => {
    let calls = 0;
    startAutoMergeRetry(
      4,
      async () => {
        calls++;
        return gap;
      },
      { onArmed: () => {}, onFailed: () => {}, onGaveUp: () => {} },
      { everyMs: 50 },
    );
    expect(autoMergeRetryPending(4)).toBe(true);
    expect(cancelAutoMergeRetry(4)).toBe(true);
    // Second cancel has nothing to do — this is what lets the disarm
    // leg tell "cancelled a pending arm" from "nothing was armed".
    expect(cancelAutoMergeRetry(4)).toBe(false);
    await tick(80);
    expect(calls).toBe(0);
  });

  test("a cancel during an in-flight attempt wins over its result", async () => {
    let armed = 0;
    startAutoMergeRetry(
      5,
      async () => {
        cancelAutoMergeRetry(5);
        return { ok: true } as GhActionResult;
      },
      { onArmed: () => void armed++, onFailed: () => {}, onGaveUp: () => {} },
      { everyMs: 1 },
    );
    await tick(30);
    expect(armed).toBe(0);
  });

  test("re-arming replaces the loop instead of stacking a second one", async () => {
    let a = 0;
    let b = 0;
    const cb = { onArmed: () => {}, onFailed: () => {}, onGaveUp: () => {} };
    startAutoMergeRetry(6, async () => (a++, gap), cb, { everyMs: 4 });
    startAutoMergeRetry(6, async () => (b++, gap), cb, { everyMs: 4 });
    await tick(30);
    cancelAutoMergeRetry(6);
    expect(a).toBe(0);
    expect(b).toBeGreaterThan(0);
  });
});
