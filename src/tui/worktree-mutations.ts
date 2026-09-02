import { Effect } from "effect";
import { operationErrors } from "../core/errors.ts";
import type { WorktreeTarget } from "../core/worktree-target.ts";
import { worktreeTargetKey } from "../core/worktree-target.ts";

export type WorktreeMutationDeps = {
  setControllerSection: (key: string, section: string | null) => Promise<void>;
};

const io = operationErrors("worktree mutations");

/** Persistence boundary for controller-owned fleet layout. */
export function makeWorktreeMutations(deps: WorktreeMutationDeps) {
  function setSection(
    target: WorktreeTarget,
    section: string | null,
  ) {
    const key = worktreeTargetKey(target);
    return io.promise(`set section ${key}`, (signal) => {
      if (signal.aborted) return Promise.reject(signal.reason);
      return deps.setControllerSection(key, section);
    });
  }

  const setSectionPromise = (target: WorktreeTarget, section: string | null): Promise<void> =>
    Effect.runPromise(setSection(target, section));

  return { setSectionPromise, setSection };
}
