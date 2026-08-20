import { describe, expect, test } from "bun:test";

import { run, runStreaming } from "./proc.ts";

describe("runStreaming killAfterMs", () => {
  test("kills a hung child and reports the timeout on the line stream", async () => {
    const lines: string[] = [];
    const started = Date.now();
    const exit = await runStreaming(["sleep", "30"], {
      onLine: (line) => lines.push(line),
      killAfterMs: 300,
    });

    // The point is that it returns at all: a destroy_command that hangs
    // must not strand the worktree it was asked to tear down.
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(exit).not.toBe(0);
    expect(lines.join("\n")).toContain("timed out");
  });

  test("a child finishing inside the bound is untouched", async () => {
    const lines: string[] = [];
    const exit = await runStreaming(["echo", "done"], {
      onLine: (line) => lines.push(line),
      killAfterMs: 30_000,
    });
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
    const exit = await runStreaming(["sh", "-c", "sleep 0.4; echo slow"], {
      onLine: (line) => lines.push(line),
    });
    expect(exit).toBe(0);
    expect(lines).toContain("slow");
  });
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
describe("run timedOut", () => {
  test("a blown budget is flagged, and its empty stdout is not an answer", async () => {
    // Bare `sleep`, not `sh -c "sleep …; echo …"`: sh FORKS, so
    // SIGKILLing it leaves the child holding the inherited stdout pipe
    // and the drain blocks until the child exits on its own. lsof, the
    // real caller, does not fork — and buffers, so its stdout is empty
    // here for the same reason this one's is.
    const r = await run(["sleep", "5"], { timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
    // The trap in one line: indistinguishable from a completed scan of
    // an empty world, which is what makes the flag load-bearing.
    expect(r.stdout).toBe("");
  });

  test("a command that finishes inside its budget is not flagged", async () => {
    const r = await run(["echo", "hi"], { timeoutMs: 30_000 });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("hi");
  });

  test("no budget at all leaves the flag off", async () => {
    const r = await run(["echo", "hi"]);
    expect(r.timedOut).toBe(false);
  });
});
