import { join } from "node:path";
import { Data, Effect } from "effect";

import {
  runEffect,
  runStreamingEffect,
  terminateSubprocessEffect,
  type RunOptions,
  type RunResult,
} from "./proc.ts";
import { sendSessionMessageEffect } from "./harness/session-messaging.ts";
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

export function runWorktreeWtEffect(
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
      (proc) => terminateSubprocessEffect(proc),
    );
  }
  return runStreamingEffect(worktreeWtArgv(target, args), {
    cwd: target.location.kind === "local" ? target.path : process.cwd(),
    onLine: opts.onLine,
  }).pipe(
    Effect.mapError((cause) => new WorktreeExecutorError({ operation: "wait", cause })),
  );
}

export const runWorktreeWt = (
  target: WorktreeTarget,
  args: readonly string[],
  opts: WorktreeRunOptions = {},
): Promise<number> => Effect.runPromise(runWorktreeWtEffect(target, args, opts));

export function captureWorktreeWtEffect(
  target: WorktreeTarget,
  args: readonly string[],
  opts: Omit<RunOptions, "cwd"> = {},
): Effect.Effect<RunResult, WorktreeExecutorError> {
  return runEffect(worktreeWtArgv(target, args), {
    ...opts,
    cwd: target.location.kind === "local" ? target.path : process.cwd(),
  }).pipe(
    Effect.mapError((cause) => new WorktreeExecutorError({ operation: "wait", cause })),
  );
}

export const captureWorktreeWt = (
  target: WorktreeTarget,
  args: readonly string[],
  opts: Omit<RunOptions, "cwd"> = {},
): Promise<RunResult> => Effect.runPromise(captureWorktreeWtEffect(target, args, opts));

/** Read supervised dev output from the machine that owns the checkout. */
export function readWorktreeDevLogsEffect(
  target: WorktreeTarget,
): Effect.Effect<string | null, WorktreeExecutorError> {
  if (target.location.kind === "local") {
    return Effect.tryPromise({
      try: () => devServerLogs(target.slug),
      catch: (cause) => new WorktreeExecutorError({ operation: "logs", cause }),
    }).pipe(
      Effect.orElseSucceed(() => null),
      Effect.map((logs) => logs ?? readDevCrashLog(target.slug)),
    );
  }
  return captureWorktreeWtEffect(
    target,
    ["dev", "logs", target.slug],
    { timeoutMs: 8_000 },
  ).pipe(
    Effect.map((result) => result.exitCode === 0
      ? result.stdout
      : result.stderr.trim() || result.stdout.trim() || null),
  );
}

export const readWorktreeDevLogs = (target: WorktreeTarget): Promise<string | null> =>
  Effect.runPromise(readWorktreeDevLogsEffect(target));

export type WorktreeMessageResult =
  | {
      ok: true;
      coldStarted: boolean | null;
      delivered: boolean | null;
    }
  | { ok: false; reason: string };

/** Deliver to the target's primary worktree session at either location. */
export function sendWorktreeMessageEffect(
  target: WorktreeTarget,
  harnessId: HarnessId,
  text: string,
  onLine?: (line: string) => void,
): Effect.Effect<WorktreeMessageResult, WorktreeExecutorError> {
  if (target.location.kind === "local") {
    return sendSessionMessageEffect({
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
  return runWorktreeWtEffect(
    target,
    ["agent", "send", target.slug, "--harness", harnessId, text],
    { onLine },
  ).pipe(
    Effect.map((code): WorktreeMessageResult => code === 0
      ? { ok: true, coldStarted: null, delivered: null }
      : { ok: false, reason: `remote send exited ${code}` }),
  );
}

export const sendWorktreeMessage = (
  target: WorktreeTarget,
  harnessId: HarnessId,
  text: string,
  onLine?: (line: string) => void,
): Promise<WorktreeMessageResult> =>
  Effect.runPromise(sendWorktreeMessageEffect(target, harnessId, text, onLine));
