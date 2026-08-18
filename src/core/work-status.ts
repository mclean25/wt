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
const RANK: Record<WorkState, number> = {
  ready: 0,
  "needs-human": 1,
  "needs-testing": 2,
  review: 3,
  working: 4,
  todo: 7,
  // Will never land: below even todo — future work outranks no work.
  dropped: 8,
};

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
export const LANDED_RANK = 9;

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
  return isBlockedReady(record) ? BLOCKED_RANK : RANK[record.state];
}

/**
 * Whether a record is a `ready` held back by an external gate. One
 * predicate so the dot, the banner, the sort, the CLI and the
 * automation gate can't drift on what "blocked" means — and so a gate
 * hand-written onto a non-`ready` record (state.json is editable) is
 * inert everywhere rather than inert in some places.
 */
export function isBlockedReady(
  record: WorkStatusRecord | null | undefined,
): boolean {
  return !!record && record.state === "ready" && !!record.blockedOn;
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
): { state: WorkState; derived: boolean; blocked: boolean } | null {
  if (sessionState === "asking") {
    return { state: "needs-human", derived: true, blocked: false };
  }
  if (record) {
    return { state: record.state, derived: false, blocked: isBlockedReady(record) };
  }
  return null;
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
}): string {
  const risk = record.risk ? ` (risk: ${record.risk})` : "";
  // Ahead of the note, and unconditionally: every surface that renders
  // a status inherits this, and the gate losing a race with a long note
  // for the last cells of a truncated line is the original failure in
  // miniature.
  const gate = record.blockedOn ? ` [blocked on: ${record.blockedOn}]` : "";
  const note = record.note ? ` — ${record.note}` : "";
  return `${risk}${gate}${note}`;
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
    // Kept regardless of state; `isBlockedReady` is the one place that
    // decides a gate is meaningful, so a hand-edited stray is inert
    // rather than half-honoured.
    const gate = sanitizeWorkNote(rec.blockedOn);
    if (gate !== "") out.blockedOn = gate;
  }
  if (typeof rec.sha === "string" && rec.sha.trim() !== "") out.sha = rec.sha;
  if (typeof rec.by === "string" && rec.by.trim() !== "") out.by = rec.by.trim();
  return out;
}
