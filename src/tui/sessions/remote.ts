import type { CliRenderer } from "@opentui/core";
import { Data, Effect } from "effect";

import { config } from "../../core/config.ts";
import type { HarnessId } from "../../core/harness/index.ts";
import type { WorktreeTarget } from "../../core/worktree-target.ts";
import { runWorktreeWt } from "../../core/worktree-executor.ts";
import { setWezTermTabTitle } from "../../core/wezterm.ts";
import { NF } from "../icons.ts";
import { handoffTerminal } from "./renderer-handoff.ts";

export class RemoteSessionTargetError extends Data.TaggedError("RemoteSessionTargetError")<{
  readonly message: string;
}> {}

export type EnterRemoteWorktreeSessionOptions = {
  renderer: CliRenderer;
  worktree: WorktreeTarget;
  target: "shell" | "diff" | "harness";
  harnessId: HarnessId;
};

/** Hand the terminal to one selected remote worktree's tmux session. */
export const enterRemoteWorktreeSession = Effect.fn("enterRemoteWorktreeSession")(function* (
  opts: EnterRemoteWorktreeSessionOptions,
) {
    const { renderer, worktree, target, harnessId } = opts;
    if (worktree.location.kind !== "remote") {
      return yield* new RemoteSessionTargetError({
        message: "remote session requires a remote worktree target",
      });
    }
    const remote = worktree.location.endpoint;
    return yield* setWezTermTabTitle(
      `${NF.remote} ${worktree.slug} · ${remote.label}`,
      config.paths.weztermCli,
    ).pipe(
      Effect.andThen(handoffTerminal(
        renderer,
        process.cwd(),
        runWorktreeWt(worktree, ["_session", worktree.slug, target, harnessId], {
          interactive: true,
        }),
      )),
      Effect.ensuring(
        setWezTermTabTitle("wt", config.paths.weztermCli).pipe(Effect.ignore),
      ),
    );
});
