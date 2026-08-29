import type { WorktreeTarget } from "../core/worktree-target.ts";
import { worktreeTargetKey } from "../core/worktree-target.ts";

export type WorktreeMutationDeps = {
  setControllerSection: (key: string, section: string | null) => Promise<void>;
};

/** Persistence boundary for controller-owned fleet layout. */
export function makeWorktreeMutations(deps: WorktreeMutationDeps) {
  async function setSection(
    target: WorktreeTarget,
    section: string | null,
  ): Promise<void> {
    return deps.setControllerSection(worktreeTargetKey(target), section);
  }

  return { setSection };
}
