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
 * Built-ins pinned ABOVE the user's actions in the `!` picker — the
 * dev-server start/stop pair, present only with `[dev_server]`
 * configured. Pinned because they're the structural "environment" slot
 * (where the SST stage controls conceptually live), not workflow
 * actions. They shell out to `wt dev` so the picker, keybindings, and
 * CLI all share one code path.
 */
export const PINNED_BUILTIN_ACTIONS: readonly ActionDef[] = config.devServer
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
