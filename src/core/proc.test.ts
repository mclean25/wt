import { describe, expect, test } from "bun:test";

import { runStreaming } from "./proc.ts";

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
