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
import { agentIdentity } from "../../core/agent-identity.ts";
import { baseTipSha, revParse } from "../../core/git.ts";
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
  setSlugExamined,
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
  ${bold("ready")}          tested & safe to merge; requires ${bold("--risk low|medium|high")}
  ${bold("dropped")}        will never land (superseded / duplicate / not pursued); ${bold("-m")}
                 required: why. No --risk — nothing is being merged. The row
                 sinks out of the queue instead of wearing a fake ready

${bold("--blocked-on \"<gate>\"")} names an external condition that must clear.
The STATE supplies the verb:
  ${bold("ready")} + gate   finished and verified, but MUST NOT be merged until <gate>
  ${bold("todo")}  + gate   deliberately NOT STARTED until <gate>
Not a state of its own, because "the work is done" and "it can't land
yet" are two facts and a state can only carry one. A gated row renders
blocked and sorts out of the band it would otherwise lead; clear it with
${bold("wt status --unblock")} when the gate clears (nothing expires it).
The todo form exists because "held deliberately" and "nobody has picked
it up" look identical otherwise — a fleet held 14 worktrees on an
unlanded credentials file with the policy living only in section names
and one coordinator's memory.
the test is whether MERGING makes something worse than not merging:
  gate:     merging causes harm on its own — a revocation landing before
            the mobile build that tolerates it, an upstream change that
            has to be in place first
  not gate: merging causes nothing until someone follows through, and
            forgetting leaves the status quo. A policy tightening whose
            migration is applied by hand is safe to MERGE and dangerous
            to FORGET — unapplied, nothing gets worse; the PR just reads
            as shipped. That belongs in the ${bold("OPS:")} line, which is read at
            merge time. Gate on it and the field comes to mean "read the
            note", which is what it replaced

${bold("risk")} = how confident you are AFTER testing — NOT how big or scary the
change is. The human can already see the diff on the PR; your confidence
is the one thing they can't. Judge it by what you verified, not by what
you touched:
  ${bold("low")}     verified in a real environment, or pure logic with tests that
          fail against the old code. A mistake would be obvious and cheap
          to undo. (A migration you ran end to end on dev belongs here.)
  ${bold("medium")}  correct by construction and unit-tested, but never exercised
          for real. Or plainly revertable but broad.
  ${bold("high")}    something material is unverified AND backing it out is not a
          plain revert.
A one-line frontend change nobody opened a browser for is not low.
medium/high require ${bold("-m")} saying what's unverified and what it would cost.

${bold("the ready note")} — ~400 chars, fragments not sentences. Longer detail goes
in the PR body; the note may point at it. These four are what someone
merging unread code actually needs:
  <one line: what changes, in user terms>
  ${bold("OPS:")}      migrations / redeploys / config, or "none"
  ${bold("REVERT:")}   "safe", or "no:" + the shortest true reason
  ${bold("IF WRONG:")} where it shows + the symptom
  ${bold("UNTESTED:")} omit the line entirely if nothing is
You write one note; the human reads all of them at once. The budget is
the point — without it "concise" loses to "thorough" every time.

set:   wt status [<slug>] <state> [-m "note"] [--risk low|medium|high]
                            [--blocked-on "<gate>"]   (ready only)
show:  wt status [<slug>] [--all [--json]]     clear: wt status --clear [<slug>]
sweep: wt status [<slug>] --examined "<verdict>"   record that you LOOKED and
       what you concluded, stamped with HEAD. A skip hint for the next
       fleet pass, not a status — it voids itself when the branch moves
amend: wt status [<slug>] --risk <r> [-m "..."]  re-judge risk as testing lands
       wt status [<slug>] --note-only "..."      amend the note alone
       wt status [<slug>] --unblock              the gate cleared
       (all keep the state and timestamp — no need to restate anything)

