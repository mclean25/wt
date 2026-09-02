import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Fiber } from "effect";

import { runPromise, run, runStreaming, terminateSubprocess } from "./proc.ts";

test("terminateSubprocess escalates and joins a child that ignores SIGTERM", async () => {
  const signals: Array<number | NodeJS.Signals | undefined> = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const proc = {
    exitCode: null as number | null,
    exited,
    kill(signal?: number | NodeJS.Signals) {
      signals.push(signal);
      if (signal === "SIGKILL") {
        this.exitCode = 137;
        resolveExit(137);
      }
    },
  };

  await Effect.runPromise(terminateSubprocess(proc, 5));

  expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  expect(proc.exitCode).toBe(137);
});

const waitUntilEffect = (
  predicate: () => boolean,
  description: string,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (yield* Effect.sync(predicate)) return;
      yield* Effect.sleep(10);
    }
    return yield* Effect.die(new Error(`timed out waiting for ${description}`));
  });

const holderEffect = (marker: string) =>
  run(["sh", "-c", 'echo $$ > "$WT_PROC_MARKER"; exec sleep 30'], {
    cwd: "/",
    env: { WT_PROC_MARKER: marker },
  });

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("run interruption", () => {
  test("removes a cancelled queued run before it can spawn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-proc-queued-cancel-"));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const markers = Array.from({ length: 8 }, (_, index) =>
              join(dir, `holder-${index}`),
            );
            const holders = yield* Effect.forEach(
              markers,
              (marker) => Effect.forkScoped(holderEffect(marker)),
              { concurrency: "unbounded" },
            );
            yield* waitUntilEffect(
              () => markers.every(existsSync),
              "all semaphore permits to be occupied",
            );

            const queuedMarker = join(dir, "queued-spawned");
            const queued = yield* Effect.forkChild(
              run(["sh", "-c", 'echo spawned > "$WT_PROC_MARKER"'], {
                cwd: "/",
                env: { WT_PROC_MARKER: queuedMarker },
              }),
            );
            yield* Effect.sleep(30);
            yield* Fiber.interrupt(queued);

            // Freeing a permit is the decisive check. A stale waiter would now
            // acquire it and create the marker after its caller was cancelled.
            yield* Fiber.interrupt(holders[0]!);
            yield* Effect.sleep(100);
            expect(existsSync(queuedMarker)).toBe(false);
          }),
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("kills and joins a running child before releasing its permit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-proc-running-cancel-"));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const markers = Array.from({ length: 8 }, (_, index) =>
              join(dir, `holder-${index}`),
            );
            const holders = yield* Effect.forEach(
              markers,
              (marker) => Effect.forkScoped(holderEffect(marker)),
              { concurrency: "unbounded" },
            );
            yield* waitUntilEffect(
              () => markers.every(existsSync),
              "all semaphore permits to be occupied",
            );
            const interruptedPid = Number(readFileSync(markers[0]!, "utf8"));

            const probeMarker = join(dir, "permit-reused");
            const probe = yield* Effect.forkChild(
              run(["sh", "-c", 'echo reused > "$WT_PROC_MARKER"'], {
                cwd: "/",
                env: { WT_PROC_MARKER: probeMarker },
              }),
            );
            yield* Effect.sleep(30);
            expect(existsSync(probeMarker)).toBe(false);

            // Fiber.interrupt waits for the subprocess finalizer. On return the
            // child is gone and the queued probe can reuse the released permit.
            yield* Fiber.interrupt(holders[0]!);
            expect(processIsAlive(interruptedPid)).toBe(false);
            yield* Fiber.join(probe);
            expect(existsSync(probeMarker)).toBe(true);
          }),
        ),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("escalates to SIGKILL when a child ignores SIGTERM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-proc-ignore-term-"));
    const marker = join(dir, "pid");
    try {
      const fiber = Effect.runFork(
        run(
          [
            "sh",
            "-c",
            'trap "" TERM; echo $$ > "$WT_PROC_MARKER"; while :; do sleep 1; done',
          ],
          { cwd: "/", env: { WT_PROC_MARKER: marker } },
        ),
      );
      await Effect.runPromise(
        waitUntilEffect(() => existsSync(marker), "SIGTERM-resistant child"),
      );
      const pid = Number(readFileSync(marker, "utf8"));
      const started = Date.now();
      await Effect.runPromise(Fiber.interrupt(fiber));
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(processIsAlive(pid)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 5_000);
});

