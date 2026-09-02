import { describe, expect, test } from "bun:test";
import { Clock, Deferred, Duration, Effect, Exit, Scope } from "effect";
import { TestClock } from "effect/testing";

import type { GithubEventsConfig } from "../config.ts";
import {
  type DaemonDependencies,
  makeDaemonCore,
  nextFetchAt,
} from "./daemon.ts";

const DEBOUNCE = 1_500;
const FLOOR = 30_000;

describe("nextFetchAt", () => {
  test("first delivery after a quiet spell fires on the debounce, not the floor", () => {
    // The interactive case: you push, one check_suite lands, nothing else is
    // happening. The floor must not slow this down — it is what governs how
    // fast a badge flips.
    const now = 1_000_000;
    expect(nextFetchAt(now, now - 10 * FLOOR, null)).toBe(now + DEBOUNCE);
  });

  test("with no fetch ever run, the floor is already satisfied", () => {
    const now = 1_000_000;
    expect(nextFetchAt(now, 0, null)).toBe(now + DEBOUNCE);
  });

  test("a delivery right after a fetch is held to the floor", () => {
    const started = 1_000_000;
    const now = started + 2_000;
    expect(nextFetchAt(now, started, null)).toBe(started + FLOOR);
  });

  test("the floor measures from the fetch's start, so a slow query eats into it", () => {
    // A 5s fetch that finishes at start+5000 must still fire its trailing
    // re-run at start+FLOOR, not start+5000+FLOOR: the floor caps the rate,
    // it does not add to latency.
    const started = 1_000_000;
    const finished = started + 5_000;
    expect(nextFetchAt(finished, started, null)).toBe(started + FLOOR);
  });

  test("a pending timer that already satisfies both constraints is left alone", () => {
    const started = 1_000_000;
    const pending = started + FLOOR;
    expect(nextFetchAt(started + 3_000, started, pending)).toBeNull();
  });

  test("a sustained stream cannot starve the fetch", () => {
    // The regression this exists for. Deliveries arriving faster than the
    // debounce window, re-scheduling each time, previously pushed the firing
    // time out indefinitely. Simulate the observed ~43/min (one per 1.4s,
    // inside the 1.5s debounce) and assert the fetch still fires by the floor.
    const started = 1_000_000;
    let pending: number | null = null;
    let armedAt: number | null = null;
    for (let now = started + 100; now < started + 5 * FLOOR; now += 1_400) {
      const at = nextFetchAt(now, started, pending);
      if (at !== null) {
        pending = at;
        if (armedAt === null) armedAt = at;
      }
      // Nothing may ever push the pending fetch later than the floor.
      expect(pending).toBeLessThanOrEqual(started + FLOOR);
    }
    expect(armedAt).toBe(started + FLOOR);
  });

  test("only the first delivery in a window arms the timer", () => {
    const started = 1_000_000;
    let pending: number | null = null;
    const armed: number[] = [];
    for (const now of [started + 500, started + 900, started + 1_200, started + 4_000]) {
      const at = nextFetchAt(now, started, pending);
      if (at !== null) {
        armed.push(at);
        pending = at;
      }
    }
    expect(armed).toEqual([started + FLOOR]);
  });

  test("a burst of simultaneous deliveries collapses to one fetch", () => {
    // A CI step storm arrives as a dozen check_run events at the same instant
    // with no recent fetch. All but the first must be no-ops.
    const now = 1_000_000;
    let pending: number | null = null;
    let arms = 0;
    for (let i = 0; i < 12; i++) {
      const at = nextFetchAt(now, 0, pending);
      if (at !== null) {
        arms++;
        pending = at;
      }
    }
    expect(arms).toBe(1);
    expect(pending).toBe(now + DEBOUNCE);
  });
});

const events: GithubEventsConfig = {
  port: 32123,
  host: "127.0.0.1",
  secret: "test",
  secretFile: null,
  backstopPollMs: 600_000,
};

function testDependencies(options: {
  fetchGithub?: DaemonDependencies["fetchGithub"];
  fetchStarts: number[];
  snapshotWrites: number[];
  markerWrites: number[];
  stateWrites?: Array<{ eventCount: number; lastEventAt: number | null }>;
}): DaemonDependencies {
  return {
    ensureEventsDir: () => {},
    currentBranches: () => Effect.succeed(["feature"]),
    fetchOrigin: Effect.void,
    fetchGithub: options.fetchGithub ?? (() => Effect.gen(function* () {
      options.fetchStarts.push(yield* Clock.currentTimeMillis);
      return { prs: new Map(), mergeQueue: new Map() };
    })),
    writeSnapshot: (snapshot) => { options.snapshotWrites.push(snapshot.updatedAt); },
    touchMarker: (at) => { options.markerWrites.push(at); },
    writeState: (state) => {
      options.stateWrites?.push({ eventCount: state.eventCount, lastEventAt: state.lastEventAt });
    },
    sourceMoved: () => false,
    exitForUpgrade: Effect.never,
  };
}

