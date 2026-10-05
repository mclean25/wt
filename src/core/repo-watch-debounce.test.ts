import { describe, expect, test } from "bun:test";
import { Clock, Effect } from "effect";
import { TestClock } from "effect/testing";

import { makeDebounced } from "./repo-watch.ts";

describe("filesystem burst scheduling", () => {
  test("ten thousand events share one sleeper and preserve the trailing deadline", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      let sleeps = 0;
      let calls = 0;
      const measuredClock: Clock.Clock = {
        ...clock,
        sleep: (duration) => Effect.suspend(() => { sleeps++; return clock.sleep(duration); }),
      };
      const debounced = yield* makeDebounced(() => { calls++; }, 500).pipe(
        Effect.provideService(Clock.Clock, measuredClock),
      );
      debounced.trigger();
      yield* TestClock.adjust(250);
      for (let i = 0; i < 10_000; i++) debounced.trigger();
      expect(sleeps).toBe(1);
      yield* TestClock.adjust(499);
      expect(calls).toBe(0);
      yield* TestClock.adjust(1);
      expect(calls).toBe(1);
      expect(sleeps).toBe(2);
      yield* TestClock.adjust(1000);
      expect(calls).toBe(1);
    })).pipe(Effect.provide(TestClock.layer())));
  });

  test("a callback can trigger a second burst without losing its pending task", async () => {
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      let calls = 0;
      const debounced = yield* makeDebounced(() => {
        calls++;
        if (calls === 1) debounced.trigger();
      }, 100);
      debounced.trigger();
      yield* TestClock.adjust(100);
      expect(calls).toBe(1);
      yield* TestClock.adjust(99);
      expect(calls).toBe(1);
      yield* TestClock.adjust(1);
      expect(calls).toBe(2);
      debounced.trigger();
      yield* debounced.cancel;
      debounced.trigger();
      yield* TestClock.adjust(1000);
      expect(calls).toBe(2);
    })).pipe(Effect.provide(TestClock.layer())));
  });
});
