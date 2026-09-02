import { expect, test } from "bun:test";
import { Effect, Fiber, TestClock, TestContext } from "effect";

import {
  codexEventPollingEffect,
  type CodexEventsWorker,
} from "./events.ts";
import type { CodexEventsWorkerMessage } from "./events-protocol.ts";

test("polling interruption stops and joins the worker", async () => {
  const posted: CodexEventsWorkerMessage[] = [];
  let terminated = 0;
  const worker = {
    postMessage(message: CodexEventsWorkerMessage) {
      posted.push(message);
    },
    addEventListener() {},
    terminate() {
      terminated += 1;
    },
  } as unknown as CodexEventsWorker;

  await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.fork(codexEventPollingEffect(
      () => [],
      undefined,
      { workerFactory: () => worker, intervalMs: 100 },
    ));
    yield* Effect.yieldNow();
    expect(posted.filter((message) => message.type === "poll")).toHaveLength(0);

    yield* TestClock.adjust(100);
    expect(posted.filter((message) => message.type === "poll")).toHaveLength(1);

    yield* TestClock.adjust(100);
    expect(posted.filter((message) => message.type === "poll")).toHaveLength(2);

    yield* Fiber.interrupt(fiber);
    expect(terminated).toBe(1);
    expect(posted.at(-1)).toEqual({ type: "stop" });

    yield* TestClock.adjust(1_000);
    expect(posted.filter((message) => message.type === "poll")).toHaveLength(2);
    expect(terminated).toBe(1);
  }).pipe(Effect.provide(TestContext.TestContext)));
});
