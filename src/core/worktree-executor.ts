import { join } from "node:path";
import { Data, Effect } from "effect";

import {
  run,
  runStreaming,
  terminateSubprocess,
  type RunOptions,
  type RunResult,
} from "./proc.ts";
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

export class WorktreeExecutorError extends Data.TaggedError("WorktreeExecutorError")<{
  readonly operation: "spawn" | "wait" | "logs" | "message";
  readonly cause: unknown;
}> {}

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

export function runWorktreeWt(
  target: WorktreeTarget,
  args: readonly string[],
  opts: WorktreeRunOptions = {},
): Effect.Effect<number, WorktreeExecutorError> {
  if (opts.interactive) {
    return Effect.acquireUseRelease(
      Effect.try({
        try: () => Bun.spawn(worktreeWtArgv(target, args, true), {
          cwd: target.location.kind === "local" ? target.path : process.cwd(),
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }),
        catch: (cause) => new WorktreeExecutorError({ operation: "spawn", cause }),
      }),
      (proc) => Effect.tryPromise({
        try: () => proc.exited,
        catch: (cause) => new WorktreeExecutorError({ operation: "wait", cause }),
      }),
      (proc) => terminateSubprocess(proc),
    );
  }
  return runStreaming(worktreeWtArgv(target, args), {
    cwd: target.location.kind === "local" ? target.path : process.cwd(),
    onLine: opts.onLine,
  }).pipe(
    Effect.mapError((cause) => new WorktreeExecutorError({ operation: "wait", cause })),
  );
}

export const runWorktreeWtPromise = (
  target: WorktreeTarget,
  args: readonly string[],
  opts: WorktreeRunOptions = {},
): Promise<number> => Effect.runPromise(runWorktreeWt(target, args, opts));

export function captureWorktreeWt(
  target: WorktreeTarget,
  args: readonly string[],
  opts: Omit<RunOptions, "cwd"> = {},
): Effect.Effect<RunResult, WorktreeExecutorError> {
  return run(worktreeWtArgv(target, args), {
    ...opts,
    cwd: target.location.kind === "local" ? target.path : process.cwd(),
  }).pipe(
    Effect.mapError((cause) => new WorktreeExecutorError({ operation: "wait", cause })),
  );
}

export const captureWorktreeWtPromise = (
  target: WorktreeTarget,
  args: readonly string[],
  opts: Omit<RunOptions, "cwd"> = {},
): Promise<RunResult> => Effect.runPromise(captureWorktreeWt(target, args, opts));

/** Read supervised dev output from the machine that owns the checkout. */
export function readWorktreeDevLogs(
  target: WorktreeTarget,
): Effect.Effect<string | null, WorktreeExecutorError> {
  if (target.location.kind === "local") {
    return devServerLogs(target.slug).pipe(
      Effect.orElseSucceed((): string | null => null),
      Effect.map((logs) => logs ?? readDevCrashLog(target.slug)),
    );
  }
  return captureWorktreeWt(
    target,
    ["dev", "logs", target.slug],
    { timeoutMs: 8_000 },
  ).pipe(
    Effect.map((result) => result.exitCode === 0
      ? result.stdout
      : result.stderr.trim() || result.stdout.trim() || null),
  );
}

export const readWorktreeDevLogsPromise = (target: WorktreeTarget): Promise<string | null> =>
  Effect.runPromise(readWorktreeDevLogs(target));

export type WorktreeMessageResult =
  | {
      ok: true;
      coldStarted: boolean | null;
      delivered: boolean | null;
    }
  | { ok: false; reason: string };

/** Deliver to the target's primary worktree session at either location. */
export function sendWorktreeMessage(
  target: WorktreeTarget,
  harnessId: HarnessId,
  text: string,
  onLine?: (line: string) => void,
): Effect.Effect<WorktreeMessageResult, WorktreeExecutorError> {
  if (target.location.kind === "local") {
    return sendSessionMessage({
      slug: target.slug,
      cwd: target.path,
      harnessId,
      managedName: null,
      text,
    }).pipe(
      Effect.mapError((cause) => new WorktreeExecutorError({ operation: "message", cause })),
      Effect.map((result) => result.ok
      ? {
          ok: true,
          coldStarted: result.coldStarted,
          delivered: result.delivered,
        }
      : result),
    );
  }
  return runWorktreeWt(
    target,
    ["agent", "send", target.slug, "--harness", harnessId, text],
    { onLine },
  ).pipe(
    Effect.map((code): WorktreeMessageResult => code === 0
      ? { ok: true, coldStarted: null, delivered: null }
      : { ok: false, reason: `remote send exited ${code}` }),
  );
}

export const sendWorktreeMessagePromise = (
  target: WorktreeTarget,
  harnessId: HarnessId,
  text: string,
  onLine?: (line: string) => void,
): Promise<WorktreeMessageResult> =>
  Effect.runPromise(sendWorktreeMessage(target, harnessId, text, onLine));
