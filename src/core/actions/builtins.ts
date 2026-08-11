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
 * picker. Both send to the row's primary harness session (cold-
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

/**
 * Shared closing line for every fleet-scoped manager command: the
 * report-back contract. `wt manager report` is the channel that lands
 * in wt's attention feed, so the human sees the outcome without
 * attaching to the manager session (docs/manager.md#reporting-back).
 */
const REPORT_BACK =
  "When finished, run `wt manager report [--ok|--warn|--err] \"...\"` with a" +
  " one-or-two-line result — that line lands in wt's attention feed, so keep" +
  " it terse and information-dense. Reply in your own conversation only with" +
  " what the report doesn't carry.";

/**
 * The manager command palette (`M`) builtins. All target the singleton
 * manager session; `fleet: true` entries address the whole fleet and
 * are injected WITHOUT row context or the `[re: <slug>]` prefix.
 * `manager-ask-row` is the one row-scoped entry — it rides the normal
 * `[[actions]] target="manager"` path against the selected row.
 *
 * Universal builtins (no config gate): the vocabulary they lean on
 * (`wt status --all --json`, `wt claude send`, `wt manager report`) is
 * wt's own CLI surface, which every harness can drive.
 */
export const MANAGER_BUILTIN_ACTIONS: readonly ActionDef[] = [
  {
    kind: "claude",
    id: "manager-digest",
    name: "Digest: what needs me",
    prompt: [
      "Produce a fleet digest for the human. Read `wt status --all --json` and",
      "check PR/CI state (`gh`) where it matters. Reply with at most five",
      "bullets covering: what needs the human RIGHT NOW (and exactly what for),",
      "what is mergeable and in what order, and what looks stalled or",
      "abandoned. No restating the board — only what's actionable or surprising.",
      REPORT_BACK,
    ].join(" "),
    target: "manager",
    affects: [],
    requires: [],
    argPrompt: null,
    labelExtract: null,
    key: "d",
    group: "manager",
    fleet: true,
  },
  {
    kind: "claude",
    id: "manager-triage",
    name: "Triage needs-human rows",
    prompt: [
      "Triage every worktree currently asserting needs-human (`wt status --all",
      "--json`). For each: first try to unblock it yourself — gh operations,",
      "answering the worker's question from fleet knowledge, nudging its session",
      "with `wt claude send <slug> \"...\"` — and re-assert its status on the",
      "worker's behalf when you do. Distill whatever genuinely remains into one",
      "short ask per row.",
      REPORT_BACK,
    ].join(" "),
    target: "manager",
    affects: [],
    requires: [],
    argPrompt: null,
    labelExtract: null,
    key: "t",
    group: "manager",
    fleet: true,
  },
  {
    kind: "claude",
    id: "manager-merge-order",
    name: "Plan merge order",
    prompt: [
      "Plan the merge order. Look at the ready rows and open PRs (`wt status",
      "--all --json`, `gh pr list`), stack relationships, and overlapping files",
      "across branches. Propose a concrete merge order with the conflict risks,",
      "which restacks each merge will force, and anything that should NOT merge",
      "yet and why.",
      REPORT_BACK,
    ].join(" "),
    target: "manager",
    affects: [],
    requires: [],
    argPrompt: null,
    labelExtract: null,
    key: "o",
    group: "manager",
    fleet: true,
  },
  {
    kind: "claude",
    id: "manager-nudge",
    name: "Nudge stalled workers",
    prompt: [
      "Find stalled workers: rows asserting working/review whose sessions have",
      "gone quiet or whose status timestamps are old (`wt status --all --json`).",
      "Nudge each live-but-idle one with a pointed `wt claude send <slug>",
      "\"...\"` naming what it should do next; note the ones that are genuinely",
      "blocked rather than stalled.",
      REPORT_BACK,
    ].join(" "),
    target: "manager",
    affects: [],
    requires: [],
    argPrompt: null,
    labelExtract: null,
    key: "n",
    group: "manager",
    fleet: true,
  },
  {
    kind: "claude",
    id: "manager-audit",
    name: "Audit work statuses",
    prompt: [
      "Audit every asserted work status against reality (`wt status --all",
      "--json`, `gh`, session liveness): PR merged but row not cleaned? CI red",
      "under a ready? New commits after the assertion? Session dead mid",
      "working? Fix drifted records by asserting the true state on the row's",
      "behalf (`wt status <slug> <state> ...`).",
      REPORT_BACK,
    ].join(" "),
    target: "manager",
    affects: [],
    requires: [],
    argPrompt: null,
    labelExtract: null,
    key: "a",
    group: "manager",
    fleet: true,
  },
  {
    kind: "claude",
    id: "manager-start-next",
    name: "Start next todo",
    prompt: [
      "Pick the next todo work to start. From rows asserting todo (`wt status",
      "--all --json`), choose the highest-value one(s) given current fleet load",
      "(don't flood — a couple at most), and kick each off by injecting a",
      "starting prompt into its session with `wt claude send <slug> \"...\"`",
      "that tells the agent to begin the task and own its status transitions.",
      REPORT_BACK,
    ].join(" "),
    target: "manager",
    affects: [],
    requires: [],
    argPrompt: null,
    labelExtract: null,
    key: "s",
    group: "manager",
    fleet: true,
  },
  {
    kind: "claude",
    id: "manager-ask-row",
    name: "Ask about selected row",
    prompt: [
      "Question about {{slug}} (branch {{branch}}) — answer from fleet",
      "knowledge, `wt status`, and `gh`; delegate to the row's own session only",
      "if it requires the worktree's conversation context:",
    ].join(" "),
    target: "manager",
    affects: [],
    requires: [],
    argPrompt: null,
    labelExtract: null,
    key: "r",
    group: "manager",
  },
  {
    kind: "claude",
    id: "manager-compact",
    name: "Compact manager context",
    // /compact takes focus instructions: preserve the fleet coordination
    // state, and make the FIRST post-compact action re-running /manager
    // so the playbook (and its opt-in briefs) survives every compaction
    // explicitly instead of decaying into the summary.
    //
    // The date leads, and the carry-forward instruction is the
    // load-bearing half: a date that appears only in this prompt gets
    // summarized away, and the manager then reasons from its training
    // cutoff (observed: recommending a hold "to Monday" on a Tuesday).
    // `{{today}}` re-resolves on every dispatch, so each compaction
    // re-stamps rather than aging inside the previous summary.
    prompt:
      "/compact Today is {{today}}. State that date verbatim in the summary you produce — a compaction summary is otherwise undated, and everything after it reasons from a stale one. Preserve: current fleet state (per-slug statuses, in-flight nudges, pending merge order, unresolved escalations) and any standing briefs from the config. You are the wt manager session; immediately after this compaction, re-run /manager to reload your playbook before doing anything else.",
    target: "manager",
    affects: [],
    requires: [],
    argPrompt: null,
    labelExtract: null,
    key: "m",
    group: "manager",
    fleet: true,
    direct: true,
  },
];

