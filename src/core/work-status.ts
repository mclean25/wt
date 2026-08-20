/**
 * Work status — the agent-asserted lifecycle state of a worktree's
 * task. This is the layer wt cannot derive: git/PR/session state says
 * what the machine sees; the work status says what the AGENT claims
 * ("built, needs manual testing", "blocked on your login", "tested,
 * safe to merge"). Asserted via `wt status` (agents, from inside the
 * worktree) or the `u` picker (the human), persisted per-slug in
 * wtstate, rendered as the list pane's leftmost dot, and used to
 * auto-sort rows inside their sections.
 *
 * Pure module: types, the fixed vocabulary, prefix resolution, sort
 * ranking, and the effective-state ladder. Colors/glyphs live in
 * `tui/badges.ts` (theme is a TUI concern); persistence in
 * `core/wtstate/`.
 */

import type { DerivedState } from "./harness/status.ts";

/**
 * The fixed vocabulary, in lifecycle order. Deliberately not
 * configurable — the whole point is that every agent, skill, and pane
 * shares one meaning per word. Semantics:
 *
 *  - `todo`          — created, not started.
 *  - `working`       — implementation in progress.
 *  - `review`        — under review (self-review, the review bot,
 *                      addressing findings).
 *  - `needs-testing` — built; manual verification still pending. The
 *                      AGENT owns this testing (dev env, browser) —
 *                      it is not a request for the human to test.
 *  - `needs-human`   — blocked on the human (login/creds, a decision,
 *                      a test only they can run). The only state that
 *                      means "the human must act". Note required.
 *  - `ready`         — tested as far as reasonable; safe to merge.
 *                      Carries a merge `risk` and, when notable, a
 *                      note saying what the human should know before
 *                      merging. The human merges — never the agent.
 *  - `verified`      — merged AND confirmed in the environment the
 *                      change actually deploys to. The only honest
 *                      exit from a `--verify-after-merge` obligation,
 *                      and the point at which the checkout is finally
 *                      safe to sweep. Note required: what you checked
 *                      and where, because "someone said they did it"
 *                      is the whole thing being replaced. No risk —
 *                      the merge already happened.
 *  - `dropped`       — this branch will never land: superseded,
 *                      duplicate, or deliberately not pursued. The
 *                      OTHER terminal state — where `ready` asks for
 *                      merge attention, `dropped` asks to stop being
 *                      looked at (it sinks to the bottom of its
 *                      section, below todo). No risk (risk is a merge
 *                      concept); note required — why it will never
 *                      land is the one fact worth keeping. Named
 *                      `dropped`, not `abandoned`: that word already
 *                      means "session died mid-turn" in the harness
 *                      vocabulary.
 *
 * There is no asserted `done`: merged/gone is derived from git and
 * outranks anything asserted. `dropped` is not `done` — it is the
 * asserted "will never land", which the machine cannot derive (a
 * closed PR isn't proof: branches are dropped pre-PR too, and a
 * closed PR can be reopened).
 *
 * There is deliberately no `blocked` WORD either — see `blockedOn` on
 * the record. "The work is finished" and "it cannot land yet" are two
 * facts, and a state can only carry one of them; collapsing them is
 * what produced the failure that field exists to fix.
 */
export const WORK_STATES = [
  "todo",
  "working",
  "review",
  "needs-testing",
  "needs-human",
  "ready",
  "verified",
  "dropped",
] as const;

export type WorkState = (typeof WORK_STATES)[number];

/**
 * Merge risk on a `ready` record — deliberately a measure of the
 * asserter's residual UNCERTAINTY after testing, not of the change's
 * blast radius. Blast radius is visible on the PR; confidence is the
 * one thing only the person (or agent) who did the work knows, and it's
 * what the human sorts by when deciding what to merge without reading
 * the code. Read as blast radius the field collapses — a fleet where
 * every migration is `medium` and every frontend tweak is `low` carries
 * no signal, and it inverts the true calls in both directions (a
 * migration verified end to end on dev really is low; an untested
 * one-liner really isn't).
 *
 *  - `low`    — verified in a real environment, or pure logic with
 *               tests that fail against the old code. A mistake would
 *               be obvious and cheap to undo.
 *  - `medium` — correct by construction and unit-tested, but never
 *               exercised for real. Or plainly revertable but broad.
 *  - `high`   — something material is unverified AND backing it out is
 *               not a plain revert.
 *
 * It follows that risk is re-judged as testing lands, which is why
 * `wt status --risk <r>` amends it without restating the assertion.
 */
