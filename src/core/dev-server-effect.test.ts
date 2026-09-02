import { expect, test } from "bun:test";
import { Duration, Effect, Fiber, TestClock, TestContext } from "effect";

import {
  DEV_SERVER_STOPPED,
  probePortEffect,
  waitForDevReadyEffect,
  waitForDevSlotEffect,
} from "./dev-server.ts";

test("waitForDevReadyEffect retries an unhealthy environment on TestClock", async () => {
  let healthChecks = 0;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        waitForDevReadyEffect(
          { slug: "demo", path: "/tmp/demo" },
          { timeoutMs: 10_000 },
          {
            status: () => Effect.succeed({
              ...DEV_SERVER_STOPPED,
              running: true,
              port: 3000,
              url: "http://localhost:3000",
            }),
            health: () => Effect.sync(() => {
              healthChecks += 1;
              return healthChecks < 3
                ? { ok: false, message: "migrations pending" }
                : { ok: true, message: "ready" };
            }),
          },
        ),
      );
      yield* TestClock.adjust(Duration.seconds(4));
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

  expect(result).toEqual({ ready: true, health: { ok: true, message: "ready" } });
  expect(healthChecks).toBe(3);
});

test("interrupting waitForDevSlotEffect always leaves the queue", async () => {
  const events: string[] = [];
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        waitForDevSlotEffect(
          "demo",
          { timeoutMs: 60_000 },
          {
            check: () => Effect.succeed({ ok: false, limit: 1, free: 0, holders: [] }),
            waiters: () => [{ slug: "demo", pid: 1, since: 0, priority: 0 }],
            join: () => { events.push("join"); },
            leave: () => { events.push("leave"); },
          },
        ),
      );
      yield* Effect.yieldNow();
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

  expect(events).toEqual(["join", "leave"]);
});

test("waitForDevSlotEffect counts a slow slot check against its deadline", async () => {
  let checks = 0;
  let waits = 0;
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(
        waitForDevSlotEffect(
          "demo",
          { timeoutMs: 1_000, onWait: () => { waits += 1; } },
          {
            check: () => Effect.gen(function* () {
              checks += 1;
              yield* Effect.sleep(Duration.seconds(2));
              return { ok: false, limit: 1, free: 0, holders: [] };
            }),
            waiters: () => [{ slug: "demo", pid: 1, since: 0, priority: 0 }],
            join: () => {},
            leave: () => {},
          },
        ),
      );
      yield* TestClock.adjust(Duration.seconds(2));
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );

  expect(result).toBe(false);
  expect(checks).toBe(1);
  expect(waits).toBe(0);
});

test("interrupting probePortEffect closes its socket resource", async () => {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {}, open() {}, close() {} },
  });
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(probePortEffect(server.port, 10_000));
        yield* Effect.yieldNow();
        yield* Fiber.interrupt(fiber);
      }),
    );
  } finally {
    server.stop(true);
  }
});