/**
 * The slot palettes' builtins (`<` / `>` / `\` — wt repo, main clone,
 * dotfiles). One shared set: unlike the manager, the ordinary slots
 * carry no fleet role, so their palette is just the basics you'd
 * otherwise attach for — nudge the session onward, compact its
 * context, or fire a free-text instruction (the picker's built-in
 * custom entry). All `fleet: true` (slot-scoped, no row context) and
 * `target: "slot"` (delivered by `launchSlotCommand`, never
 * `launchAction`). The "Open in Zed" row is not an ActionDef — it's a
 * local `PickerItem` the flows layer appends (`z`).
 */
export const SLOT_BUILTIN_ACTIONS: readonly ActionDef[] = [
  {
    kind: "claude",
    id: "slot-continue",
    name: "Continue current work",
    prompt: [
      "Pick your current work back up and continue. Recheck actual state first",
      "(tree, git status, your own conversation context) rather than assuming;",
      "then do the next real unit of work. If nothing is pending, reply with",
      "one line saying so and stop.",
    ].join(" "),
    target: "slot",
    affects: [],
    requires: [],
    argPrompt: null,
    labelExtract: null,
    key: "g",
    fleet: true,
  },
  {
    kind: "claude",
    id: "slot-compact",
    name: "Compact context",
    // Same date anchor as the manager's compact, minus the fleet
    // preservation list — a slot session has no fleet role.
    prompt:
      "/compact Today is {{today}}. State that date verbatim in the summary you produce, so nothing after this compaction has to guess it.",
    target: "slot",
    affects: [],
    requires: [],
    argPrompt: null,
    labelExtract: null,
    key: "m",
    fleet: true,
    direct: true,
  },
];

/**
 * Every code-defined action, for id-resolution sites (dispatch,
 * automations). Deliberately excludes SLOT_BUILTIN_ACTIONS: those only
 * make sense addressed to a slot session via `launchSlotCommand`, and
 * resolving them here would let an automation route one through
 * `launchAction`, which would misdeliver a `target: "slot"` def as a
 * headless run.
 */
export const ALL_BUILTIN_ACTIONS: readonly ActionDef[] = [
  ...PINNED_BUILTIN_ACTIONS,
  ...BUILTIN_ACTIONS,
  ...MANAGER_BUILTIN_ACTIONS,
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
