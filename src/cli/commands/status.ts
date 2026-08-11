/**
 * `wt status` — show or assert a worktree's work status (the
 * agent-declared lifecycle state; see core/work-status.ts).
 *
 * This command's primary caller is a coding AGENT inside a worktree,
 * not a human — so its output deliberately teaches: every transition
 * prints a short targeted guidance footer (ownership reminders, the
 * next expected step), bare `wt status` prints the vocabulary, and
 * errors restate the rules. Humans mostly use the TUI (`u` picker)
 * and never see this. `WT_NO_HINTS=1` silences the footers.
 *
 * Argument handling lives in the pure `parseStatusArgs` so the whole
 * flag/positional/validation matrix is unit-testable without spawning
 * git (see status.test.ts); `run` only resolves worktrees and does IO.
 */
import { revParse } from "../../core/git.ts";
import { createLogger } from "../../core/logger.ts";
import type { Worktree } from "../../core/types.ts";
import {
  resolveWorkState,
  sanitizeWorkNote,
  WORK_RISKS,
  WORK_STATES,
  workAge,
  workStatusSuffix,
  type WorkRisk,
  type WorkState,
  type WorkStatusRecord,
} from "../../core/work-status.ts";
import { listWorktrees, worktreeAtCwd } from "../../core/worktree.ts";
import {
  readWtState,
  recentlyRemovedWorktrees,
  setSlugWorkStatus,
} from "../../core/wtstate.ts";
import { bold, cyan, dim, green, magenta, red, yellow } from "../colors.ts";
import { removedJsonEntry } from "../../core/wtstate.ts";

const VOCAB = `states (unique prefixes + nh/nt work):
  ${bold("todo")}           created, not started
  ${bold("working")}        implementation in progress
  ${bold("review")}         under review (self-review / review bot / addressing findings)
  ${bold("needs-testing")}  built; manual verification pending — YOU own that testing
                 (dev env + browser), it is not a request for a human
  ${bold("needs-human")}    blocked on the human; ${bold("-m")} required: say exactly what you need
  ${bold("ready")}          tested & safe to merge; requires ${bold("--risk low|medium|high")}.
                 medium/high require ${bold("-m")} naming the notable impacts (end
                 users, coworker workflows, costs). High-value only — no noise.

set:   wt status [<slug>] <state> [-m "note"] [--risk low|medium|high]
show:  wt status [<slug>] [--all [--json]]     clear: wt status --clear [<slug>]
note:  wt status [<slug>] --note-only "..."    amend the note; state + timestamp kept`;

const HINTS_OFF = process.env.WT_NO_HINTS === "1";

/**
 * Per-transition guidance. The convention lives HERE, in the tool the
 * agent already has in hand, so it can't drift from skills that may or
 * may not be loaded. Terse on purpose: 1-3 lines, next step only.
 */
function guidance(state: WorkState): string[] {
  switch (state) {
    case "todo":
      return [`when you pick this up: ${bold("wt status working")}`];
    case "working":
      return [
        `when implementation is done, keep going: review it, test it yourself on the dev env,`,
        `then ${bold("wt status ready --risk <r>")}. Blocked on the human? ${bold('wt status needs-human -m "<what you need>"')}`,
      ];
    case "review":
      return [
        `after review passes, run the manual/browser testing YOURSELF (dev env), then`,
        `${bold("wt status ready --risk <r> [-m <notable impacts>]")} — or ${bold("needs-testing")} while verification is pending`,
      ];
    case "needs-testing":
      return [
        `you own this testing — drive the dev env/browser yourself; escalate with`,
        `${bold('needs-human -m "..."')} ONLY if blocked on auth needing a person (2FA,`,
        `an OAuth consent) or a human-only check — a re-prompting credential is a papercut.`,
        `when it passes: ${bold("wt status ready --risk <r> [-m <notable impacts>]")}`,
      ];
    case "needs-human":
      return [
        `The human will see this — the note should name the blocker AND what you`,
        `already tried ("blocked on X; tried Y, Z"). Keep making progress on anything`,
        `not blocked, and assert the next status the moment you're unblocked.`,
        `A rough edge — or the SAME blocker twice (a credential that re-prompts every`,
        `run is a setup defect, not a human dependency) — is a papercut, not an`,
        `escalation: ${bold('wt manager send "papercut: ..."')}, fire and forget, then carry on.`,
      ];
    case "ready":
      return [
        `leave the PR ready for the human to merge — do NOT merge it yourself.`,
        `make sure the PR body reflects the final state of the change.`,
      ];
  }
}

