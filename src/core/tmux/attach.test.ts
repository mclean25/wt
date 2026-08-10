import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { wrapInnerArgs } from "./inner-process.ts";

const tempDirs: string[] = [];

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
    wrapInnerArgs(kind, stderrPath, [
      "bash",
      "-c",
      'printf "%s" "$1" >&2',
      "_inner",
      message,
    ]),
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stderr, stderrPath };
}

describe("tmux inner-process browser identity", () => {
  test("the harness inherits its worktree's browser session name", async () => {
    const proc = Bun.spawn(
      wrapInnerArgs("claude", "/dev/null", ["printenv", "BROWSER_CONTROL_SESSION"], "eng-1-slug"),
      { stdout: "pipe", stderr: "ignore" },
    );
    const [, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    expect(stdout.trim()).toBe("wt-eng-1-slug");
  });

  test("no slug, no stamp — nothing inherits a stale identity", async () => {
    const proc = Bun.spawn(
      wrapInnerArgs("shell", "/dev/null", ["printenv", "BROWSER_CONTROL_SESSION"]),
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
