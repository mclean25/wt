import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { eventsConfigEnvironment } from "./agent.ts";
import { EVENTS_DIR } from "./store.ts";

import { reconcileEventsDaemonAtStartup } from "./startup.ts";

const environment = eventsConfigEnvironment();
const ownedAgent = {
  EnvironmentVariables: environment,
  StandardOutPath: `${EVENTS_DIR}/daemon.out.log`,
  StandardErrorPath: `${EVENTS_DIR}/daemon.err.log`,
};
const agent = () => Effect.succeed(ownedAgent);

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
  test("ignores another repository's installed daemon when events are disabled", async () => {
    const result = await Effect.runPromise(reconcileEventsDaemonAtStartup({
      enabled: false,
      plist: "/dev/null",
      state: () => { throw new Error("must not inspect the daemon"); },
      run: () => { throw new Error("must not restart the daemon"); },
    }));
    expect(result).toEqual({ status: "disabled" });
  });

  test("skips cleanly when no launchd agent is installed", async () => {
    const result = await Effect.runPromise(reconcileEventsDaemonAtStartup({
      enabled: true,
      agent,
      environment,
      plist: "/tmp/wt-events-startup-agent-does-not-exist.plist",
    }));
    expect(result).toEqual({ status: "not-installed" });
  });

  test("does nothing when the installed daemon is alive on this build", async () => {
    let ran = false;
    const result = await Effect.runPromise(reconcileEventsDaemonAtStartup({
      enabled: true,
      agent,
      environment,
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
      enabled: true,
      agent,
      environment,
      plist: "/dev/null",
      state: () => ({ ...liveState, writerSha: "old" }),
      alive: () => true,
      same: (sha) => sha === "current",
      run: (argv, opts) => {
        expect(opts.cwd).toBe(process.cwd());
        expect(opts.env).toEqual(environment);
        calls.push(argv);
        return Effect.succeed({ stdout: "", stderr: "", exitCode: 0 });
      },
    }));
    expect(result).toEqual({ status: "restarted" });
    expect(calls).toEqual([[`${process.cwd()}/bin/wt`, "events", "restart"]]);
  });

  test("missing build stamps are stale so pre-stamp daemons self-repair", async () => {
    const result = await Effect.runPromise(reconcileEventsDaemonAtStartup({
      enabled: true,
      agent,
      environment,
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
      enabled: true,
      agent,
      environment,
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
      enabled: true,
      agent,
      environment,
      plist: "/dev/null",
      state: () => null,
      run: () => Effect.succeed({ stdout: "", stderr: "paths.main_clone is required\npaths.worktree_root is required\nSee src/core/config.ts for the full schema.\n", exitCode: 1 }),
    }));
    expect(result).toEqual({ status: "failed", detail: "paths.main_clone is required\npaths.worktree_root is required\nSee src/core/config.ts for the full schema." });
  });
});

for (const foreign of [
  { ...ownedAgent, EnvironmentVariables: { ...environment, WT_REPO_CONFIG: "/another/repo/.wt.toml" } },
  { ...ownedAgent, EnvironmentVariables: { ...environment, WT_CONFIG: "/another/config.toml" } },
  { ...ownedAgent, StandardOutPath: "/another/cache/events/daemon.out.log" },
  {},
]) {
  test("foreign or unknown ownership skips even liveness inspection", async () => {
    expect(await Effect.runPromise(reconcileEventsDaemonAtStartup({
      enabled: true,
      plist: "/dev/null",
      agent: () => Effect.succeed(foreign),
      environment,
      state: () => { throw new Error("must not inspect foreign state"); },
      run: () => { throw new Error("must not restart foreign agent"); },
    }))).toEqual({ status: "not-owned" });
  });
}

test("unreadable agent reports the cause without restarting", async () => {
  // Exercise the real plist reader against an invalid file; never launchctl.
  const result = await Effect.runPromise(reconcileEventsDaemonAtStartup({
    enabled: true,
    plist: "/dev/null",
    run: () => { throw new Error("must not restart unreadable agent"); },
  }));
  expect(result.status).toBe("failed");
  if (result.status === "failed") expect(result.detail).toContain("/dev/null");
});


test("stdout-only failures retain details, and silent failures retain exit status", async () => {
  for (const [stdout, detail] of [["configuration failure\nmissing paths.main_clone\n", "configuration failure\nmissing paths.main_clone"], ["", "exit 7"]] as const) {
    expect(await Effect.runPromise(reconcileEventsDaemonAtStartup({
      enabled: true, plist: "/dev/null", agent, environment,
      state: () => null,
      run: () => Effect.succeed({ stdout, stderr: "", exitCode: 7 }),
    }))).toEqual({ status: "failed", detail });
  }
});
