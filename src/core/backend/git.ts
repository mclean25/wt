import { existsSync } from "node:fs";
import { Data, Effect } from "effect";

import { git, gitQuiet } from "../git.ts";
import { run, type ProcError } from "../proc.ts";
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

export function createGitWorktree(input: BackendCreateInput): Effect.Effect<void, GitBackendError> {
  const { path, branch, baseRef, onLog } = input;
  const program = baseRef === null
    ? Effect.sync(() => onLog?.(`checkout ${branch}`)).pipe(
        Effect.andThen(git(["worktree", "add", path, branch])),
      )
    : Effect.sync(() => onLog?.(`new branch ${branch} off ${baseRef}`)).pipe(
        Effect.andThen(git(["worktree", "add", "--no-track", "-b", branch, path, baseRef])),
      );
  return program.pipe(
    Effect.asVoid,
    Effect.mapError((cause) => new GitBackendError({ operation: "create", cause })),
  );
}

export function removeGitWorktree(input: BackendRemoveInput): Effect.Effect<BackendRemoveResult, GitBackendError> {
  const { path, force, mainClone } = input;
  const args = ["worktree", "remove", path];
  if (force) args.push("--force");
  return run(["git", ...args], { cwd: mainClone }).pipe(
    Effect.flatMap((r) => {
      if (r.exitCode === 0) return Effect.succeed({ ok: true } as BackendRemoveResult);
      return gitQuiet(["worktree", "prune"]).pipe(
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

  create: (input) => Effect.runPromise(createGitWorktree(input)),

  remove: (input) => Effect.runPromise(removeGitWorktree(input)),
};
