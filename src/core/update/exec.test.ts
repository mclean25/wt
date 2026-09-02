import { describe, expect, test } from "bun:test";
import { Effect, Exit, Fiber } from "effect";

import { runInEffect } from "./exec.ts";

describe("runInEffect lifecycle", () => {
  test("timeout fails with a typed timeout error and reaps the child", async () => {
    const exit = await Effect.runPromise(Effect.exit(runInEffect(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      { cwd: process.cwd(), timeoutMs: 25 },
    )));
    expect(Exit.isFailure(exit)).toBeTrue();
    if (Exit.isFailure(exit)) {
      const error = exit.cause.toJSON() as { failure?: { operation?: string } };
      expect(JSON.stringify(error)).toContain("timeout");
    }
  });

  test("interruption waits for subprocess finalization", async () => {
    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.fork(runInEffect(
        [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        { cwd: process.cwd() },
      ));
      yield* Effect.yieldNow();
      const interrupted = yield* Fiber.interrupt(fiber);
      expect(Exit.isFailure(interrupted)).toBeTrue();
    }));
  });

  test("timeout reaps descendants that inherit updater output pipes", async () => {
    const started = Date.now();
    const exit = await Effect.runPromise(
      Effect.exit(
        runInEffect(["sh", "-c", "sleep 30 &"], {
          cwd: process.cwd(),
          timeoutMs: 25,
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBeTrue();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
