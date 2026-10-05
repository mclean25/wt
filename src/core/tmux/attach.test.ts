import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { inspectorSocketPath } from "../harness/claude/inject.ts";
import { getHarness } from "../harness/index.ts";
import * as startup from "../harness/codex/startup.ts";
import { attachOrCreate, AttachOperationError, codexPaneOptionArgs, prepareAttachOrCreate, sessionsDir } from "./attach.ts";
import * as tmuxConfig from "./config.ts";
import * as tmuxProcess from "./process.ts";
import { wrapInnerArgs } from "./inner-process.ts";
import { SESSION_SWITCH_EXIT_CODE } from "./naming.ts";

describe("per-harness pane options", () => {
  test("clears the legacy Codex cursor override on attach", () => {
    expect(codexPaneOptionArgs("codex", "task-codex")).toEqual([
      "set-option",
      "-pu",
      "-t",
      "task-codex",
      "cursor-style",
    ]);
    expect(codexPaneOptionArgs("claude", "task")).toEqual([]);
    expect(codexPaneOptionArgs("opencode", "task-opencode")).toEqual([]);
    expect(codexPaneOptionArgs("shell", "task-shell")).toEqual([]);
  });
});

const tempDirs: string[] = [];

describe("Codex attach preparation", () => {
  test("live attachment skips readiness, but a replacement waits without spawning", async () => {
    const harness = getHarness("codex");
    const trust = spyOn(harness, "ensureTrusted").mockReturnValue(Effect.void);
    const inventory = spyOn(tmuxProcess, "probeSessionNames").mockReturnValue(Effect.succeed(new Set(["startup-proof-codex"])));
    const ready = spyOn(startup, "waitForCodexStartup").mockReturnValue(Effect.succeed({ kind: "ready", elapsedMs: 0, features: 0, pages: 1 }));
    const spawn = spyOn(Bun, "spawn");
    try {
      const opts = { slug: "startup-proof", cwd: "/unused", kind: "codex" as const };
      await Effect.runPromise(prepareAttachOrCreate(opts));
      expect(ready).not.toHaveBeenCalled();
      inventory.mockReturnValue(Effect.succeed(null));
      await Effect.runPromise(prepareAttachOrCreate(opts));
      expect(ready).not.toHaveBeenCalled();
      await Effect.runPromise(prepareAttachOrCreate(opts, { freshSlot: true }));
      expect(ready).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
    } finally { trust.mockRestore(); inventory.mockRestore(); ready.mockRestore(); spawn.mockRestore(); }
  });

  test("a failed cold-start readiness check never starts a tmux client", async () => {
    const trust = spyOn(getHarness("codex"), "ensureTrusted").mockReturnValue(Effect.void);
    const inventory = spyOn(tmuxProcess, "probeSessionNames").mockReturnValue(Effect.succeed(new Set()));
    const ready = spyOn(startup, "waitForCodexStartup").mockReturnValue(Effect.fail(new startup.CodexStartupReadinessError({ detail: "readiness timed out" })));
    const spawn = spyOn(Bun, "spawn");
    try {
      const result = await Effect.runPromiseExit(attachOrCreate({ slug: "startup-proof", cwd: "/unused", kind: "codex" }));
      expect(result._tag).toBe("Failure");
      expect(ready).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
    } finally { trust.mockRestore(); inventory.mockRestore(); ready.mockRestore(); spawn.mockRestore(); }
  });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function runWrapped(kind: "shell" | "claude", message: string) {
  const dir = mkdtempSync(join(tmpdir(), "wt-stderr-wrapper-"));
  tempDirs.push(dir);
  const stderrPath = join(dir, "session.err");
  const proc = Bun.spawn(
    wrapInnerArgs({
      kind,
      stderrPath,
      innerArgs: ["bash", "-c", 'printf "%s" "$1" >&2', "_inner", message],
    }),
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr, stderrPath };
}

/** Exercise the real attach flow, replacing every tmux spawn with a harmless
 * short-lived shell. No real server, terminal, or harness is contacted. */
async function runAttachScenario(opts: {
  changed?: boolean;
  inventory: "unknown" | "empty" | "live";
  clientCode?: number;
  clientStderr?: string;
  innerStderr?: string;
  spawnError?: Error;
}) {
  const dir = mkdtempSync(join(tmpdir(), "wt-attach-result-"));
  tempDirs.push(dir);
  const slug = dir.split("/").at(-1)!;
  const name = `${slug}-diff`;
  const stderrPath = join(sessionsDir(), `${name}.err`);
  const calls: string[][] = [];
  const spawn = Bun.spawn;
  const configSpy = spyOn(tmuxConfig, "writeConfig").mockReturnValue({
    path: join(dir, "tmux.conf"),
    changed: opts.changed ?? false,
  });
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
    if (argv[0] !== "tmux") throw new Error(`unexpected attach subprocess: ${argv[0]}`);
    calls.push(argv);
    let code = 0;
    let stdout = "";
    let stderr = "";
    if (argv.includes("list-sessions")) {
      if (opts.inventory === "unknown") {
        code = 1;
        stderr = "error connecting to tmux socket (Permission denied)";
      } else if (opts.inventory === "live") {
        stdout = `${name}\n`;
      }
    } else if (argv.includes("new-session")) {
      if (opts.spawnError) throw opts.spawnError;
      code = opts.clientCode ?? 0;
      stderr = opts.clientStderr ?? "";
      if (opts.innerStderr !== undefined) writeFileSync(stderrPath, opts.innerStderr);
    }
    return spawn([
      "sh", "-c", 'printf "%s" "$1"; printf "%s" "$2" >&2; exit "$3"',
      "_tmux_stub", stdout, stderr, String(code),
    ], { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  }) as typeof Bun.spawn);
  try {
    const exit = await Effect.runPromiseExit(attachOrCreate({
      slug,
      cwd: dir,
      kind: "diff",
      base: "main",
    }));
    return { calls, exit };
  } finally {
    spawnSpy.mockRestore();
    configSpy.mockRestore();
    rmSync(stderrPath, { force: true });
  }
}

describe("tmux attach config refresh", () => {
  test("an unknown inventory preserves the server and uses source-file", async () => {
    const { calls } = await runAttachScenario({ changed: true, inventory: "unknown" });
    expect(calls.some((args) => args.includes("kill-server"))).toBe(false);
    expect(calls.some((args) => args.includes("source-file"))).toBe(true);
  });

  test("a confirmed empty inventory permits an idle server restart", async () => {
    const { calls } = await runAttachScenario({ changed: true, inventory: "empty" });
    expect(calls.some((args) => args.includes("kill-server"))).toBe(true);
    expect(calls.some((args) => args.includes("source-file"))).toBe(false);
  });

  test("live sessions preserve the server and use source-file", async () => {
    const { calls } = await runAttachScenario({ changed: true, inventory: "live" });
    expect(calls.some((args) => args.includes("kill-server"))).toBe(false);
    expect(calls.some((args) => args.includes("source-file"))).toBe(true);
  });
});

describe("tmux attach result", () => {
  test("a failed client reports its error even when the session survives", async () => {
    const { exit } = await runAttachScenario({
      inventory: "live", clientCode: 1,
      clientStderr: "\x1b[31mopen terminal failed: not a terminal\x1b[0m\n",
    });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      kind: "spawn-failed",
      reason: "tmux attach failed (client exit 1): open terminal failed: not a terminal",
    });
  });

  test("a failed client without stderr still reports its status", async () => {
    const { exit } = await runAttachScenario({ inventory: "empty", clientCode: 1 });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      kind: "spawn-failed", reason: "tmux attach failed (client exit 1)",
    });
  });

  test("a successful client with a live session remains a normal detach", async () => {
    const { exit } = await runAttachScenario({ inventory: "live" });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({ kind: "detached" });
  });

  test("private shortcut statuses still request session switches", async () => {
    for (const target of ["shell", "diff", "harness"] as const) {
      const { exit } = await runAttachScenario({
        inventory: "live", clientCode: SESSION_SWITCH_EXIT_CODE[target],
      });
      expect(Exit.isSuccess(exit) && exit.value).toEqual({ kind: "switch", target });
    }
  });

  test("failed post-attach inventory is not reported as an inner program exit", async () => {
    const { exit } = await runAttachScenario({ inventory: "unknown" });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      kind: "spawn-failed",
      reason: "tmux session state could not be checked after attach; the session may still be running",
    });
  });

  test("a zero tmux status cannot turn fatal inner stderr into a successful child exit", async () => {
    const innerStderr = "timed out probing app-server control socket: deadline has elapsed";
    const { exit } = await runAttachScenario({ inventory: "empty", innerStderr });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      kind: "exited", code: null, stderr: innerStderr,
    });
  });

  test("an ended session without stderr still has no known child exit code", async () => {
    const { exit } = await runAttachScenario({ inventory: "empty" });
    expect(Exit.isSuccess(exit) && exit.value).toEqual({
      kind: "exited", code: null, stderr: null,
    });
  });

  test("a spawn exception keeps its original cause and actionable message", async () => {
    const spawnError = new Error("posix_spawn: Resource temporarily unavailable");
    const { exit } = await runAttachScenario({ inventory: "live", spawnError });
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
    expect(error).toBeInstanceOf(AttachOperationError);
    expect((error as AttachOperationError).cause).toBe(spawnError);
    expect((error as AttachOperationError).message).toBe(
      "tmux attach spawn failed: posix_spawn: Resource temporarily unavailable",
    );
  });
});

