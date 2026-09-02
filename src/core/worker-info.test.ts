import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";

import type { RemoteConfig } from "./config.ts";
import {
  createWorkerInfoFetcher,
  parseWorkerInfo,
  WORKER_PROTOCOL_VERSION,
  type WorkerInfo,
} from "./worker-info.ts";

const remote: RemoteConfig = {
  host: "worker.example",
  label: "worker",
  wtPath: "~/.wt/bin/wt",
};

describe("worker handshake", () => {
  test("parses role, protocol, and build independently", () => {
    expect(
      parseWorkerInfo(
        JSON.stringify({
          role: "worker",
          protocol: WORKER_PROTOCOL_VERSION,
          build: "abc1234-dirty (2026-08-28)",
        }),
      ),
    ).toEqual({
      role: "worker",
      protocol: WORKER_PROTOCOL_VERSION,
      build: "abc1234-dirty (2026-08-28)",
    });
  });

  test("rejects a payload without a protocol version", () => {
    expect(() => parseWorkerInfo('{"role":"worker","build":"abc"}')).toThrow(
      "protocol version",
    );
  });

  test("a refresh replaces the cached build and deduplicates concurrent loads", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const fetcher = createWorkerInfoFetcher(() => {
      calls += 1;
      if (calls === 2) {
        return Effect.callback<WorkerInfo>((resume) => {
          release = () =>
            resume(
              Effect.succeed({
                role: "worker",
                protocol: WORKER_PROTOCOL_VERSION,
                build: `build-${calls}`,
              }),
            );
        });
      }
      return Effect.succeed({
        role: "worker",
        protocol: WORKER_PROTOCOL_VERSION,
        build: `build-${calls}`,
      } satisfies WorkerInfo);
    });

    expect((await Effect.runPromise(fetcher.fetchEffect(remote))).build).toBe("build-1");
    expect((await Effect.runPromise(fetcher.fetchEffect(remote))).build).toBe("build-1");
    expect(calls).toBe(1);

    const firstRefresh = Effect.runPromise(fetcher.refreshEffect(remote));
    const secondRefresh = Effect.runPromise(fetcher.refreshEffect(remote));
    await Bun.sleep(0);
    expect(calls).toBe(2);
    release?.();

    expect(await firstRefresh).toEqual(await secondRefresh);
    expect((await Effect.runPromise(fetcher.fetchEffect(remote))).build).toBe("build-2");
    expect(calls).toBe(2);
  });

  test("one interrupted waiter does not cancel the shared request", async () => {
    let calls = 0;
    let cancellations = 0;
    let complete: (() => void) | undefined;
    const fetcher = createWorkerInfoFetcher(() =>
      Effect.callback<WorkerInfo>((resume, signal) => {
        calls += 1;
        signal.addEventListener("abort", () => {
          cancellations += 1;
        });
        complete = () =>
          resume(
            Effect.succeed({
              role: "worker",
              protocol: WORKER_PROTOCOL_VERSION,
              build: "shared",
            }),
          );
      }),
    );
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const first = yield* Effect.forkScoped(fetcher.refreshEffect(remote));
      const second = yield* Effect.forkScoped(fetcher.refreshEffect(remote));
      while (calls === 0) yield* Effect.yieldNow;
      expect(calls).toBe(1);
      yield* Fiber.interrupt(first);
      expect(cancellations).toBe(0);
      complete?.();
      return yield* Fiber.join(second);
    })));
    expect(result.build).toBe("shared");
    expect(cancellations).toBe(0);
  });

  test("the final interrupted waiter cancels the shared request", async () => {
    let cancellations = 0;
    const fetcher = createWorkerInfoFetcher(() =>
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            cancellations += 1;
          }),
        ),
      ),
    );
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const waiting = yield* Effect.forkScoped(fetcher.refreshEffect(remote));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(waiting);
    })));
    for (let attempt = 0; attempt < 20 && cancellations === 0; attempt++) {
      await Bun.sleep(5);
    }
    expect(cancellations).toBe(1);
  });
});
