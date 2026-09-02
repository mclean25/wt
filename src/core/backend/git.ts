import { existsSync } from "node:fs";
import { Data, Effect } from "effect";

import { gitEffect, gitQuietEffect } from "../git.ts";
import { runEffect, type ProcError } from "../proc.ts";
import type {
  BackendCreateInput,
  BackendRemoveInput,
  BackendRemoveResult,
  WorktreeBackend,
} from "./types.ts";

export class GitBackendError extends Data.TaggedError("GitBackendError")<{
  readonly operation: "create" | "remove";
  readonly cause: unknown;
}> {
  override get message(): string {
    return this.cause instanceof Error ? this.cause.message : String(this.cause);
  }
}

export function createGitWorktreeEffect(input: BackendCreateInput): Effect.Effect<void, GitBackendError> {
  const { path, branch, baseRef, onLog } = input;
  const program = baseRef === null
    ? Effect.sync(() => onLog?.(`checkout ${branch}`)).pipe(
        Effect.andThen(gitEffect(["worktree", "add", path, branch])),
      )
    : Effect.sync(() => onLog?.(`new branch ${branch} off ${baseRef}`)).pipe(
        Effect.andThen(gitEffect(["worktree", "add", "--no-track", "-b", branch, path, baseRef])),
      );
  return program.pipe(
    Effect.asVoid,
    Effect.mapError((cause) => new GitBackendError({ operation: "create", cause })),
  );
}

export function removeGitWorktreeEffect(input: BackendRemoveInput): Effect.Effect<BackendRemoveResult, GitBackendError> {
  const { path, force, mainClone } = input;
  const args = ["worktree", "remove", path];
  if (force) args.push("--force");
  return runEffect(["git", ...args], { cwd: mainClone }).pipe(
    Effect.flatMap((r) => {
      if (r.exitCode === 0) return Effect.succeed({ ok: true } as BackendRemoveResult);
      return gitQuietEffect(["worktree", "prune"]).pipe(
        Effect.map(() => existsSync(path)
          ? { ok: false, message: (r.stderr || r.stdout || "failed").trim() }
          : { ok: true }),
      );
    }),
    Effect.mapError((cause: ProcError) => new GitBackendError({ operation: "remove", cause })),
  );
}

/**
 * The original mechanism: a linked git worktree sharing the main
 * clone's object db. A new branch is created with `--no-track` (wt owns
 * upstream wiring as an agnostic post-step); an existing branch is
 * checked out as-is.
 */
export const gitWorktreeBackend: WorktreeBackend = {
  id: "git-worktree",

  create: (input) => Effect.runPromise(createGitWorktreeEffect(input)),

  remove: (input) => Effect.runPromise(removeGitWorktreeEffect(input)),
};