describe("tmux inner-process browser identity", () => {
  test("every session can invoke this checkout's wt launcher", async () => {
    for (const kind of ["shell", "claude"] as const) {
      const proc = Bun.spawn(
        wrapInnerArgs({
          kind,
          stderrPath: "/dev/null",
          innerArgs: ["sh", "-c", "command -v wt"],
        }),
        { stdout: "pipe", stderr: "ignore" },
      );
      const [exitCode, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toEndWith("/bin/wt");
    }
  });

  test("the harness inherits its worktree's browser session name", async () => {
    const proc = Bun.spawn(
      wrapInnerArgs({
        kind: "claude",
        stderrPath: "/dev/null",
        innerArgs: ["printenv", "BROWSER_CONTROL_SESSION"],
        slug: "eng-1-slug",
      }),
      { stdout: "pipe", stderr: "ignore" },
    );
    const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(stdout.trim()).toBe("wt-eng-1-slug");
  });

  test("the harness knows which worktree's agent it is", async () => {
    // `WT_AGENT` is what makes an outgoing `wt manager send` stamp its
    // own sender — the prefix agents used to have to remember.
    const proc = Bun.spawn(
      wrapInnerArgs({
        kind: "claude",
        stderrPath: "/dev/null",
        innerArgs: ["printenv", "WT_AGENT"],
        slug: "eng-1-slug",
      }),
      { stdout: "pipe", stderr: "ignore" },
    );
    const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(stdout.trim()).toBe("eng-1-slug");
  });

  test("interactive harnesses do not inherit no-color flags", async () => {
    for (const kind of ["claude", "codex", "opencode"] as const) {
      const proc = Bun.spawn(
        wrapInnerArgs({
          kind,
          stderrPath: "/dev/null",
          innerArgs: ["sh", "-c", "printenv NO_COLOR NO_COLOUR"],
          slug: "eng-1-slug",
        }),
        {
          stdout: "pipe",
          stderr: "ignore",
          env: { ...process.env, NO_COLOR: "1", NO_COLOUR: "1" },
        },
      );
      const [, stdout] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
      ]);
      expect(stdout.trim()).toBe("");
    }
  });

  test("a claude session does not inherit the caller's own Claude identity", async () => {
    // wt is usually run BY an agent, so its environment IS a Claude
    // session's. `CLAUDE_CODE_CHILD_SESSION` in particular makes the new
    // session stop writing a transcript — which wt reads for delivery
    // confirmation, status, summaries and the away feed. Started from a
    // shell it looked perfect; started by an agent it lost all of it.
    const proc = Bun.spawn(
      wrapInnerArgs({
        kind: "claude",
        stderrPath: "/dev/null",
        innerArgs: ["sh", "-c", "printenv CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_MESSAGING_SOCKET"],
        slug: "eng-1-slug",
        tmuxName: "eng-1-slug",
      }),
      {
        stdout: "pipe",
        stderr: "ignore",
        env: {
          ...process.env,
          CLAUDE_CODE_CHILD_SESSION: "1",
          CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/some-other-session.sock",
        },
      },
    );
    const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(stdout.trim()).toBe("");
  });

  test("a human's shell in a worktree is not that worktree's agent", async () => {
    // Otherwise `wt manager send` typed by hand at an F10 shell would
    // arrive signed as the agent, and the manager would answer a person
    // as if it were coordinating a worker.
    const proc = Bun.spawn(
      wrapInnerArgs({
        kind: "shell",
        stderrPath: "/dev/null",
        innerArgs: ["printenv", "WT_AGENT"],
        slug: "eng-1-slug",
      }),
      { stdout: "pipe", stderr: "ignore" },
    );
    const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(stdout.trim()).toBe("");
  });

  test("a claude session is launched with its own inspector socket", async () => {
    const proc = Bun.spawn(
      wrapInnerArgs({
        kind: "claude",
        stderrPath: "/dev/null",
        innerArgs: ["printenv", "BUN_INSPECT"],
        slug: "eng-1-slug",
        tmuxName: "eng-1-slug",
      }),
      { stdout: "pipe", stderr: "ignore" },
    );
    const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(stdout.trim()).toBe(`ws+unix://${inspectorSocketPath("eng-1-slug")}`);
  });

  test("no tmux name, no inspector — the session still starts", async () => {
    // Delivery degrades to the terminal transport; a session that
    // cannot be addressed is still better than one that won't boot.
    const proc = Bun.spawn(
      wrapInnerArgs({
        kind: "claude",
        stderrPath: "/dev/null",
        innerArgs: ["printenv", "BUN_INSPECT"],
        slug: "eng-1-slug",
      }),
      { stdout: "pipe", stderr: "ignore" },
    );
    const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(stdout.trim()).toBe("");
  });

  test("no slug, no stamp — nothing inherits a stale identity", async () => {
    const proc = Bun.spawn(
      wrapInnerArgs({
        kind: "shell",
        stderrPath: "/dev/null",
        innerArgs: ["printenv", "BROWSER_CONTROL_SESSION"],
      }),
      { stdout: "pipe", stderr: "ignore" },
    );
    const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(stdout.trim()).toBe("");
  });
});

describe("tmux inner-process stderr routing", () => {
  test("shell prompts remain visible on the tmux PTY", async () => {
    const result = await runWrapped(
      "shell",
      "Do you want to continue? [Y/n]",
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("Do you want to continue? [Y/n]");
    expect(existsSync(result.stderrPath)).toBe(false);
  });

  test("harness startup errors remain captured after the process exits", async () => {
    const result = await runWrapped("claude", "session id already exists");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(readFileSync(result.stderrPath, "utf8")).toBe(
      "session id already exists",
    );
  });
});
