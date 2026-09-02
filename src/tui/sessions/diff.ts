/**
 * Renderer-side orchestrator for the F11 git-diff TUI. Suspends the
 * opentui renderer, hands the terminal off to the configured
 * `[diff].command` running through `core/tmux.attachOrCreate` (kind
 * `"diff"`), and resumes when the tmux client exits.
 *
 * Goes through tmux for one reason: F11 inside the diff TUI must
 * detach back to wt, which requires a layer between the user's
 * keystrokes and the inner program. tmux's wt-private config binds
 * F11 to detach-client. The session is persistent (named
 * `<slug>-diff`) so detach-then-reattach keeps your scroll/expansion
 * state, mirroring the F12 claude-session model.
 */
import type { CliRenderer } from "@opentui/core";
import { Effect } from "effect";

import {
  enterWorktreeSessionEffect,
  type HarnessRoute,
  type WorktreeSessionResult,
} from "./worktree.ts";

export type DiffResult = WorktreeSessionResult;

export type EnterDiffSessionOptions = {
  renderer: CliRenderer;
  slug: string;
  cwd: string;
  /**
   * Resolved diff base ref to splice into `{{base}}` in
   * `[diff].command` (default `revdiff --vim-motion --compact {{base}}`). For
   * trunk-targeted worktrees this is `origin/<config.branch.base>`;
   * for stack-detected or non-trunk-PR worktrees it's the parent
   * branch ref. Forwarded verbatim to `attachOrCreate`.
   */
  base: string;
  harness: HarnessRoute;
};

export function enterDiffSessionEffect(opts: EnterDiffSessionOptions) {
  const { base, ...rest } = opts;
  return enterWorktreeSessionEffect({
    ...rest,
    initial: "diff",
    diffBase: base,
  });
}

export const enterDiffSession = (opts: EnterDiffSessionOptions): Promise<DiffResult> =>
  Effect.runPromise(enterDiffSessionEffect(opts));
