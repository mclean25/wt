import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { reconcileEventsDaemonAtStartup } from "./startup.ts";

const liveState = {
  pid: 42,
  port: 8765,
  writerSha: "current",
  startedAt: 1,
  lastEventAt: null,
  lastFetchAt: null,
  eventCount: 0,
  lastError: null,
};

describe("reconcileEventsDaemonAtStartup", () => {
  test("skips cleanly when no launchd agent is installed", async () => {
    const result = await Effect.runPromise(reconcileEventsDaemonAtStartup({
      plist: "/tmp/wt-events-startup-agent-does-not-exist.plist",
    }));
    expect(result).toEqual({ status: "not-installed" });
  });

  test("does nothing when the installed daemon is alive on this build", async () => {
    let ran = false;
    const result = await Effect.runPromise(reconcileEventsDaemonAtStartup({
      plist: "/dev/null",
      state: () => liveState,
      alive: () => true,
      same: (sha) => sha === "current",
      run: () => {
        ran = true;
        return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
      },
    }));
    expect(result).toEqual({ status: "current" });
    expect(ran).toBe(false);
  });

  test("restarts an alive daemon whose build is stale", async () => {
    const calls: string[][] = [];
    const result = await Effect.runPromise(reconcileEventsDaemonAtStartup({
      plist: "/dev/null",
      state: () => ({ ...liveState, writerSha: "old" }),
      alive: () => true,
      same: (sha) => sha === "current",
      run: (argv) => {
        calls.push(argv);
        return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
      },
    }));
    expect(result).toEqual({ status: "restarted" });
    expect(calls).toEqual([[`${process.cwd()}/bin/wt`, "events", "restart"]]);
  });

  test("missing build stamps are stale so pre-stamp daemons self-repair", async () => {
    const result = await Effect.runPromise(reconcileEventsDaemonAtStartup({
      plist: "/dev/null",
      state: () => ({ ...liveState, writerSha: undefined }),
      alive: () => true,
      same: (sha) => Boolean(sha),
      run: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
    }));
    expect(result).toEqual({ status: "restarted" });
  });

  test("restarts an installed daemon that is not running", async () => {
    const result = await Effect.runPromise(reconcileEventsDaemonAtStartup({
      plist: "/dev/null",
      state: () => liveState,
      alive: () => false,
      same: () => true,
      run: () => Effect.succeed({ stdout: "", stderr: "", exitCode: 0 }),
    }));
    expect(result).toEqual({ status: "restarted" });
  });

  test("reports restart failure without blocking startup", async () => {
    const result = await Effect.runPromise(reconcileEventsDaemonAtStartup({
      plist: "/dev/null",
      state: () => null,
      run: () => Effect.succeed({ stdout: "", stderr: "launchctl load failed\n", exitCode: 1 }),
    }));
    expect(result).toEqual({ status: "failed", detail: "launchctl load failed" });
  });
});
