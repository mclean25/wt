import { expect, test } from "bun:test";
import { Deferred, Effect, Exit, Fiber } from "effect";

import { tryAcquireLock, withAsyncFileLock } from "./locks.ts";

test("a synchronous lock handle can be released repeatedly", () => {
  const name = `idempotent-release-${process.pid}-${performance.now()}`;
  const handle = tryAcquireLock(name, "test");
  expect(handle).not.toBeNull();
  handle!.release();
  expect(() => handle!.release()).not.toThrow();

  const reacquired = tryAcquireLock(name, "test");
  expect(reacquired).not.toBeNull();
  reacquired!.release();
});

test("interrupting a lock holder releases the flock before the fiber exits", async () => {
  const name = `effect-interrupt-${process.pid}-${performance.now()}`;
  const acquired = Effect.runSync(Deferred.make<void>());

  const holder = Effect.runFork(
    withAsyncFileLock(
      name,
      Deferred.succeed(acquired, undefined).pipe(
        Effect.andThen(Effect.never),
      ),
      { pollMs: 1, timeoutMs: 100 },
    ),
  );

  await Effect.runPromise(Deferred.await(acquired));
  await Effect.runPromise(Fiber.interrupt(holder));
  const interrupted = await Effect.runPromise(Fiber.await(holder));
  expect(Exit.hasInterrupts(interrupted)).toBe(true);

  const value = await Effect.runPromise(
    withAsyncFileLock(name, Effect.succeed("reacquired"), {
      pollMs: 1,
      timeoutMs: 100,
    }),
  );
  expect(value).toBe("reacquired");
});