function stateColor(state: WorkState): (s: string) => string {
  switch (state) {
    case "needs-human":
      return red;
    case "needs-testing":
      return yellow;
    case "ready":
      return green;
    case "review":
      return magenta;
    case "working":
      return cyan;
    case "todo":
      return dim;
  }
}

function resolveRisk(input: string): WorkRisk | null {
  const q = input.trim().toLowerCase();
  const matches = WORK_RISKS.filter((r) => r.startsWith(q));
  return q !== "" && matches.length === 1 ? matches[0]! : null;
}

/** Parsed intent for one `wt status` invocation. */
export type StatusArgs =
  | { kind: "help" }
  | { kind: "error"; message: string; hints?: string[]; showVocab?: boolean }
  | { kind: "all"; json: boolean }
  | { kind: "show"; slugArg: string | null }
  | { kind: "clear"; slugArg: string | null }
  | { kind: "note"; slugArg: string | null; note: string }
  | {
      kind: "set";
      slugArg: string | null;
      state: WorkState;
      note: string | null;
      risk: WorkRisk | null;
    };

function err(message: string, hints?: string[], showVocab = false): StatusArgs {
  return { kind: "error", message, hints, showVocab };
}

/**
 * Pure argument parsing + the validation rules that make statuses
 * trustworthy (risk required on ready, notes required where a bare
 * state would be useless). Notes are sanitized (control chars/ANSI
 * stripped) and whitespace-only notes count as absent. Flags never
 * swallow a following flag as their value, and flag combinations that
 * would silently drop intent (`--all --clear`, `--clear --risk`) are
 * errors rather than no-ops.
 */
