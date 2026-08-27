import type { CliRenderer } from "@opentui/core";

import { config } from "../../core/config.ts";
import type { HarnessId } from "../../core/harness/index.ts";
import type { WorktreeTarget } from "../../core/worktree-target.ts";
import { runWorktreeWt } from "../../core/worktree-executor.ts";
import { setWezTermTabTitle } from "../../core/wezterm.ts";
import { NF } from "../icons.ts";
import { handoffTerminal } from "./renderer-handoff.ts";

/** Hand the terminal to one selected remote worktree's tmux session. */
export async function enterRemoteWorktreeSession(opts: {
  renderer: CliRenderer;
  worktree: WorktreeTarget;
  target: "shell" | "diff" | "harness";
  harnessId: HarnessId;
}): Promise<number> {
  const { renderer, worktree, target, harnessId } = opts;
  if (worktree.location.kind !== "remote") {
    throw new Error("remote session requires a remote worktree target");
  }
  const remote = worktree.location.endpoint;
  await setWezTermTabTitle(
    `${NF.remote} ${worktree.slug} · ${remote.label}`,
    config.paths.weztermCli,
  );
  try {
    return await handoffTerminal(renderer, process.cwd(), () =>
      runWorktreeWt(worktree, ["_session", worktree.slug, target, harnessId], {
        interactive: true,
      }),
    );
  } finally {
    await setWezTermTabTitle("wt", config.paths.weztermCli);
  }
}
