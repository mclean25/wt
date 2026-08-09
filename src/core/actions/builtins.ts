import { join } from "node:path";

import { type ActionDef, config } from "../config.ts";

/** Single-quote `s` for `$SHELL -lc` so config text can't break out of the argument. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// The wt executable, resolved relative to this module (src/core/actions
// → repo root → bin/wt) — the same trick `spawnBackgroundRemove` uses.
// Shell actions run via `$SHELL -lc`, where the user's `wt` alias
// (defined in interactive rc files) does not exist.
const WT_BIN = join(import.meta.dir, "..", "..", "..", "bin", "wt");

/**
 * Built-in actions appended after `config.actions` in the picker. They
 * behave exactly like user-configured actions — the `actionRegistry`
 * doesn't distinguish, the only difference is they're defined in code
 * rather than read from `config.toml`. Adding one: declare it here, no
 * other wiring needed; the picker places these between user actions and
 * the trailing "Custom prompt…" sentinel.
 *
 * Kept (nearly) empty on purpose: hardcoded candidates so far have been
 * project-specific (e.g. the old `pnpm sst remove` "Remove local"), which
 * belongs in the user's `config.toml`, not baked into the OSS app — the
 * same "no client-app defaults in code" rule the config loader enforces.
 * The review-bot re-run entry below respects that rule: it only exists
 * when the user configured `[review_bot] rerun_command`, and the config
 * is what parameterizes it.
 */
export const BUILTIN_ACTIONS: readonly ActionDef[] = config.reviewBot.rerunCommand
  ? [
      {
        kind: "shell",
        id: "review-bot-rerun",
        name: `Re-run ${config.reviewBot.name} review`,
        shell: `gh pr comment {{pr}} --body ${shellQuote(config.reviewBot.rerunCommand)}`,
        affects: ["github"],
        requires: ["pr"],
        argPrompt: null,
        labelExtract: null,
      },
    ]
  : [];

/**
 * The two agent-delegation builtins, pinned at the very top of the `!`
 * picker. Both inject into the row's primary harness session (cold-
 * starting it when needed) — the same delivery the automations engine
 * uses — because their whole point is moving work the human would
 * otherwise do onto the row's own agent:
 *
 *   `! u` — the agent reassesses and re-asserts `wt status` (the manual
 *           backstop for a status that drifted or was never asserted).
 *   `! g` — the agent picks the work back up and CONTINUES from
 *           whatever the current status implies (build / test / address
 *           review / verify-and-ready).
 *
 * Universal (not gated on any config section): they parameterize
 * nothing project-specific — the status vocabulary and its rules ship
 * with `wt status` itself, which every harness session learns from the
 * bundled skills/instructions contract.
 */
const AGENT_BUILTIN_ACTIONS: readonly ActionDef[] = [
  {
    kind: "claude",
    id: "agent-status-sync",
    name: "Agent: update work status",
    prompt: [
      "Reassess this worktree's work status right now and assert it with `wt status`.",
      "Check the actual state — tree, recent commits, PR/CI, your own conversation",
      "context — rather than trusting the recorded status. Then run the matching",
      "`wt status <state>` (bare `wt status` prints the vocabulary and rules; use",
      "--risk and -m per those rules). If the recorded status is already accurate,",
      "re-assert it anyway so the timestamp reflects this check. Reply with one",
      "line: the state you asserted and why.",
    ].join(" "),
    target: "session",
    affects: [],
    requires: [],
    argPrompt: null,
    labelExtract: null,
    key: "u",
    group: "agent",
  },
  {
    kind: "claude",
    id: "agent-continue",
    name: "Agent: continue work",
    prompt: [
      "Pick this worktree back up and continue from its current work status.",
      "First recheck the actual state (tree, PR/CI, review findings) rather than",
      "trusting the recorded status blindly. Then do the next real unit of work:",
      "unfinished implementation → keep building; review findings pending →",
      "address them; needs-testing → run the manual testing yourself; everything",
      "genuinely done → verify and assert `wt status ready` with an honest --risk.",
      "Assert status transitions as you go, and escalate with",
      '`wt status needs-human -m "..."` only if truly blocked on the human.',
    ].join(" "),
    target: "session",
    affects: [],
    requires: [],
    argPrompt: null,
    labelExtract: null,
    key: "g",
    group: "agent",
  },
];

/**
 * Built-ins pinned ABOVE the user's actions in the `!` picker: the
 * agent-delegation pair (always), then the dev-server start/stop pair
 * when `[dev_server]` is configured. Pinned because they're structural
 * slots — delegate-to-agent and environment — not workflow actions.
 * The dev pair shells out to `wt dev` so the picker, keybindings, and
 * CLI all share one code path.
 */
const DEV_BUILTIN_ACTIONS: readonly ActionDef[] = config.devServer
  ? [
      {
        kind: "shell",
        id: "dev-server-start",
        name: "Start/restart dev server",
        shell: `${shellQuote(WT_BIN)} dev start {{slug}}`,
        affects: ["dev"],
        requires: [],
        argPrompt: null,
        labelExtract: null,
        key: "d",
        group: "dev server",
      },
      {
        kind: "shell",
        id: "dev-server-stop",
        name: "Stop dev server",
        shell: `${shellQuote(WT_BIN)} dev stop {{slug}}`,
        affects: ["dev"],
        requires: [],
        argPrompt: null,
        labelExtract: null,
        // Lowercase only: assignActionKeys folds case and the picker's
        // quick-pick matcher recognizes /^[a-z]$/ exclusively, so an
        // uppercase key silently dies. d = start, s = stop.
        key: "s",
        group: "dev server",
      },
    ]
  : [];

/** The pinned set the picker leads with: agent pair, then dev pair. */
export const PINNED_BUILTIN_ACTIONS: readonly ActionDef[] = [
  ...AGENT_BUILTIN_ACTIONS,
  ...DEV_BUILTIN_ACTIONS,
];

/** Every code-defined action, for id-resolution sites (dispatch, automations). */
export const ALL_BUILTIN_ACTIONS: readonly ActionDef[] = [
  ...PINNED_BUILTIN_ACTIONS,
  ...BUILTIN_ACTIONS,
];

/**
 * Window during which a finished run keeps auto-focusing the bottom
 * pane in "follow selected row" mode. Exported so `useActionVisible`
 * reuses the same constant — it drives both the registry-side
 * `isVisible` predicate and the client-side timer, and they have to
 * stay in lockstep. After this window the run drops out of auto-
 * focus, but stays in memory (`MAX_RETAINED_RUNS`) so the Outputs
 * picker can still surface it as a "done"/"failed"/"killed" entry.
 */
export const RECENT_WINDOW_MS = 10 * 1000;
/**
 * How many completed runs to keep in the in-memory registry before
 * evicting the oldest. Drives the Outputs picker — bigger means more
 * historical runs visible without restart, but more memory held. The
 * boot reconciler also uses this cap when rehydrating from disk.
 */
export const MAX_RETAINED_RUNS = 20;
/** actionId stamped on runs launched via the picker's "Custom prompt…" entry. */
export const CUSTOM_ACTION_ID = "__custom__";