const runTest = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(TestClock.layer())));

describe("Effect daemon lifecycle", () => {
  test("event counters include only parsed events relevant to this fleet", async () => {
    const dependencies = testDependencies({
      fetchStarts: [],
      snapshotWrites: [],
      markerWrites: [],
    });

    await runTest(Effect.gen(function* () {
      const core = yield* makeDaemonCore(events, dependencies);
      yield* core.accept("check_suite", "not json");
      yield* core.accept("check_suite", JSON.stringify({ check_suite: { head_branch: "other" } }));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect((yield* core.state).eventCount).toBe(0);

      yield* core.accept("check_suite", JSON.stringify({ check_suite: { head_branch: "feature" } }));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect((yield* core.state).eventCount).toBe(1);
    }));
  });

  test("closing during a fetch interrupts and joins it with no late writes", async () => {
    const fetchStarts: number[] = [];
    const snapshotWrites: number[] = [];
    const markerWrites: number[] = [];
    const gate = await Effect.runPromise(Deferred.make<void>());
    const dependencies = testDependencies({
      fetchStarts,
      snapshotWrites,
      markerWrites,
      fetchGithub: () => Effect.gen(function* () {
        fetchStarts.push(yield* Clock.currentTimeMillis);
        yield* Deferred.await(gate);
        return { prs: new Map(), mergeQueue: new Map() };
      }),
    });

    await Effect.runPromise(Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const scope = yield* Scope.make();
      yield* makeDaemonCore(events, dependencies).pipe(Scope.provide(scope));
      yield* Effect.yieldNow;
      expect(fetchStarts).toEqual([1_000_000]);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.succeed(gate, undefined);
      yield* TestClock.adjust(Duration.minutes(2));
      yield* Effect.yieldNow;
    }).pipe(Effect.provide(TestClock.layer())));

    expect(snapshotWrites).toEqual([]);
    expect(markerWrites).toEqual([]);
  });

  test("a trailing delivery cannot rearm after scope close", async () => {
    const fetchStarts: number[] = [];
    const snapshotWrites: number[] = [];
    const markerWrites: number[] = [];
    const stateWrites: Array<{ eventCount: number; lastEventAt: number | null }> = [];
    const dependencies = testDependencies({ fetchStarts, snapshotWrites, markerWrites, stateWrites });

    await Effect.runPromise(Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const scope = yield* Scope.make();
      const core = yield* makeDaemonCore(events, dependencies).pipe(Scope.provide(scope));
      yield* Effect.yieldNow;
      yield* core.accept("pull_request", "{}");
      yield* Effect.yieldNow;
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust(Duration.minutes(2));
      yield* Effect.yieldNow;
    }).pipe(Effect.provide(TestClock.layer())));

    expect(fetchStarts).toEqual([1_000_000]);
    expect(snapshotWrites).toHaveLength(1);
    expect(stateWrites.some((state) => state.eventCount === 1 && state.lastEventAt === 1_000_000)).toBeTrue();
  });

  test("continuous deliveries do not starve the pending fetch", async () => {
    const fetchStarts: number[] = [];
    const dependencies = testDependencies({ fetchStarts, snapshotWrites: [], markerWrites: [] });

    await runTest(Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const core = yield* makeDaemonCore(events, dependencies);
      yield* Effect.yieldNow;
      for (let elapsed = 0; elapsed < FLOOR; elapsed += 1_400) {
        yield* core.accept("pull_request", "{}");
        yield* Effect.yieldNow;
        yield* TestClock.adjust(1_400);
      }
      yield* Effect.yieldNow;
      expect(fetchStarts.length).toBeGreaterThanOrEqual(2);
      expect(fetchStarts[1]).toBe(1_030_000);
    }));
  });

  test("minimum interval remains measured from fetch start", async () => {
    const fetchStarts: number[] = [];
    const dependencies = testDependencies({ fetchStarts, snapshotWrites: [], markerWrites: [] });

    await runTest(Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const core = yield* makeDaemonCore(events, dependencies);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(2_000);
      yield* core.accept("pull_request", "{}");
      yield* Effect.yieldNow;
      yield* TestClock.adjust(27_999);
      expect(fetchStarts).toEqual([1_000_000]);
      yield* TestClock.adjust(1);
      yield* Effect.yieldNow;
      expect(fetchStarts).toEqual([1_000_000, 1_030_000]);
    }));
  });
});
