import { runWorktreeWt } from "../core/worktree-executor.ts";
import type { WorktreeTarget } from "../core/worktree-target.ts";

export type WorktreeMutationDeps = {
  setLocalSection: (slug: string, section: string | null) => Promise<void>;
  refreshRemote: () => Promise<unknown>;
};

/** Persistence boundary for mutations whose authority lives with the host. */
export function makeWorktreeMutations(deps: WorktreeMutationDeps) {
  async function setSection(
    target: WorktreeTarget,
    section: string | null,
  ): Promise<void> {
    if (target.location.kind === "local") {
      return deps.setLocalSection(target.slug, section);
    }
    const code = await runWorktreeWt(target, [
      "section",
      "mv",
      target.slug,
      section ?? "-",
    ]);
    if (code !== 0) {
      throw new Error(`remote section move exited ${code}`);
    }
    await deps.refreshRemote();
  }

  return { setSection };
}