export const WORK_RISKS = ["low", "medium", "high"] as const;
export type WorkRisk = (typeof WORK_RISKS)[number];

/**
 * One asserted status. `at` is an ISO timestamp; `sha` is the
 * worktree's HEAD when asserted, so the UI can flag a status that
 * predates newer commits ("stale") without ever guessing. `risk` is
 * only meaningful on `ready`; `note` is required by the CLI for
 * `needs-human` (what exactly is needed) and for medium/high-risk
 * `ready` (the notable impacts).
 *
 * `by` is the agent identity that made the assertion (`WT_AGENT` — a
 * worktree slug, or `manager`), absent when nobody was stamped: the
 * human at the `u` picker, or a `wt status` typed in a plain shell.
 * Statuses are routinely asserted ON a worktree's behalf — the manager
 * playbook has it sharpen a needs-human note after triage — and without
 * this the record cannot say whether the claim came from the worker who
 * hit the blocker or from the coordinator who confirmed it. That
 * distinction is what stops a `status.*` automation from briefing the
 * session whose own write triggered it (see `automation-rules.ts`).
 * Write-once per assertion and replaced by the next one, so it can't
 * drift; an amend leaves it alone, because an amend re-judges an
 * existing assertion rather than making a new one.
 */
export type WorkStatusRecord = {
  state: WorkState;
  note?: string;
  risk?: WorkRisk;
  at: string;
  sha?: string;
  by?: string;
  /**
   * An external gate that must clear before this branch may be merged.
   * Only meaningful on `ready`, where it means: the work is finished
   * and verified, and merging it anyway would be wrong.
   *
   * This is a field rather than a seventh state because "done" and
   * "can't land yet" are independent facts. A `blocked` state would
   * have to eat one of them — it would either lose the risk judgement
   * or claim verification is still owed — and every option in the
   * six-word vocabulary already misreports the combination: `ready`
   * claims mergeable, `needs-testing` claims verification is owed,
   * `needs-human` claims the work is stuck.
   *
   * It is a field rather than a line in the NOTE because the note is
   * not load-bearing and was never going to be. A worktree wrote
   * "BLOCKED ON A MOBILE RELEASE" into its own note while asserting
   * `ready --risk low` one field to the left, and both the fleet
   * manager and a human read the state and put the branch in a merge
   * order — twice. Prose next to a field loses to the field every
   * time, so the gate has to BE a field, and the render has to change.
   *
   * Scope is exactly "do not merge yet", and the test is whether
   * merging makes something WORSE than not merging:
   *
   *  - Gate. Merging causes harm on its own. A revocation that lands
   *    before the mobile build that tolerates it breaks every shipped
   *    client the moment it merges.
   *  - Not a gate. Merging causes nothing until someone follows
   *    through, and forgetting leaves the status quo intact. A policy
   *    tightening whose migration is applied by hand is SAFE to merge
   *    and dangerous to FORGET: unapplied, the bucket stays exactly as
   *    open as it is today, and the only new harm is a PR that reads
   *    as shipped. That hazard is real and belongs in the note's
   *    `OPS:` line, which is read at merge time — it is not this
   *    field.
   *
   * The two feel alike and are the boundary case that will erode this
   * field if it is allowed in, because "merging has a consequence
   * somebody must follow through on" is not "merging is unsafe". Admit
   * the first and the field comes to mean "read the note", which is
   * where this started. Nothing expires it: wt cannot observe a mobile release or
   * a hand-applied migration, so it clears when someone says so
   * (`wt status --unblock`). A gate left set after it cleared parks a
   * mergeable branch, which is the safe direction to be wrong in; the
   * record's `at` age is what flags one worth re-checking.
   */
  blockedOn?: string;
  /**
   * A verification this branch owes that can only be run once the
   * change is DEPLOYED — an OAuth consent screen against the real
   * provider, a live webhook callback, a third-party SDK that has no
   * local double. Free text: the exact steps, because the agent that
   * eventually runs them is not the one that wrote this.
   *
   * Set alongside `ready`, and deliberately DORMANT until the branch
   * lands: it does not gate the merge, does not touch the merge band,
   * and does not change how the row sorts before merging. That is the
   * whole difference from `blockedOn`, which exists to say "do not
   * merge". Merging this is not just safe, it is the prerequisite.
   *
   * What it does instead is survive the merge. Once the branch lands,
   * the row would otherwise sink to `LANDED_RANK` and become a `wt
   * clean` candidate, taking the checkout and every scrap of context
   * with it — which is exactly when the verification stops happening.
   * So a landed row with this field outstanding renders and sorts as
   * `needs-testing` (`owesPostMergeVerification`) and reads as a
   * destroy hazard, until someone asserts `verified`.
   *
   * It is a field rather than a line in the note for the same reason
   * `blockedOn` is: prose beside a field loses to the field. It is a
   * field rather than a STATE because `ready` is still true — the work
   * is done and it should be merged — and a state can only carry one
   * fact. And it is not `UNTESTED:` in the ready note, which describes
   * what was left unverified at merge time and asks nothing of anyone;
   * this asks for a specific action, later, from whoever is holding
   * the row.
   *
   * A standing obligation about the BRANCH, not a claim inside one
   * assertion — so unlike `note`/`risk`/`blockedOn` it is carried
   * across later assertions rather than dropped by them. `verified`
   * discharges it, `dropped` voids it (nothing lands, nothing to
   * verify), and `--clear` removes the whole record.
   */
  verifyAfterMerge?: string;
};