export function parseStatusArgs(argv: readonly string[]): StatusArgs {
  const positionals: string[] = [];
  let note: string | null = null;
  let noteOnly: string | null = null;
  let riskRaw: string | null = null;
  let clear = false;
  let all = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-m" || a === "--note" || a === "--risk" || a === "--note-only") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        return err(`${a} requires a value${value !== undefined ? ` (got "${value}")` : ""}`);
      }
      i++;
      if (a === "--risk") riskRaw = value;
      else if (a === "--note-only") noteOnly = value;
      else note = value;
    } else if (a === "--clear") clear = true;
    else if (a === "--all") all = true;
    else if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") return { kind: "help" };
    else if (a.startsWith("-")) return err(`unknown flag: ${a}`, undefined, true);
    else positionals.push(a);
  }

  if (note !== null) {
    note = sanitizeWorkNote(note);
    if (note === "") note = null;
  }

  let risk: WorkRisk | null = null;
  if (riskRaw !== null) {
    risk = resolveRisk(riskRaw);
    if (!risk) return err(`--risk must be one of ${WORK_RISKS.join("|")}, got "${riskRaw}"`);
  }

  // `--note-only` amends the note of an EXISTING record without
  // resetting the state or the `at` timestamp — for sharpening a
  // needs-human note (or adding late-learned merge impacts) without
  // faking a fresh assertion. Everything else about the record is
  // untouched, so it conflicts with every state-changing flag.
  if (noteOnly !== null) {
    if (clear || all) return err("--note-only doesn't combine with --all/--clear");
    if (note !== null || riskRaw !== null) {
      return err("--note-only amends only the note — drop -m/--risk");
    }
    if (positionals.length > 1) return err("too many arguments for --note-only");
    if (positionals[0] && resolveWorkState(positionals[0])) {
      return err(
        "--note-only keeps the current state — drop the state argument (use -m alongside a state to set both)",
      );
    }
    const sanitized = sanitizeWorkNote(noteOnly);
    if (sanitized === "") return err("--note-only requires a non-empty note");
    return { kind: "note", slugArg: positionals[0] ?? null, note: sanitized };
  }

  if (all) {
    if (clear || riskRaw !== null || note !== null || positionals.length > 0) {
      return err("--all only combines with --json — drop the other flags/arguments");
    }
    return { kind: "all", json };
  }
  if (json) return err("--json requires --all");

  if (clear) {
    if (riskRaw !== null || note !== null) {
      return err("--clear doesn't take -m/--risk — it just drops the record");
    }
    if (positionals.length > 1) return err("too many arguments for --clear");
    return { kind: "clear", slugArg: positionals[0] ?? null };
  }

  // Positional layout: [] show-cwd · [state] set-on-cwd · [slug] show ·
  // [slug, state] set. A lone positional resolving to a state wins over
  // slug interpretation (states are reserved words here).
  const resolveState = (input: string): WorkState | StatusArgs => {
    const state = resolveWorkState(input);
    if (state) return state;
    const matches = WORK_STATES.filter((s) => s.startsWith(input.trim().toLowerCase()));
    if (matches.length > 1) {
      return err(`ambiguous status "${input}" (matches ${matches.join(", ")})`, undefined, true);
    }
    return err(`unknown status: ${input}`, undefined, true);
  };

  let slugArg: string | null = null;
  let stateArg: string | null = null;
  if (positionals.length === 1) {
    if (resolveWorkState(positionals[0]!)) stateArg = positionals[0]!;
    else {
      const matches = WORK_STATES.filter((s) =>
        s.startsWith(positionals[0]!.trim().toLowerCase()),
      );
      if (matches.length > 1) {
        return err(
          `ambiguous status "${positionals[0]}" (matches ${matches.join(", ")})`,
          undefined,
          true,
        );
      }
      slugArg = positionals[0]!;
    }
  } else if (positionals.length === 2) {
    slugArg = positionals[0]!;
    stateArg = positionals[1]!;
  } else if (positionals.length > 2) {
    return err("too many arguments", undefined, true);
  }

  if (stateArg === null) {
    if (riskRaw !== null || note !== null) {
      return err("-m/--risk only apply when setting a state");
    }
    return { kind: "show", slugArg };
  }

  const resolved = resolveState(stateArg);
  if (typeof resolved !== "string") return resolved;
  const state = resolved;

  if (risk && state !== "ready") {
    return err(`--risk only applies to ready (got ${state})`);
  }
  if (state === "ready" && !risk) {
    return err("ready requires --risk low|medium|high — how risky is merging this?", [
      "judge broadly: end users, coworker workflows/dev tooling, costs, migrations.",
      `medium/high also require ${bold("-m")} naming the notable impacts. No noise: if`,
      `nothing is notable, that's ${bold("--risk low")} with no note.`,
    ]);
  }
  if (state === "ready" && risk !== "low" && !note) {
    return err(`ready --risk ${risk} requires -m: what should the human know before merging?`, [
      "high-value only — end-user impact, coworker disruption, cost, irreversibility",
      `(e.g. "calendar integrations may need a resync", "not reasonably testable").`,
    ]);
  }
  if (state === "needs-human" && !note) {
    return err(
      "needs-human requires -m: what exactly do you need, and what did you already try?",
      [
        `the note carries both — e.g. -m "blocked on dev-env Google login; tried`,
        `re-auth in the open browser and restarting the dev server"`,
      ],
    );
  }

  return { kind: "set", slugArg, state, note, risk };
}

function describe(
  slug: string,
  record: WorkStatusRecord | undefined,
  headSha: string | null,
): string {
  if (!record) return `${cyan(slug)}  ${dim("no status asserted")}`;
  const color = stateColor(record.state);
  const parts = [`${cyan(slug)}  ${color(record.state)}`];
  if (record.risk) parts.push(dim("risk:") + " " + color(record.risk));
  const age = workAge(record.at);
  if (age) parts.push(dim(`${age} ago`));
  if (record.sha && headSha && record.sha !== headSha) {
    parts.push(yellow("(stale: commits since)"));
  }
  let out = parts.join("  ");
  if (record.note) out += `\n  ${dim("note:")} ${record.note}`;
  return out;
}

function hint(lines: string[]): void {
  if (HINTS_OFF) return;
  for (const line of lines) console.log(dim("» ") + line);
}

function findWorktree(wts: Worktree[], slugOrBranch: string): Worktree | null {
  return wts.find((w) => w.slug === slugOrBranch || w.branch === slugOrBranch) ?? null;
}

