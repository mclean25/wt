import type { ActionVars } from "./types.ts";

/**
 * Sed-style template renderer. Replaces `{{name}}` with `vars[name]`;
 * unknown vars pass through unchanged so a typo is visible in the
 * launched prompt (and in the action log header) rather than silently
 * collapsing to an empty string.
 *
 * NO shell escaping is applied (audited, accepted): shell actions run
 * the rendered string via `$SHELL -lc`, so a var value with
 * metacharacters (a branch name containing `;`, a doctored
 * `.sst/stage`) would execute. Every substituted value in this
 * single-operator tool is the operator's own — the exposure is
 * checking out a hostile foreign branch and then running a shell
 * action that interpolates `{{branch}}`, which we accept. If wt ever
 * takes multi-user input, quote each value (`shQuote` in tmux.ts)
 * before substitution instead of re-deriving this conclusion.
 */
export function applyVars(template: string, vars: ActionVars): string {
  return template.replaceAll(
    /\{\{(\w+)\}\}/g,
    (m, k) => vars[k] ?? BUILTIN_VARS[k]?.() ?? m,
  );
}

/**
 * Vars that need no subject worktree and are resolved at DISPATCH
 * time, so they're available to row actions and the row-less slot /
 * manager palettes alike. Explicit `vars` win, so a caller can still
 * override one.
 *
 * `today` exists because a long-lived session's sense of the date is
 * the least reliable thing in its context: the model has a training
 * cutoff, and a compaction summary carries no timestamp, so after a
 * compact there is no anchor at all unless something supplies one.
 * That is not cosmetic on a fleet — whether a status assertion is
 * stale, whether a migration timestamp is in the past, and what "ship
 * it Monday" means all turn on it. Weekday included: the arithmetic
 * agents actually do is in days-until, not in dates.
 */
const BUILTIN_VARS: Record<string, () => string> = {
  today: () =>
    new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
};
