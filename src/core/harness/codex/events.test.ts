import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  codexEventPolling,
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
    const fiber = yield* Effect.forkChild(codexEventPolling(
      () => [],
      undefined,
      { workerFactory: () => worker, intervalMs: 100 },
    ));
    yield* Effect.yieldNow;
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
  }).pipe(Effect.provide(TestClock.layer())));
});

test("an empty worker result releases the lane and reports changed slots", async () => {
  const posted: CodexEventsWorkerMessage[] = [];
  const changes: string[][] = [];
  let onMessage: ((event: MessageEvent) => void) | null = null;
  const worker = {
    postMessage(message: CodexEventsWorkerMessage) {
      posted.push(message);
    },
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      if (type === "message") onMessage = listener;
    },
    terminate() {},
  } as unknown as CodexEventsWorker;

  await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(codexEventPolling(
      () => [{ slug: "manager", wtPath: "/repo" }],
      (slugs) => changes.push([...slugs]),
      { workerFactory: () => worker, intervalMs: 100 },
    ));
    yield* Effect.yieldNow;

    yield* TestClock.adjust(100);
    expect(posted.filter((message) => message.type === "poll")).toHaveLength(1);
    if (!onMessage) throw new Error("message listener was not installed");
    onMessage({
      data: { type: "events", events: [], changedSlugs: ["manager"] },
    } as MessageEvent);
    expect(changes).toEqual([["manager"]]);

    yield* TestClock.adjust(100);
    expect(posted.filter((message) => message.type === "poll")).toHaveLength(2);
    yield* Fiber.interrupt(fiber);
  }).pipe(Effect.provide(TestClock.layer())));
});
