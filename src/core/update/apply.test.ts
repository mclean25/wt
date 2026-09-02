import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";

import { applyWtUpdate, type ApplyDependencies } from "./apply.ts";

function dependencies(overrides: Partial<ApplyDependencies> = {}): ApplyDependencies {
  return {
    gitOk: () => Effect.succeed("before-sha"),
    runIn: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
    lock: Effect.succeed(true),
    now: Effect.succeed(1_800_000_000_000),
    resetVersionCache: () => {},
    markApplying: () => {},
    clearApplying: () => {},
    recordRollback: () => {},
    ...overrides,
  };
}

describe("applyWtUpdate lifecycle", () => {
  test("interruption joins the active command and releases the git lock", async () => {
    let releases = 0;
    let commands = 0;
    const deps = dependencies({
      lock: Effect.acquireRelease(
        Effect.succeed(true),
        () => Effect.sync(() => { releases++; }),
      ),
      runIn: () => {
        commands++;
        return Effect.never;
      },
    });

    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(applyWtUpdate("target-sha", deps));
      yield* Effect.yieldNow;
      expect(commands).toBe(1);
      yield* Fiber.interrupt(fiber);
      expect(releases).toBe(1);
    }));
  });

  test("a busy lock performs no git mutation", async () => {
    let commands = 0;
    const result = await Effect.runPromise(applyWtUpdate("target-sha", dependencies({
      lock: Effect.succeed(false),
      runIn: () => {
        commands++;
        return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
      },
    })));
    expect(result).toMatchObject({ ok: false, stage: "lock", reverted: false });
    expect(commands).toBe(0);
  });

  test("a failed smoke probe reverts before releasing the lock", async () => {
    const calls: string[] = [];
    let releases = 0;
    const deps = dependencies({
      lock: Effect.acquireRelease(
        Effect.succeed(true),
        () => Effect.sync(() => { calls.push("release"); releases++; }),
      ),
      gitOk: (args) => Effect.succeed(args[0] === "diff" ? null : "before-sha"),
      runIn: (argv) => {
        calls.push(argv.join(" "));
        if (argv.includes("src/main.ts")) {
          return Effect.succeed({ stdout: "", stderr: "probe failed", exitCode: 1 });
        }
        return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
      },
    });
    const result = await Effect.runPromise(applyWtUpdate("target-sha", deps));
    expect(result).toMatchObject({ ok: false, stage: "smoke", reverted: true });
    expect(calls.some((call) => call.includes("git reset --hard --quiet before-sha"))).toBeTrue();
    expect(calls.at(-1)).toBe("release");
    expect(releases).toBe(1);
  });
});
