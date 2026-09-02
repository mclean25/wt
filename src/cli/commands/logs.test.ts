import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";

import { tailLog } from "./logs.ts";

describe("wt logs tail lifecycle", () => {
  test("interruption kills and reaps tail -F", async () => {
    let killed = 0;
    let reaped = 0;
    let exitCode: number | null = null;
    const { promise: exited, resolve: resolveExit } = Promise.withResolvers<number>();
    const finish = (code: number): void => {
      reaped++;
      resolveExit(code);
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          tailLog("/tmp/wt-logs-cleanup.log", () => ({
            exited,
            get exitCode() {
              return exitCode;
            },
            kill() {
              killed++;
              exitCode = 143;
              finish(143);
            },
          })),
        );
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(fiber);
      }),
    );

    expect(killed).toBe(1);
    expect(reaped).toBe(1);
  });
});