export async function run(argv: string[]): Promise<number> {
  const args = parseStatusArgs(argv);

  if (args.kind === "help") {
    console.log(VOCAB);
    return 0;
  }
  if (args.kind === "error") {
    console.error(red(args.message));
    if (args.hints) hint(args.hints);
    if (args.showVocab) console.log(VOCAB);
    return 2;
  }

  const wts = (await listWorktrees()).filter((w) => !w.isMain);
  const state = readWtState();

  if (args.kind === "all") {
    // One revParse per worktree, shared by both output shapes.
    const entries = await Promise.all(
      wts.map(async (w) => ({
        w,
        record: state.slugs[w.slug]?.work,
        headSha: await revParse("HEAD", w.path),
      })),
    );
    if (args.json) {
      // Recently-destroyed rows (≤48h) ride along in the same shape
      // `wt ls --json` appends (`kind: "merged"|"removed"`), so the
      // manager can tell "everything landed" from "nothing exists".
      const removed = recentlyRemovedWorktrees(new Set(wts.map((w) => w.slug)));
      console.log(
        JSON.stringify(
          [
            ...entries.map(({ w, record, headSha }) => ({
              slug: w.slug,
              branch: w.branch,
              // Manual TUI section (human grouping intent); null = inbox.
              section: state.slugs[w.slug]?.section ?? null,
              state: record?.state ?? null,
              note: record?.note ?? null,
              risk: record?.risk ?? null,
              at: record?.at ?? null,
              stale: !!(record?.sha && headSha && record.sha !== headSha),
            })),
            ...removed.map(removedJsonEntry),
          ],
          null,
          2,
        ),
      );
      return 0;
    }
    for (const { w, record, headSha } of entries) {
      console.log(describe(w.slug, record, headSha));
    }
    return 0;
  }

  const target = args.slugArg
    ? findWorktree(wts, args.slugArg)
    : worktreeAtCwd(wts);
  if (!target) {
    if (args.slugArg) {
      console.error(red(`no worktree (and no such status): ${args.slugArg}`));
      console.log(VOCAB);
      return 1;
    }
    if (args.kind === "show") {
      // Bare `wt status` outside any worktree isn't an error — it's how
      // agents (and the skills' promises) discover the vocabulary. Teach,
      // then say how to address a worktree.
      console.log(VOCAB);
      hint([
        `not inside a worktree — pass a slug (${bold("wt status <slug> [<state>]")}),`,
        `or ${bold("wt status --all")} for the fleet overview`,
      ]);
      return 0;
    }
    console.error(red("not inside a worktree — pass a slug, or cd into one"));
    return 1;
  }

  if (args.kind === "clear") {
    setSlugWorkStatus(target.slug, null);
    console.log(green(`✓ ${target.slug} status cleared`));
    return 0;
  }

  if (args.kind === "note") {
    const prev = state.slugs[target.slug]?.work;
    if (!prev) {
      console.error(
        red(
          `${target.slug} has no status asserted — --note-only amends an existing record; set a state first`,
        ),
      );
      return 2;
    }
    // Spread keeps state/risk/at/sha byte-identical: the record still
    // describes the same assertion, just with a better note — so no
    // timestamp bump, no re-narration of an unchanged state.
    setSlugWorkStatus(target.slug, { ...prev, note: args.note });
    createLogger(target.slug).info(
      `work status note amended${workStatusSuffix({ note: args.note })}`,
    );
    const color = stateColor(prev.state);
    console.log(
      `${green("✓")} ${cyan(target.slug)} ${color(prev.state)}  ${dim("note amended (state + timestamp kept)")}`,
    );
    console.log(`  ${dim("note:")} ${args.note}`);
    return 0;
  }

  if (args.kind === "show") {
    const headSha = await revParse("HEAD", target.path);
    console.log(describe(target.slug, state.slugs[target.slug]?.work, headSha));
    if (!HINTS_OFF) {
      console.log("");
      console.log(VOCAB);
    }
    return 0;
  }

  const record: WorkStatusRecord = {
    state: args.state,
    at: new Date().toISOString(),
  };
  if (args.note) record.note = args.note;
  if (args.risk) record.risk = args.risk;
  const sha = await revParse("HEAD", target.path);
  if (sha) record.sha = sha;
  setSlugWorkStatus(target.slug, record);

  // File-only audit trail (the TUI derives its own attention-feed
  // entries from the wtstate change; this line is for grepping).
  const log = createLogger(target.slug);
  log.info(`work status → ${args.state}${workStatusSuffix(record)}`);

  const color = stateColor(args.state);
  console.log(
    `${green("✓")} ${cyan(target.slug)} → ${color(args.state)}${args.risk ? `  ${dim("risk:")} ${color(args.risk)}` : ""}`,
  );
  if (args.note) console.log(`  ${dim("note:")} ${args.note}`);
  hint(guidance(args.state));
  return 0;
}