${bold("-m REPLACES the note")}; add ${bold("--append")} to add to it instead. A replaced note
is echoed back so what you overwrote is recoverable from this output.`;

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
    case "dropped":
      return [
        `close (don't merge) any open PR for this branch and say why in a PR comment.`,
        `Leave the worktree itself alone — destroying it is the human's call.`,
      ];
  }
}

/**
 * Replaces the plain `ready` guidance when a gate is set. `ready`'s
 * advice ("leave the PR for the human to merge") is exactly wrong here
 * — the point is that it must NOT be merged — so the footer has to say
 * something different or it teaches the failure it exists to prevent.
 */
function blockedGuidance(state?: WorkState): string[] {
  if (state === "todo") {
    return [
      `recorded as deliberately not started, so it reads as held rather than`,
      `merely untouched, and sorts below the todos someone COULD pick up.`,
      `When the gate clears: ${bold("wt status --unblock")}, then start it.`,
      `Nothing expires a gate — wt cannot see a credentials file arrive.`,
    ];
  }
  return [
    `this row now sorts OUT of the merge band and renders as blocked, so nobody`,
    `merges it by reading the state. Keep the PR a draft while the gate stands.`,
    `When the gate clears: ${bold("wt status --unblock")} (keeps the state, risk, note and`,
    `timestamp). Nothing expires a gate — wt cannot see a release ship.`,
  ];
}

function unblockedGuidance(): string[] {
  return [
    `gate cleared — this is a plain ${bold("ready")} again and rejoins the merge band.`,
    `Mark the PR ready for review if you left it a draft.`,
  ];
}

/**
 * Notes are durable, cross-session, human-facing state, and `-m`
 * replaces the whole thing. That is the right default (a note that only
 * ever grows becomes a wall nobody reads), but the failure mode is real
 * and was observed: an agent asserting `review -m "addressing review
 * findings"` silently destroyed a note carrying a nine-function redeploy
 * list, a schema-version warning, and which functions had been verified
 * — and nothing in the output suggested anything had been lost. After a
 * compaction the agent cannot retype what it no longer remembers.
 *
 * So: `--append` for the "add to it" intent, and on any replace the old
 * text is echoed back. The echo is the cheap half and the important
 * one — it makes the loss visible at the moment it happens, in the
 * scrollback of the process that caused it, which is exactly when
 * recovery is a copy-paste.
 */
function resolveNote(
  prev: string | null,
  incoming: string | null,
  append: boolean,
  opts: { keepWhenAbsent: boolean } = { keepWhenAbsent: true },
): { note: string | null; replaced: string | null } {
  if (incoming === null) {
    // Amending keeps the note it isn't editing; a fresh assertion drops
    // it, and either way we only flag text that actually disappeared.
    const note = opts.keepWhenAbsent ? prev : null;
    return { note, replaced: note === prev ? null : prev };
  }
  if (append && prev) return { note: `${prev} ${incoming}`, replaced: null };
  return { note: incoming, replaced: prev && prev !== incoming ? prev : null };
}

/**
 * Echo a note that just stopped being the record's note — replaced by
 * `-m`, or dropped by a fresh assertion that carried none. Printing it
 * is what makes the loss recoverable: it lands in the scrollback of the
 * process that caused it, at the moment it happens.
 */
function reportReplacedNote(replaced: string | null, gaveNote: boolean): void {
  if (!replaced) return;
  console.log(`  ${dim("previous note (now gone):")} ${dim(replaced)}`);
  hint(
    gaveNote
      ? [
          `${bold("-m")} replaces the note rather than adding to it — the old text is above`,
          `if it was still needed (${bold("--append")} adds to it, ${bold("--note-only")} edits it alone).`,
        ]
      : [
          `a new assertion starts a fresh note — the old text is above if it still applies;`,
          `re-state what's still true with ${bold("-m")}, or amend in place with ${bold("--note-only")}.`,
        ],
  );
}

/**
 * Soft budget for a `ready` note. Not enforced — a refusal would be
 * worse than a long note — but named, because "concise" reliably loses
 * to "thorough" when each agent judges its own note in isolation and
 * never sees the wall of thirteen the human reads at once.
 */
