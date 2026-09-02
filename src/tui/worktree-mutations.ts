import type { WorktreeTarget } from "../core/worktree-target.ts";
import { worktreeTargetKey } from "../core/worktree-target.ts";

export type WorktreeMutationDeps = {
  setControllerSection: (key: string, section: string | null) => Promise<void>;
};

export class WorktreeMutationError extends Data.TaggedError("WorktreeMutationError")<{
  readonly key: string;
  readonly cause: unknown;
}> {}

/** Persistence boundary for controller-owned fleet layout. */
export function makeWorktreeMutations(deps: WorktreeMutationDeps) {
  function setSectionEffect(
    target: WorktreeTarget,
    section: string | null,
  ) {
    const key = worktreeTargetKey(target);
    return Effect.tryPromise({
      try: (signal) => {
        if (signal.aborted) return Promise.reject(signal.reason);
        return deps.setControllerSection(key, section);
      },
      catch: (cause) => new WorktreeMutationError({ key, cause }),
    });
  }

  const setSection = (target: WorktreeTarget, section: string | null): Promise<void> =>
    Effect.runPromise(setSectionEffect(target, section));

  return { setSection, setSectionEffect };
}
import { Data, Effect } from "effect";
