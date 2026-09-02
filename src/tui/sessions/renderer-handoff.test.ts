import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import { cwdOsc7, handoffTerminalEffect } from "./renderer-handoff.ts";

describe("cwdOsc7", () => {
  test("reports the pane cwd as an encoded file URL", () => {
    expect(cwdOsc7("/tmp/a worktree#1", "devbox.local")).toBe(
      "\x1b]7;file://devbox.local/tmp/a%20worktree%231\x1b\\",
    );
  });
});

test("failure resumes the renderer and restores terminal ownership", async () => {
  const calls: string[] = [];
  const renderer = {
    suspend: () => calls.push("suspend"),
    resume: () => calls.push("resume"),
  };
  const originalWrite = process.stdout.write;
  const originalKill = process.kill;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.kill = (() => true) as typeof process.kill;
  try {
    const exit = await Effect.runPromiseExit(handoffTerminalEffect(
      renderer as never,
      "/tmp",
      Effect.fail("handoff failed"),
    ));
    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls).toEqual(["suspend", "resume"]);
  } finally {
    process.stdout.write = originalWrite;
    process.kill = originalKill;
  }
});