describe("runStreaming killAfterMs", () => {
  test("kills a hung child and reports the timeout on the line stream", async () => {
    const lines: string[] = [];
    const started = Date.now();
    const exit = await Effect.runPromise(runStreaming(["sleep", "30"], {
      onLine: (line) => lines.push(line),
      killAfterMs: 300,
    }));

    // The point is that it returns at all: a destroy_command that hangs
    // must not strand the worktree it was asked to tear down.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(exit).not.toBe(0);
    expect(lines.join("\n")).toContain("timed out");
  });

  test("a child finishing inside the bound is untouched", async () => {
    const lines: string[] = [];
    const exit = await Effect.runPromise(runStreaming(["echo", "done"], {
      onLine: (line) => lines.push(line),
      killAfterMs: 30_000,
    }));
    expect(exit).toBe(0);
    expect(lines).toContain("done");
    expect(lines.join("\n")).not.toContain("timed out");
  });

  // Every caller but the destroy hook omits killAfterMs and must keep
  // the original wait-forever behavior — the timer is opt-in, and an
  // always-armed one would put a ceiling on `pnpm install`.
  // Deliberately `sh`, not a nested `bun`: this file already runs
  // alongside reaper.test.ts, which races real subprocess startup
  // against lsof and gets flaky when the box is loaded.
  test("omitting killAfterMs leaves the child unbounded", async () => {
    const lines: string[] = [];
    const exit = await Effect.runPromise(runStreaming(["sh", "-c", "sleep 0.4; echo slow"], {
      onLine: (line) => lines.push(line),
    }));
    expect(exit).toBe(0);
    expect(lines).toContain("slow");
  });

  test("killAfterMs reaps background descendants holding output pipes", async () => {
    const started = Date.now();
    await Effect.runPromise(
      runStreaming(["sh", "-c", "sleep 30 &"], {
        killAfterMs: 100,
      }),
    );
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 5_000);
});

/**
 * The distinction the destroy reaper reads. A command that buffers its
 * output and gets SIGKILLed at the budget returns ZERO bytes, which
 * parses as a clean empty answer — so "the scan found nothing" and "the
 * scan never finished" are the same value unless the flag separates
 * them. Read as the former, the reaper skipped its reap and a dev
 * server outlived its worktree, holding the port block the next one
 * then failed to bind.
 */
// Every `run()` here passes an explicit cwd. `run` defaults it to
// `config.paths.mainClone`, which in CI is a synthetic path that is
// never created — and `Bun.spawn` fails on a bad cwd before it ever
// reaches the binary, so all three of these failed in under a
// millisecond with exit -1 and no flag set. Note the asymmetry that
// makes it easy to walk into: `runStreaming`, tested directly above,
// leaves cwd undefined and inherits the process's.
describe("run timedOut", () => {
  test("a spawn failure is returned instead of rejecting", async () => {
    const result = await runPromise(["echo", "never-spawned"], {
      cwd: "/definitely/missing/wt-proc-cwd",
    });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr.length).toBeGreaterThan(0);
  });

  test("an external abort is returned instead of rejecting", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runPromise(["sleep", "30"], {
      cwd: "/",
      signal: controller.signal,
    });
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toContain("aborted");
  });

  test("a running external abort preserves captured output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-proc-external-abort-"));
    const marker = join(dir, "started");
    const controller = new AbortController();
    try {
      const resultPromise = runPromise(
        [
          "sh",
          "-c",
          'echo started > "$WT_PROC_MARKER"; echo partial; exec sleep 30',
        ],
        {
          cwd: "/",
          env: { WT_PROC_MARKER: marker },
          signal: controller.signal,
        },
      );
      await Effect.runPromise(
        waitUntilEffect(() => existsSync(marker), "the abort target to spawn"),
      );
      controller.abort();
      const result = await resultPromise;
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("partial");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a running external abort escalates when the process ignores SIGTERM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-proc-external-abort-term-"));
    const marker = join(dir, "started");
    const controller = new AbortController();
    try {
      const resultPromise = runPromise(
        [
          "sh",
          "-c",
          'trap "" TERM; echo started > "$WT_PROC_MARKER"; while :; do sleep 1; done',
        ],
        {
          cwd: "/",
          env: { WT_PROC_MARKER: marker },
          signal: controller.signal,
        },
      );
      await Effect.runPromise(
        waitUntilEffect(() => existsSync(marker), "the SIGTERM-resistant abort target"),
      );
      const started = Date.now();
      controller.abort();
      const result = await resultPromise;
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(result.exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 5_000);

  test("a blown budget is flagged, and its empty stdout is not an answer", async () => {
    // Bare `sleep`, not `sh -c "sleep …; echo …"`: sh FORKS, so
    // SIGKILLing it leaves the child holding the inherited stdout pipe
    // and the drain blocks until the child exits on its own. lsof, the
    // real caller, does not fork — and buffers, so its stdout is empty
    // here for the same reason this one's is.
    const r = await runPromise(["sleep", "5"], { cwd: "/", timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    // The trap in one line: indistinguishable from a completed scan of
    // an empty world, which is what makes the flag load-bearing.
    expect(r.stdout).toBe("");
  });

  test("a timeout reaps background descendants holding captured pipes", async () => {
    const started = Date.now();
    const result = await runPromise(["sh", "-c", "sleep 30 &"], {
      cwd: "/",
      timeoutMs: 100,
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.timedOut).toBe(true);
  }, 5_000);

  test("a command that finishes inside its budget is not flagged", async () => {
    const r = await runPromise(["echo", "hi"], { cwd: "/", timeoutMs: 30_000 });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hi");
  });

  test("no budget at all leaves the flag off", async () => {
    const r = await runPromise(["echo", "hi"], { cwd: "/" });
    expect(r.timedOut).toBe(false);
  });
});
