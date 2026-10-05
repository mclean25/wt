/**
 * Cross-session navigator for one worktree. The renderer is suspended once;
 * tmux's F-key bindings return a private switch result and this loop attaches
 * the requested target without flashing the wt home screen in between.
 */
import type { CliRenderer } from "@opentui/core";
import { Effect } from "effect";

import { getHarness, type HarnessId } from "../../core/harness/index.ts";
import { createLogger } from "../../core/logger.ts";
import {
  type AttachResult,
} from "../../core/tmux.ts";
import {
  AttachOperationError,
  prepareAttachOrCreate,
  type PreparedAttach,
} from "../../core/tmux/attach.ts";
import { killHarnessSession } from "../../core/tmux/admin.ts";
import { handoffTerminal, withTerminalTransition } from "./renderer-handoff.ts";

export type HarnessRoute = {
  harnessId: HarnessId;
  managedName?: string | null;
  resumeSessionId?: string | null;
  claudeDisplayName?: string;
  freshSlot?: boolean;
};

export type WorktreeSessionTarget = "shell" | "diff" | "harness";
export type WorktreeSessionResult = Exclude<AttachResult, { kind: "switch" }>;

export type EnterWorktreeSessionOptions = {
  renderer: CliRenderer;
  slug: string;
  cwd: string;
  initial: WorktreeSessionTarget;
  diffBase: string;
  harness: HarnessRoute;
  /**
   * Whether the F10/F11/F12 tmux bindings may SWITCH between this
   * slug's shell/diff/harness sessions (the worktree navigator).
   * `false` for the special session slots (`,`/`.`/`/`/`m`): an F-key
   * there returns straight to wt instead of minting a stranded
   * `manager-diff`-style sibling for a non-worktree slug.
   */
  switchable?: boolean;
};

export const enterWorktreeSession = Effect.fn("enterWorktreeSession")(function* (opts: EnterWorktreeSessionOptions) {
  const { renderer, slug, cwd, diffBase, harness, switchable = true } = opts;
  // Preparation is asynchronous with the board still usable. Do not queue
  // repeated F12 presses into later, surprising terminal handoffs.
  return yield* withTerminalTransition(renderer, Effect.gen(function* () {
    let harnessPrepared = false;

    const prepareTarget = (target: WorktreeSessionTarget): Effect.Effect<PreparedAttach, AttachOperationError> => Effect.gen(function* () {
      if (target === "shell") {
        return yield* prepareAttachOrCreate({ slug, cwd, kind: "shell" });
      }
      if (target === "diff") {
        return yield* prepareAttachOrCreate({ slug, cwd, kind: "diff", base: diffBase });
      }

      const replace = !harnessPrepared && !!harness.freshSlot && getHarness(harness.harnessId).singleSlot;
      const prepared = yield* prepareAttachOrCreate({
        slug,
        cwd,
        kind: harness.harnessId,
        managedName: harness.managedName,
        resumeSessionId: harness.resumeSessionId,
        claudeDisplayName: harness.claudeDisplayName,
      }, { freshSlot: replace });
      harnessPrepared = true;
      return { attach: Effect.gen(function* () {
        // Preserve the old slot if preparation fails. Replacement happens
        // only once the new launch is ready to take terminal ownership.
        if (replace) {
          createLogger(slug).event.warn(
            `replacing ${getHarness(harness.harnessId).label} slot`,
          );
          yield* killHarnessSession(slug, harness.harnessId);
        }
        return yield* prepared.attach;
      }) };
    });

    // In particular, a slow Codex readiness request must not suspend stdin.
    let prepared = yield* prepareTarget(opts.initial);
    return yield* handoffTerminal(renderer, cwd, Effect.gen(function* () {
      for (;;) {
        const result = yield* prepared.attach;
        if (result.kind !== "switch") return result;
        if (!switchable) return { kind: "detached" } as const;
        prepared = yield* prepareTarget(result.target);
      }
    }));
  })).pipe(Effect.catchTag("TerminalTransitionError", (error) => Effect.succeed({
    kind: "spawn-failed" as const, reason: error.message,
  })));
});