/**
 * Resolve user/agent input to a state: exact id, unique prefix, or a
 * couple of unambiguous aliases (`nh`/`nt` for the two hyphenated
 * states, whose shared "needs-" prefix defeats plain prefix matching).
 * Returns null for unknown/ambiguous input — callers print the
 * vocabulary rather than guessing.
 */
export function resolveWorkState(input: string): WorkState | null {
  const q = input.trim().toLowerCase();
  if (q === "") return null;
  const ALIASES: Record<string, WorkState> = {
    nh: "needs-human",
    human: "needs-human",
    nt: "needs-testing",
    testing: "needs-testing",
  };
  if (ALIASES[q]) return ALIASES[q];
  const matches = WORK_STATES.filter((s) => s.startsWith(q));
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Sort rank within a section, most-urgent first. The ordering is
 * "what the human can finish right now, then what's blocked on them,
 * then what's still moving": `ready` leads because merging is the one
 * job only the human does and it's a glance + `m` away, then blocked
 * on the human, then pending verification, then the in-flight states.
 * Statusless rows sit between the in-flight states and `todo` — no
 * news is neutral, and rows that never opt into the system keep
 * congregating where they always were rather than being punished to
 * the bottom.
 */
/**
 * Which fields make two records THE SAME CLAIM, for the idempotent
 * re-assert guard in `setSlugWorkStatus`.
 *
 * Typed as a total `Record` over the record's keys ON PURPOSE: adding a
 * field to `WorkStatusRecord` fails the typecheck here until it is
 * classified. The guard used to hand-list four fields, and the list
 * drifted the moment a fifth existed — `blockedOn` and then
 * `verifyAfterMerge` were both invisible to it, so amending ONLY a gate
 * or ONLY the post-merge steps was swallowed as a duplicate assertion.
 * Silently: the CLI echoes the record it built in memory, so the write
 * that never happened was confirmed on stdout, and the only way to
 * notice was to read the row back afterwards.
 *
 * `at` is excluded because preserving it IS the point of the guard.
 * `by` is excluded because a second author asserting an unchanged claim
 * is not news for the board, and letting it through would bump the
 * timestamp and re-narrate in every watching TUI — the exact churn the
 * guard exists to stop.
 */
const CLAIM_FIELDS: Record<keyof WorkStatusRecord, boolean> = {
  state: true,
  note: true,
  risk: true,
  sha: true,
  blockedOn: true,
  verifyAfterMerge: true,
  at: false,
  by: false,
};

/**
 * Do two records assert the same thing? Compares every field
 * `CLAIM_FIELDS` marks, treating absent and undefined alike, so a
 * record that merely drops an optional key still compares equal to one
 * that never had it.
 */
export function sameWorkClaim(a: WorkStatusRecord, b: WorkStatusRecord): boolean {
  for (const field of Object.keys(CLAIM_FIELDS) as (keyof WorkStatusRecord)[]) {
    if (!CLAIM_FIELDS[field]) continue;
    if ((a[field] ?? null) !== (b[field] ?? null)) return false;
  }
  return true;
}

const RANK: Record<WorkState, number> = {
  ready: 0,
  "needs-human": 1,
  "needs-testing": 2,
  review: 3,
  working: 4,
  todo: 7,
  // Both terminal, both asking to be stopped looking at, and peers on
  // purpose: `verified` landed and was confirmed, `dropped` never
  // landed at all, and neither wants any of the human's attention. The
  // usual rank for a `verified` row is `LANDED_RANK` anyway — it is
  // merged by definition — and this entry only decides where a
  // hand-asserted one sits.
  verified: 9,
  // Will never land: below even todo — future work outranks no work.
  dropped: 9,
};

/**
 * A `todo` nobody can start yet, because something outside the repo has
 * to happen first. Below an ordinary `todo` — the human scanning for
 * what to pick up wants the ones they CAN pick up — and above
 * `dropped`, because this one is still going to happen.
 */
export const GATED_TODO_RANK = 8;

/**
 * A gated `ready` (see `blockedOn`) sorts BELOW everything in flight
 * and above the statusless rows. Keeping it in the top merge band is
 * the entire bug: the human scans the top of each section for what to
 * merge, and a gated branch sitting there is a branch that gets
 * merged. It outranks `todo` because it is finished work that will
 * need merging once the world moves, and it sits under `working`
 * because a working row will produce news on its own and this one will
 * not.
 */
export const BLOCKED_RANK = 5;

export const NO_STATUS_RANK = 6;
/** Merged/gone rows sink below everything, whatever they last asserted. */
export const LANDED_RANK = 10;

export function workStateRank(state: WorkState | null | undefined): number {
  return state ? RANK[state] : NO_STATUS_RANK;
}

/**
 * Rank for a whole record, which is what callers with one in hand
 * should use: identical to `workStateRank` except that a gated `ready`
 * drops to `BLOCKED_RANK`. `workStateRank` stays for the callers that
 * only ever have a bare state (the section summary's histogram).
 */
export function workRecordRank(record: WorkStatusRecord | null | undefined): number {
  if (!record) return NO_STATUS_RANK;
  if (!isGated(record)) return RANK[record.state];
  return record.state === "todo" ? GATED_TODO_RANK : BLOCKED_RANK;
}

/**
 * States a gate can decorate, and what it means on each. The field
 * always names an external condition that must clear; the STATE supplies
 * the verb:
 *
 *  - `ready` + gate — finished, but do not MERGE yet.
 *  - `todo`  + gate — deliberately not STARTED yet.
 *
 * The second arrived from the fleet, and it is the more common one: a
 * manager holding fourteen worktrees on an unlanded credentials file
 * had nowhere to say so, so the policy lived in section NAMES it had
 * invented ("Held: prompt written, deliberately not started") plus its
 * own memory of which gate applied to which row and what would clear
 * it. A section name tells a fresh reader that something is held; it
 * cannot say what would unhold it, and a compaction between two ticks
 * loses the rest.
 *
 * Nothing else takes one. The in-flight states (`working`, `review`,
 * `needs-testing`) describe work in motion, where "blocked" already has
 * a word — `needs-human` — and `dropped` is not waiting on anything.
 */
const GATED_STATES: readonly WorkState[] = ["ready", "todo"];

/**
 * Whether a record is held back by an external gate. One predicate so
 * the dot, the banner, the sort, the CLI and the automation gate can't
 * drift on what "blocked" means — and so a gate hand-written onto a
 * state that can't carry one (state.json is editable) is inert
 * everywhere rather than inert in some places.
 */
export function isGated(record: WorkStatusRecord | null | undefined): boolean {
  return (
    !!record && !!record.blockedOn && GATED_STATES.includes(record.state)
  );
}

/**
 * The effective state the dot renders: the asserted record, except a
 * session actively waiting on input upgrades to `needs-human` — the
 * dot must never look calm while the agent sits blocked on a prompt.
 * That is the ONLY derived override; everything else (conflicts, CI,
 * merged) already has its own glyph and would only muddy the dot's
 * meaning. Returns null when there is nothing to show (no assertion,
 * no ask).
 */
export function effectiveWorkState(
  record: WorkStatusRecord | null | undefined,
  sessionState: DerivedState | undefined,
  landed = false,
): { state: WorkState; derived: boolean; blocked: boolean } | null {
  if (sessionState === "asking") {
    return { state: "needs-human", derived: true, blocked: false };
  }
  // A landed branch that still owes a deployed-environment check reads
  // as `needs-testing`, which is precisely what it is: built, manual
  // verification pending, and the AGENT owns that testing. Derived at
  // render time rather than written at merge time — a status is what
  // its owner asserted, and there is no process guaranteed to be
  // running at the moment a branch lands to do the writing.
  if (owesPostMergeVerification(record, landed)) {
    return { state: "needs-testing", derived: true, blocked: false };
  }
  if (record) {
    return { state: record.state, derived: false, blocked: isGated(record) };
  }
  return null;
}

/**
 * Is a deployed-environment verification still outstanding on this row?
 * True only once the branch has LANDED — before that the obligation
 * exists but nothing can act on it, and treating it as live would drag
 * a mergeable row out of the merge band, which is the one thing
 * `verifyAfterMerge` must never do.
 *
 * `verified` is the discharge. `dropped` voids it, because a branch
 * that will never land has nothing deployed to check — that leg only
 * fires on a row asserted `dropped` after landing anyway, which is
 * contradictory, and reading a contradiction as "still owed" would
 * strand the row forever.
 */
export function owesPostMergeVerification(
  record: WorkStatusRecord | null | undefined,
  landed: boolean,
): boolean {
  if (!record || !landed || !record.verifyAfterMerge) return false;
  return record.state !== "verified" && record.state !== "dropped";
}

/**
 * How long an outstanding post-merge verification may sit before it is
 * shouting rather than waiting. Deliberately short: the failure this
 * whole field exists to prevent is a check nobody runs, and a row that
 * looks covered while nothing happens is worse than one that was never
 * tracked. Two days spans a weekend edge without spanning a week.
 */
export const VERIFY_OVERDUE_DAYS = 2;

/**
 * An outstanding verification that has aged past the window. Measured
 * from the ASSERTION (`at`), not from the merge: wt has no merge
 * timestamp for a branch it did not watch land, and the assertion is
 * always the earlier of the two, so this fails toward shouting sooner
 * rather than later — the right direction for a reminder.
 *
 * Unparsable `at` reads as overdue for the same reason: a record whose
 * age cannot be established must not be the one that goes quiet.
 */
export function verificationOverdue(
  record: WorkStatusRecord | null | undefined,
  landed: boolean,
  nowMs: number = Date.now(),
  days: number = VERIFY_OVERDUE_DAYS,
): boolean {
  if (!owesPostMergeVerification(record, landed)) return false;
  const at = Date.parse(record!.at);
  if (Number.isNaN(at)) return true;
  return nowMs - at >= days * 86_400_000;
}

/**
 * A status assertion is STALE once commits land after it: the record
 * describes an older tree, so its badge can't be trusted at a glance.
 * `lastCommitMs` is whatever commit signal the caller already has (the
 * TUI's gitActivity field); null/unknown never reads as stale — "can't
 * tell" must not dim a trustworthy dot.
 */
export function isWorkStatusStale(
  record: WorkStatusRecord | null | undefined,
  lastCommitMs: number | null | undefined,
): boolean {
  if (!record || lastCommitMs == null) return false;
  const asserted = Date.parse(record.at);
  return !Number.isNaN(asserted) && lastCommitMs > asserted;
}

/**
 * Compact "how long ago" label (`3m`, `2h`, `4d`). Mirrors the tone of
 * the lock-age label without importing the locks module (this module
 * stays leaf-level).
 */
export function workAge(at: string, nowMs: number = Date.now()): string | null {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/**
 * Sanitize free-text that agents attach to a status (`-m` notes).
 * Notes travel far — terminal stdout, the TUI, log lines, macOS
 * notifications via osascript — and the writer is an agent whose
 * context may contain untrusted text, so raw escape sequences are a
 * real injection vector (terminal title spoofing, OSC tricks) and
 * control bytes break AppleScript string literals. Strip ANSI
 * CSI/OSC sequences and every control char, collapse whitespace.
 * Applied at WRITE time (CLI) and defensively at parse time, so no
 * consumer needs its own guard.
 */
export function sanitizeWorkNote(s: string): string {
  return (
    s
      // OSC sequences: ESC ] ... terminated by BEL or ESC-backslash.
      .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
      // CSI sequences (ESC [ params final) and any other ESC-led pair.
      .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]?/g, "")
      .replace(/\u001b[()][A-Za-z0-9]/g, "")
      .replace(/\u001b./g, "")
      // Remaining C0/C1 control chars (bare BEL, CR, backspace, ...).
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * The shared `(risk: X) — note` suffix every surface appends after its
 * own lead word (CLI confirmation, automation fire detail, attention
 * narration). One implementation so a format tweak or a new field
 * can't drift across them.
 */
export function workStatusSuffix(record: {
  state?: WorkState;
  risk?: WorkRisk;
  note?: string;
  blockedOn?: string;
  verifyAfterMerge?: string;
}): string {
  const risk = record.risk ? ` (risk: ${record.risk})` : "";
  // Ahead of the note, and unconditionally: every surface that renders
  // a status inherits this, and the gate losing a race with a long note
  // for the last cells of a truncated line is the original failure in
  // miniature.
  const gate = record.blockedOn ? ` [blocked on: ${record.blockedOn}]` : "";
  // Same reasoning as the gate, one notch quieter: it changes what the
  // reader must eventually DO with the row, so it cannot lose a race
  // with a long note for the last cells of a truncated line.
  const verify = record.verifyAfterMerge
    ? ` [verify after merge: ${record.verifyAfterMerge}]`
    : "";
  const note = record.note ? ` — ${record.note}` : "";
  return `${risk}${gate}${verify}${note}`;
}

/**
 * Tolerant parse of a persisted record (wtstate is hand-editable and
 * versions drift). Unknown states drop the whole record — a stale
 * vocabulary word from a future/older wt should vanish, not crash or
 * render as gibberish.
 */
export function parseWorkStatus(raw: unknown): WorkStatusRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Partial<WorkStatusRecord>;
  if (typeof rec.state !== "string" || !(WORK_STATES as readonly string[]).includes(rec.state)) {
    return null;
  }
  if (typeof rec.at !== "string" || rec.at.trim() === "") return null;
  const out: WorkStatusRecord = { state: rec.state as WorkState, at: rec.at };
  if (typeof rec.note === "string") {
    // Defense in depth: the CLI sanitizes on write, but state.json is
    // hand-editable and other writers may exist.
    const note = sanitizeWorkNote(rec.note);
    if (note !== "") out.note = note;
  }
  if (
    typeof rec.risk === "string" &&
    (WORK_RISKS as readonly string[]).includes(rec.risk)
  ) {
    out.risk = rec.risk as WorkRisk;
  }
  if (typeof rec.blockedOn === "string") {
    // Same sanitization as the note — it travels to the same places.
    // Kept regardless of state; `isGated` is the one place that
    // decides a gate is meaningful, so a hand-edited stray is inert
    // rather than half-honoured.
    const gate = sanitizeWorkNote(rec.blockedOn);
    if (gate !== "") out.blockedOn = gate;
  }
  if (typeof rec.verifyAfterMerge === "string") {
    // Same sanitization as the note and the gate — it travels to the
    // same places. Kept whatever the state says: unlike a gate, this
    // one legitimately outlives the assertion that created it, and
    // `owesPostMergeVerification` is the single place that decides
    // whether it is still owed.
    const verify = sanitizeWorkNote(rec.verifyAfterMerge);
    if (verify !== "") out.verifyAfterMerge = verify;
  }
  if (typeof rec.sha === "string" && rec.sha.trim() !== "") out.sha = rec.sha;
  if (typeof rec.by === "string" && rec.by.trim() !== "") out.by = rec.by.trim();
  return out;
}
