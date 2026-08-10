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
 *                      high-value impacts note (end users, coworker
 *                      workflows, costs). The human merges — never
 *                      the agent.
 *
 * There is no asserted `done`: merged/gone is derived from git and
 * outranks anything asserted.
 */
export const WORK_STATES = [
  "todo",
  "working",
  "review",
  "needs-testing",
  "needs-human",
  "ready",
] as const;

export type WorkState = (typeof WORK_STATES)[number];

export const WORK_RISKS = ["low", "medium", "high"] as const;
export type WorkRisk = (typeof WORK_RISKS)[number];

/**
 * One asserted status. `at` is an ISO timestamp; `sha` is the
 * worktree's HEAD when asserted, so the UI can flag a status that
 * predates newer commits ("stale") without ever guessing. `risk` is
 * only meaningful on `ready`; `note` is required by the CLI for
 * `needs-human` (what exactly is needed) and for medium/high-risk
 * `ready` (the notable impacts).
 */
export type WorkStatusRecord = {
  state: WorkState;
  note?: string;
  risk?: WorkRisk;
  at: string;
  sha?: string;
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
  todo: 6,
};

export const NO_STATUS_RANK = 5;
/** Merged/gone rows sink below everything, whatever they last asserted. */
export const LANDED_RANK = 7;

export function workStateRank(state: WorkState | null | undefined): number {
  return state ? RANK[state] : NO_STATUS_RANK;
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
): { state: WorkState; derived: boolean } | null {
  if (sessionState === "asking") return { state: "needs-human", derived: true };
  if (record) return { state: record.state, derived: false };
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
  risk?: WorkRisk;
  note?: string;
}): string {
  const risk = record.risk ? ` (risk: ${record.risk})` : "";
  const note = record.note ? ` — ${record.note}` : "";
  return `${risk}${note}`;
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
  if (typeof rec.sha === "string" && rec.sha.trim() !== "") out.sha = rec.sha;
  return out;
}
