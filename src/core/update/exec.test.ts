import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { acquireUpdateGitLockAt, runIn, updateGitLockAt } from "./exec.ts";

describe("runIn lifecycle", () => {
  test("timeout fails with a typed timeout error and reaps the child", async () => {
    const exit = await Effect.runPromise(Effect.exit(runIn(
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
      const fiber = yield* Effect.forkChild(runIn(
        [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        { cwd: process.cwd() },
      ));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      const interrupted = yield* Fiber.await(fiber);
      expect(Exit.isFailure(interrupted)).toBeTrue();
    }));
  });

  test("timeout reaps descendants that inherit updater output pipes", async () => {
    const started = Date.now();
    const exit = await Effect.runPromise(
      Effect.exit(
        runIn(["sh", "-c", "sleep 30 &"], {
          cwd: process.cwd(),
          timeoutMs: 25,
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBeTrue();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

// Every case below points at a throwaway lock directory under $TMPDIR
// rather than the real `~/.cache/wt/update-git.lock` — a live wt
// instance on this machine may be holding that one, and colliding
// with it would corrupt a real update/rollback in progress.
function freshLockParent(): string {
  return mkdtempSync(join(tmpdir(), "wt-update-git-lock-test-"));
}

describe("acquireUpdateGitLockAt", () => {
  test("a contested lock is acquired once the holder releases it", async () => {
    const parent = freshLockParent();
    const lockDir = join(parent, "lock");
    try {
      // Simulate another live holder: a lock dir owned by our own (very
      // much alive) pid, so the first attempt reads as busy, not stale.
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), String(process.pid));

      await Effect.runPromise(Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(acquireUpdateGitLockAt(lockDir));
        yield* Effect.yieldNow;
        // First attempt found it busy and is now sleeping out the 200ms
        // retry spacing. Release the "other holder"'s lock before that
        // sleep elapses.
        rmSync(lockDir, { recursive: true, force: true });
        yield* TestClock.adjust(200);
        const release = yield* Fiber.join(fiber);
        expect(release).not.toBeNull();
        expect(existsSync(lockDir)).toBeTrue();
        release?.();
        expect(existsSync(lockDir)).toBeFalse();
      }).pipe(Effect.provide(TestClock.layer())));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("a lock held by a dead pid is reclaimed on the next attempt", async () => {
    const parent = freshLockParent();
    const lockDir = join(parent, "lock");
    try {
      // A pid this large is never a live process on any of this
      // machine's supported platforms.
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), "999999999");

      await Effect.runPromise(Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(acquireUpdateGitLockAt(lockDir));
        yield* Effect.yieldNow;
        // The first attempt detects the dead pid, reclaims (removes) the
        // stale directory, but still reports busy for that attempt — the
        // successful mkdir happens on the retry.
        yield* TestClock.adjust(200);
        const release = yield* Fiber.join(fiber);
        expect(release).not.toBeNull();
        expect(existsSync(lockDir)).toBeTrue();
      }).pipe(Effect.provide(TestClock.layer())));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("exhausting every retry against a live, non-stale holder gives up quietly", async () => {
    const parent = freshLockParent();
    const lockDir = join(parent, "lock");
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), String(process.pid));

      const release = await Effect.runPromise(Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(acquireUpdateGitLockAt(lockDir));
        // 10 attempts total (1 + 9 retries), spaced 200ms apart.
        yield* TestClock.adjust(2_000);
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())));
      expect(release).toBeNull();
      // The busy directory was never reclaimed — it wasn't stale.
      expect(existsSync(lockDir)).toBeTrue();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("updateGitLockAt", () => {
  test("interruption releases the lock", async () => {
    const parent = freshLockParent();
    const lockDir = join(parent, "lock");
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.scoped(Effect.gen(function* () {
          const locked = yield* updateGitLockAt(lockDir);
          expect(locked).toBeTrue();
          return yield* Effect.never;
        })));
        yield* Effect.yieldNow;
        expect(existsSync(lockDir)).toBeTrue();
        yield* Fiber.interrupt(fiber);
        expect(existsSync(lockDir)).toBeFalse();
      }));
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