const NOTE_BUDGET = 400;

function noteBudgetHint(state: WorkState, note: string | null): void {
  // 1.25× rather than a hard 400: a note a little over budget is fine
  // and nagging about it would train agents to ignore the hint. The
  // shape this is aimed at — a three-to-five-sentence paragraph — starts
  // around 500 and runs well past it.
  if (state !== "ready" || !note || note.length <= NOTE_BUDGET * 1.25) return;
  hint([
    `that note is ${note.length} chars; the shape is ~${NOTE_BUDGET} — one line of what changes, then`,
    `${bold("OPS:")} / ${bold("REVERT:")} / ${bold("IF WRONG:")} / ${bold("UNTESTED:")} as fragments. Detail belongs in the PR body.`,
  ]);
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
    case "dropped":
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
  /**
   * Record a fleet-level "I looked at this and concluded X", stamped
   * with the row's current HEAD. Separate from the work status because
   * it is a claim by an OBSERVER, not by the owner: the row's own
   * lifecycle state is untouched.
   */
  | { kind: "examined"; slugArg: string | null; verdict: string }
  | { kind: "clear"; slugArg: string | null }
  /**
   * Amend an EXISTING record in place — risk, note, or both — keeping
   * its state, timestamp and sha. Risk is a confidence call that
   * legitimately changes as testing lands, and making an agent restate
   * the whole assertion to move it is what produces walls of appended
   * note text.
   */
  | {
      kind: "amend";
      slugArg: string | null;
      note: string | null;
      risk: WorkRisk | null;
      append: boolean;
      /**
       * Three-valued on purpose: absent = leave the gate alone, a
       * string = set it, null = clear it (`--unblock`). Amending risk
       * must not silently unblock a branch, and unblocking must not
       * require restating the risk.
       */
      blockedOn?: string | null;
    }
  | {
      kind: "set";
      slugArg: string | null;
      state: WorkState;
      note: string | null;
      risk: WorkRisk | null;
      append: boolean;
      blockedOn: string | null;
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
  let append = false;
  let blockedOnRaw: string | null = null;
  let unblock = false;
  let examinedRaw: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (
      a === "-m" ||
      a === "--note" ||
      a === "--risk" ||
      a === "--note-only" ||
      a === "--blocked-on" ||
      a === "--examined"
    ) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-")) {
        // `--note-only -m "..."` is the natural mistake, because -m is
        // how every OTHER status form carries a note. Naming the fix
        // costs one branch; "requires a value (got \"-m\")" states the
        // symptom and leaves the reader to guess the form.
        if (a === "--note-only" && (value === "-m" || value === "--note")) {
          return err(`--note-only takes the note itself — drop the ${value} (wt status --note-only "...")`);
        }
        return err(`${a} requires a value${value !== undefined ? ` (got "${value}")` : ""}`);
      }
      i++;
      if (a === "--risk") riskRaw = value;
      else if (a === "--note-only") noteOnly = value;
      else if (a === "--blocked-on") blockedOnRaw = value;
      else if (a === "--examined") examinedRaw = value;
      else note = value;
    } else if (a === "--append") append = true;
    else if (a === "--unblock") unblock = true;
    else if (a === "--clear") clear = true;
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

  let blockedOn: string | null = null;
  if (blockedOnRaw !== null) {
    blockedOn = sanitizeWorkNote(blockedOnRaw);
    if (blockedOn === "") {
      return err(
        "--blocked-on requires the gate itself — what has to happen before this can merge?",
        [
          `e.g. --blocked-on "mobile 2.14 shipped and old builds drained".`,
          `To remove a gate that has cleared: ${bold("wt status --unblock")}.`,
        ],
      );
    }
  }
  if (blockedOn !== null && unblock) {
    return err("--blocked-on sets a gate and --unblock removes one — pick one");
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
    if (note !== null || riskRaw !== null || blockedOn !== null || unblock) {
      return err("--note-only amends only the note — drop -m/--risk/--blocked-on/--unblock");
    }
    if (positionals.length > 1) return err("too many arguments for --note-only");
    if (positionals[0] && resolveWorkState(positionals[0])) {
      return err(
        "--note-only keeps the current state — drop the state argument (use -m alongside a state to set both)",
      );
    }
    const sanitized = sanitizeWorkNote(noteOnly);
    if (sanitized === "") return err("--note-only requires a non-empty note");
    return {
      kind: "amend",
      slugArg: positionals[0] ?? null,
      note: sanitized,
      risk: null,
      append,
    };
  }

  if (examinedRaw !== null) {
    if (clear || all || note !== null || riskRaw !== null || blockedOn !== null || unblock) {
      return err("--examined records an observer's verdict on its own — drop the other flags");
    }
    const verdict = sanitizeWorkNote(examinedRaw);
    if (verdict === "") return err("--examined requires the verdict itself");
    if (positionals.length > 1) return err("too many arguments for --examined");
    return { kind: "examined", slugArg: positionals[0] ?? null, verdict };
  }

  if (append && note === null && noteOnly === null) {
    return err("--append needs the text to append (-m \"...\" or --note-only \"...\")");
  }

  if (all) {
    if (
      clear ||
      riskRaw !== null ||
      note !== null ||
      blockedOn !== null ||
      unblock ||
      positionals.length > 0
    ) {
      return err("--all only combines with --json — drop the other flags/arguments");
    }
    return { kind: "all", json };
  }
  if (json) return err("--json requires --all");

  if (clear) {
    if (riskRaw !== null || note !== null || blockedOn !== null || unblock) {
      return err(
        "--clear doesn't take -m/--risk/--blocked-on/--unblock — it just drops the record",
      );
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
    // `--risk` with no state RE-JUDGES an existing record rather than
    // erroring: confidence is supposed to move as testing lands, and the
    // only alternative — re-asserting `ready` in full — fakes a fresh
    // assertion and forces the note to be restated.
    // Same reasoning for the gate as for risk: a gate clearing is news
    // about the WORLD, not a new claim about the work, so amending it
    // must not fake a fresh assertion (which would reset the note and
    // re-narrate the state to every watching TUI).
    if (blockedOn !== null || unblock) {
      return {
        kind: "amend",
        slugArg,
        note,
        risk,
        append,
        blockedOn: unblock ? null : blockedOn,
      };
    }
    if (risk) return { kind: "amend", slugArg, note, risk, append };
    if (note !== null) {
      return err(
        "-m needs a state to set — to amend an existing note use --note-only",
      );
    }
    return { kind: "show", slugArg };
  }

  const resolved = resolveState(stateArg);
  if (typeof resolved !== "string") return resolved;
  const state = resolved;

  if (risk && state !== "ready") {
    return err(`--risk only applies to ready (got ${state})`);
  }
  if (unblock) {
    return err("a new assertion already clears any gate — drop --unblock", [
      `${bold("--unblock")} amends an existing record (${bold("wt status --unblock")}); asserting a`,
      `state fresh replaces the whole record, gate included.`,
    ]);
  }
  // A gate names an external condition that must clear; the STATE
  // supplies the verb. `ready` + gate = do not MERGE yet; `todo` + gate
  // = do not START yet. Nothing else takes one: the in-flight states
  // describe work in motion, where "blocked" already has a word
  // (`needs-human`), and `dropped` is not waiting on anything.
  if (blockedOn !== null && state !== "ready" && state !== "todo") {
    return err(`--blocked-on applies to ready and todo (got ${state})`, [
      `on ${bold("ready")} it means "done, but must not MERGE yet".`,
      `on ${bold("todo")} it means "deliberately not STARTED yet".`,
      `Already working on it? that is just ${bold(state)}. Blocked on the human`,
      `to make progress at all? that is ${bold("needs-human")}.`,
    ]);
  }
  if (state === "ready" && !risk) {
    return err("ready requires --risk low|medium|high — how confident are you in it?", [
      "risk is your residual uncertainty AFTER testing, not the size of the diff:",
      `${bold("low")} = verified in a real environment (or logic with tests that fail`,
      `against the old code) · ${bold("medium")} = unit-tested but never exercised for real`,
      `· ${bold("high")} = something material is unverified AND it isn't a plain revert.`,
      `medium/high also require ${bold("-m")} saying what's unverified.`,
    ]);
  }
  if (state === "ready" && risk !== "low" && !note) {
    return err(`ready --risk ${risk} requires -m: what's unverified, and what would it cost?`, [
      `e.g. "migration applied on dev but the backfill path was never run", or`,
      `"not reasonably testable outside prod". If everything material IS verified,`,
      `the honest answer is ${bold("--risk low")} — don't hedge a tested change to medium.`,
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
  if (state === "dropped" && !note) {
    return err("dropped requires -m: why will this never land?", [
      `e.g. -m "duplicate of COZ-2050 — #1091 merged, #1092 closed", or`,
      `-m "superseded by the v2 approach in <branch>". The note is the only`,
      `record of why this row exists but goes nowhere.`,
    ]);
  }

  return { kind: "set", slugArg, state, note, risk, append, blockedOn };
}

/**
 * Does a recorded verdict still describe reality? Only when BOTH the
 * row and its base are where they were when it was reached.
 *
 * Null when there is no verdict, or when either side cannot be
 * resolved — and, deliberately, when the record carries no base anchor
 * at all. Such a record cannot prove the base held still, and a
 * behind-to-conflicted transition moves the base while leaving the row
 * alone, so treating it as current would skip exactly the row that
 * needs looking at. Unknown reads as "look properly", never as "fine".
 */
export function examinedCurrent(
  examined: { sha: string; baseSha?: string } | undefined,
  headSha: string | null,
  baseSha: string | null,
): boolean | null {
  if (!examined || !headSha) return null;
  if (!examined.baseSha) return false;
  if (!baseSha) return null;
  return examined.sha === headSha && examined.baseSha === baseSha;
}

function describe(
  slug: string,
  record: WorkStatusRecord | undefined,
  headSha: string | null,
): string {
  if (!record) return `${cyan(slug)}  ${dim("no status asserted")}`;
  const color = stateColor(record.state);
  const parts = [
    `${cyan(slug)}  ${record.blockedOn ? red("blocked") + dim("/") + color(record.state) : color(record.state)}`,
  ];
  if (record.risk) parts.push(dim("risk:") + " " + color(record.risk));
  // Ahead of the age and the note: this is the one field that changes
  // what the reader may DO with the row.
  if (record.blockedOn) parts.push(red(`blocked on: ${record.blockedOn}`));

  const age = workAge(record.at);
  if (age) parts.push(dim(`${age} ago`));
  if (record.sha && headSha && record.sha !== headSha) {
    parts.push(yellow("(stale: commits since)"));
  }
  // Only when someone OTHER than this worktree's own agent asserted it —
  // the common case carries no information, and the interesting one
  // ("the manager triaged this and confirmed it needs you") is invisible
  // without it.
  if (record.by && record.by !== slug) parts.push(dim(`via ${record.by}`));
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
        // Same helper as the write path, so both sides share one
        // reference frame. Computed anywhere else they would disagree.
        baseSha: await baseTipSha(state.slugs[w.slug]?.baseBranch ?? null),
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
            ...entries.map(({ w, record, headSha, baseSha }) => ({
              slug: w.slug,
              branch: w.branch,
              // Positive discriminator, so branching on it doesn't come
              // out as "kind is absent". Live and archived rows carry
              // different keys — only live ones have `state`/`risk`/
              // `note` — and with live rows unlabelled the only way to
              // pick them out was a negative test, which reads like a
              // missing field rather than a deliberate one. A consumer
              // that iterated and read `.state` threw on the first
              // archived row instead.
              kind: "live" as const,
              // Manual TUI section (human grouping intent); null = inbox.
              section: state.slugs[w.slug]?.section ?? null,
              state: record?.state ?? null,
              note: record?.note ?? null,
              risk: record?.risk ?? null,
              // The external gate that must clear before this may be
              // merged (`wt status --blocked-on`). Non-null means DO
              // NOT MERGE, whatever `state` says — a consumer that
              // reads `state == "ready"` alone repeats the failure the
              // field was added for. Flat here, against
              // `.work.blockedOn` on `wt fleet --json`, matching how
              // `by`/`.work.by` already differ between these surfaces.
              blocked_on: record?.blockedOn ?? null,
              at: record?.at ?? null,
              // The last fleet-level verdict, and whether it still
              // applies. `examined_current` is the field a sweep keys
              // its early-out on: false or null means look properly.
              examined: state.slugs[w.slug]?.examined ?? null,
              // True only when NEITHER the row nor its base has moved.
              // A record with no base anchor (written before that
              // existed) cannot prove the base held still, so it reads
              // as not-current — the failure direction stays "look
              // properly", never "skip a row that just went conflicted".
              examined_current: examinedCurrent(
                state.slugs[w.slug]?.examined,
                headSha,
                baseSha,
              ),
              // Agent identity that asserted it (`manager` when triage
              // did); null = the human, or a plain shell.
              by: record?.by ?? null,
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

  if (args.kind === "examined") {
    // Two anchors, and the second is the one that keeps this honest.
    // HEAD is obvious. The BASE head matters because the transition
    // most worth catching — behind becoming conflicted — is caused by
    // the base moving and leaves this row's own head untouched, so a
    // row-only anchor would keep a verdict valid across exactly the
    // event that voids it.
    const sha = await revParse("HEAD", target.path);
    if (!sha) {
      console.error(red(`could not resolve HEAD for ${target.slug}`));
      return 2;
    }
    const baseBranch = state.slugs[target.slug]?.baseBranch ?? null;
    const baseSha = await baseTipSha(baseBranch);
    const by = agentIdentity();
    setSlugExamined(target.slug, {
      sha,
      ...(baseSha ? { baseSha } : {}),
      verdict: args.verdict,
      at: new Date().toISOString(),
      ...(by ? { by } : {}),
    });
    console.log(
      `${green("✓")} ${cyan(target.slug)} ${dim("examined at")} ${sha.slice(0, 7)}${
        baseSha ? dim(` on ${baseBranch ?? "trunk"} ${baseSha.slice(0, 7)}`) : ""
      }${by ? dim(` by ${by}`) : ""}`,
    );
    console.log(`  ${dim("verdict:")} ${args.verdict}`);
    hint([
      `a SKIP HINT for the next fleet sweep, not a status — ${bold(target.slug)}'s own`,
      `lifecycle state is untouched. It voids itself when this branch moves OR`,
      `when its base does; a PR goes conflicted because the BASE moved, which`,
      `leaves this row's head alone.`,
    ]);
    return 0;
  }

  if (args.kind === "clear") {
    setSlugWorkStatus(target.slug, null);
    console.log(green(`✓ ${target.slug} status cleared`));
    return 0;
  }

  if (args.kind === "amend") {
    const prev = state.slugs[target.slug]?.work;
    if (!prev) {
      console.error(
        red(
          `${target.slug} has no status asserted — amending edits an existing record; set a state first`,
        ),
      );
      return 2;
    }
    if (args.risk && prev.state !== "ready") {
      console.error(
        red(`--risk only applies to ready (${target.slug} is ${prev.state})`),
      );
      hint([
        `assert the state and the risk together: ${bold(`wt status ready --risk <r>`)}`,
      ]);
      return 2;
    }
    if (
      args.blockedOn !== undefined &&
      args.blockedOn !== null &&
      prev.state !== "ready" &&
      prev.state !== "todo"
    ) {
      console.error(
        red(
          `--blocked-on applies to ready and todo (${target.slug} is ${prev.state})`,
        ),
      );
      hint([
        `a gate says an EXTERNAL condition must clear first — before merging`,
        `(${bold("ready")}) or before starting (${bold("todo")}). Assert that state first.`,
      ]);
      return 2;
    }
    if (args.blockedOn === null && !prev.blockedOn) {
      console.error(red(`${target.slug} has no gate to clear`));
      return 2;
    }
    const { note, replaced } = resolveNote(
      prev.note ?? null,
      args.note,
      args.append,
    );
    // Same rule as asserting: a non-low risk without a note is an
    // unexplained hedge. An existing note satisfies it.
    if (args.risk && args.risk !== "low" && !note) {
      console.error(
        red(`--risk ${args.risk} requires -m: what's unverified, and what would it cost?`),
      );
      return 2;
    }
    // Spread keeps state/at/sha/by byte-identical: the record still
    // describes the same assertion, just better judged — so no timestamp
    // bump, no re-narration of an unchanged state, and no re-attribution
    // (`by` names who ASSERTED, and amending is not asserting).
    const next: WorkStatusRecord = { ...prev };
    if (args.risk) next.risk = args.risk;
    if (note) next.note = note;
    if (args.blockedOn !== undefined) {
      if (args.blockedOn === null) delete next.blockedOn;
      else next.blockedOn = args.blockedOn;
    }
    setSlugWorkStatus(target.slug, next);
    const changed = [
      args.risk ? "risk" : null,
      args.note ? "note" : null,
      args.blockedOn === undefined ? null : args.blockedOn === null ? "gate cleared" : "gate",
    ].filter(Boolean);
    const what = changed.join(" + ") || "note";
    createLogger(target.slug).info(
      `work status ${what} amended${workStatusSuffix(next)}`,
    );
    const color = stateColor(prev.state);
    console.log(
      `${green("✓")} ${cyan(target.slug)} ${color(prev.state)}${
        next.risk ? `  ${dim("risk:")} ${color(next.risk)}` : ""
      }  ${dim(`${what} amended (state + timestamp kept)`)}`,
    );
    if (next.blockedOn) console.log(`  ${red("blocked on:")} ${next.blockedOn}`);
    if (next.note) console.log(`  ${dim("note:")} ${next.note}`);
    reportReplacedNote(replaced, args.note !== null);
    noteBudgetHint(prev.state, next.note ?? null);
    if (args.blockedOn === null) hint(unblockedGuidance());
    else if (args.blockedOn) hint(blockedGuidance(prev.state));
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

  // A new assertion still starts from a clean note when none is given —
  // notes are scoped to the assertion they explain, and carrying a
  // "blocked on dev login" note forward into `ready` would be worse than
  // losing it. What changes is that losing it is no longer SILENT.
  const prevNote = state.slugs[target.slug]?.work?.note ?? null;
  const { note, replaced } = resolveNote(prevNote, args.note, args.append, {
    keepWhenAbsent: false,
  });
  const record: WorkStatusRecord = {
    state: args.state,
    at: new Date().toISOString(),
  };
  if (note) record.note = note;
  if (args.risk) record.risk = args.risk;
  if (args.blockedOn) record.blockedOn = args.blockedOn;
  // Who is claiming this. Usually the worktree's own agent; the manager
  // playbook also has it assert on a worker's behalf after triage, and
  // that difference is what keeps a `status.*` automation from briefing
  // the session that just wrote the record.
  const by = agentIdentity();
  if (by) record.by = by;
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
  if (record.blockedOn) console.log(`  ${red("blocked on:")} ${record.blockedOn}`);
  if (record.note) console.log(`  ${dim("note:")} ${record.note}`);
  reportReplacedNote(replaced, args.note !== null);
  noteBudgetHint(args.state, record.note ?? null);
  hint(record.blockedOn ? blockedGuidance(args.state) : guidance(args.state));
  return 0;
}
