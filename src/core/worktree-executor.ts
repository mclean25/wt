import { join } from "node:path";

import { run, runStreaming, type RunOptions, type RunResult } from "./proc.ts";
import { sendSessionMessage } from "./harness/session-messaging.ts";
import type { HarnessId } from "./harness/index.ts";
import { devServerLogs, readDevCrashLog } from "./dev-server.ts";
import {
  interactiveRemoteSshArgv,
  remoteWtSshArgv,
} from "./remote.ts";
import type { WorktreeTarget } from "./worktree-target.ts";

const WT_BIN = join(import.meta.dir, "..", "..", "bin", "wt");

export type WorktreeRunOptions = {
  interactive?: boolean;
  onLine?: (line: string) => void;
};

/**
 * The sole direct-versus-SSH transport decision for ordinary wt commands.
 * Callers describe an operation against a worktree target; location becomes
 * argv only here.
 */
export function worktreeWtArgv(
  target: WorktreeTarget,
  args: readonly string[],
  interactive = false,
): string[] {
  if (target.location.kind === "local") return [WT_BIN, ...args];
  return interactive
    ? interactiveRemoteSshArgv(target.location.endpoint, args)
    : remoteWtSshArgv(target.location.endpoint, args);
}

export async function runWorktreeWt(
  target: WorktreeTarget,
  args: readonly string[],
  opts: WorktreeRunOptions = {},
): Promise<number> {
  if (opts.interactive) {
    const proc = Bun.spawn(worktreeWtArgv(target, args, true), {
      cwd: target.location.kind === "local" ? target.path : process.cwd(),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return proc.exited;
  }
  return runStreaming(worktreeWtArgv(target, args), {
    cwd: target.location.kind === "local" ? target.path : process.cwd(),
    onLine: opts.onLine,
  });
}

export function captureWorktreeWt(
  target: WorktreeTarget,
  args: readonly string[],
  opts: Omit<RunOptions, "cwd"> = {},
): Promise<RunResult> {
  return run(worktreeWtArgv(target, args), {
    ...opts,
    cwd: target.location.kind === "local" ? target.path : process.cwd(),
  });
}

/** Read supervised dev output from the machine that owns the checkout. */
export async function readWorktreeDevLogs(
  target: WorktreeTarget,
): Promise<string | null> {
  if (target.location.kind === "local") {
    return (
      (await devServerLogs(target.slug).catch(() => null)) ??
      readDevCrashLog(target.slug)
    );
  }
  const result = await captureWorktreeWt(
    target,
    ["dev", "logs", target.slug],
    { timeoutMs: 8_000 },
  );
  return result.exitCode === 0
    ? result.stdout
    : result.stderr.trim() || result.stdout.trim() || null;
}

export type WorktreeMessageResult =
  | {
      ok: true;
      coldStarted: boolean | null;
      delivered: boolean | null;
    }
  | { ok: false; reason: string };

/** Deliver to the target's primary worktree session at either location. */
export async function sendWorktreeMessage(
  target: WorktreeTarget,
  harnessId: HarnessId,
  text: string,
  onLine?: (line: string) => void,
): Promise<WorktreeMessageResult> {
  if (target.location.kind === "local") {
    const result = await sendSessionMessage({
      slug: target.slug,
      cwd: target.path,
      harnessId,
      managedName: null,
      text,
    });
    return result.ok
      ? {
          ok: true,
          coldStarted: result.coldStarted,
          delivered: result.delivered,
        }
      : result;
  }
  const code = await runWorktreeWt(
    target,
    ["agent", "send", target.slug, "--harness", harnessId, text],
    { onLine },
  );
  return code === 0
    ? { ok: true, coldStarted: null, delivered: null }
    : { ok: false, reason: `remote send exited ${code}` };
}
