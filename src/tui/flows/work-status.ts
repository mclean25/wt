/**
 * Work-status picker flow (`u`): assert / clear the selected
 * worktree's work status by hand — the human leg of `wt status`.
 *
 * Deliberately more lenient than the agent-facing CLI: no forced
 * `--risk`, no required notes. The CLI's rules exist to make AGENT
 * assertions trustworthy; the human picking `ready` from the list IS
 * the judgment the rules try to extract. Notes/risk set by an agent
 * earlier are dropped on re-assert (the record describes one moment,
 * not a merge of two authors).
 */
import type { WorkState, WorkStatusRecord } from "../../core/work-status.ts";
import { effectiveWorkState, WORK_STATES } from "../../core/work-status.ts";
import type { Modal, StatusPickerItem } from "../modal-state.ts";
import type { FooterMode } from "../panels/footer.tsx";
import { markSelfStatusWrite } from "../../state/self-writes.ts";
import type { WorktreeRow } from "../hooks/useWorktreeRows.ts";
import { emptyEdit, makeEdit } from "../text-edit.tsx";
import { theme } from "../theme.ts";
import { Data, Effect } from "effect";

class WorkStatusFlowError extends Data.TaggedError("WorkStatusFlowError")<{
  cause: unknown;
}> {}

export type { StatusPickerItem };

/**
 * The `verifyAfterMerge` a new pick inherits from the record it
 * replaces, if any. Exported for the same reason it exists: two write
 * paths in this file, and an obligation that survives one but not the
 * other would be worse than one that survives neither.
 */
export function carriedVerify(
  prev: WorkStatusRecord | null | undefined,
  next: WorkState,
): { verifyAfterMerge?: string } {
  if (!prev?.verifyAfterMerge) return {};
  if (next === "verified" || next === "dropped") return {};
  return { verifyAfterMerge: prev.verifyAfterMerge };
}

/**
 * What a footer-collecting pick parked while the human types. The
 * obligation is FROZEN here at pick time rather than re-read at commit
 * time: typing is human-paced and the selection can move under it, and
 * re-reading whatever row is current by then would either carry another
 * row's obligation or silently drop this one.
 *
 * `field` says where the typed line lands. Both rows collect one line
 * into the same footer; only the destination and the empty-line
 * semantics differ (see `statusTextRecord`).
 */
export type PendingStatusText = {
  slug: string;
  state: WorkState;
  field: "note" | "verifyAfterMerge";
  verifyAfterMerge?: string;
};

/**
 * Direct chords inside the `u` picker (`u t` → todo, `u y` → ready).
 * `x` clears, matching the picker's clear row. Letters avoid the
 * picker's reserved keys (j/k/u/q/x, digits); the two `needs-*` states
 * take their distinguishing word's initial, mirroring the CLI's
 * `nt`/`nh` aliases.
 */
export const WORK_STATE_CHORDS: Record<WorkState, string> = {
  todo: "t",
  working: "w",
  review: "r",
  "needs-testing": "n",
  "needs-human": "h",
  ready: "y",
  // `v` for verified; `d` was already dropped's and the two terminal
  // states are the pair most worth keeping distinguishable.
  verified: "v",
  dropped: "d",
};

/** `ready + verify After merge`. `v` and `y` were both already spoken for. */
export const VERIFY_CHORD = "a";

/**
 * What the verify row's dot shows. NOT `ready`'s green: a row owing a
 * post-merge check renders as `needs-testing` on the board the moment
 * it lands, and the picker is the legend for those glyphs — two `ready`
 * rows wearing the same dot would also hide the only difference between
 * them. Run through the real derivation on a throwaway record rather
 * than hardcoded, so the picker can't promise a colour the list stopped
 * using. Landed, because that is when the obligation is visible at all.
 */
const VERIFY_GLYPH_STATE: WorkState =
  effectiveWorkState(
    { state: "ready", at: "", verifyAfterMerge: "probe" },
    undefined,
    true,
  )?.state ?? "ready";

/**
 * The `u` picker's rows for a record. Pure, so the ready/ready+verify
 * split and the "(current)" marking are testable without a TUI.
 *
 * `ready` appears TWICE on purpose. A post-merge verification is not a
 * shade of `ready` — it is a standing obligation that outlives the
 * merge, keeps the row out of the `c` sweep until someone asserts
 * `verified`, and needs steps written down for whoever runs it. That is
 * a different thing to assert, so it gets a row of its own rather than
 * hiding behind a modifier key nobody would find. Exactly one of the
 * pair ever reads "(current)".
 */
export function statusPickerItems(
  record: WorkStatusRecord | null | undefined,
): StatusPickerItem[] {
  const recorded = record?.state ?? null;
  const owed = Boolean(record?.verifyAfterMerge);
  const items: StatusPickerItem[] = [];
  for (const state of WORK_STATES) {
    const isCurrent = recorded === state && !(state === "ready" && owed);
    items.push({
      label: isCurrent ? `${state} (current)` : state,
      state,
      chord: WORK_STATE_CHORDS[state],
      ...(isCurrent ? { current: true } : {}),
    });
    if (state !== "ready") continue;
    const verifyCurrent = recorded === "ready" && owed;
    items.push({
      label: verifyCurrent
        ? "ready + verify after merge (current)"
        : "ready + verify after merge",
      state: "ready",
      chord: VERIFY_CHORD,
      verify: true,
      glyphState: VERIFY_GLYPH_STATE,
      ...(verifyCurrent ? { current: true } : {}),
    });
  }
  items.push({ label: "clear — no status", state: null, chord: "x" });
  return items;
}

/**
 * The record a footer-collected line produces. Pure, because the
 * empty-line semantics differ per field and that difference is the
 * whole reason the verify row exists.
 *
 * A note is optional decoration on the state, so an empty one is just a
 * plain pick and whatever obligation the record carried survives. The
 * verify row is the opposite: its only job is to set that obligation
 * and its input is PRE-FILLED with the current steps, so the box is
 * authoritative — clearing it is how a human takes an obligation back
 * off a branch without claiming `verified`. That is the one place a
 * `verifyAfterMerge` may be dropped without one of its two exits, and
 * it is safe here only because it is neither silent nor inferred: the
 * human is looking at the steps as they delete them, and the toast says
 * what was stored.
 */
export function statusTextRecord(
  pending: PendingStatusText,
  text: string,
  at: string,
): WorkStatusRecord {
  const trimmed = text.trim();
  if (pending.field === "verifyAfterMerge") {
    return {
      state: pending.state,
      at,
      ...(trimmed ? { verifyAfterMerge: trimmed } : {}),
    };
  }
  return {
    state: pending.state,
    at,
    ...(trimmed ? { note: trimmed } : {}),
    ...(pending.verifyAfterMerge
      ? { verifyAfterMerge: pending.verifyAfterMerge }
      : {}),
  };
}

type WorkStatusFlowsCtx = {
  current: WorktreeRow | undefined;
  setModal: (m: Modal | null) => void;
  toast: (message: string, color?: string, ms?: number) => void;
  reportActionError: (label: string, err: unknown) => void;
  setWorkStatus: (
    slug: string,
    record: WorkStatusRecord | null,
  ) => Promise<void>;
  setFooter: (f: FooterMode) => void;
  setPendingStatusText: (v: PendingStatusText | null) => void;
  /** Is the slug still a live worktree? Note-typing time is unbounded. */
  isSlugLive: (slug: string) => boolean;
};

export function makeWorkStatusFlows(ctx: WorkStatusFlowsCtx) {
  const {
    current,
    setModal,
    toast,
    reportActionError,
    setWorkStatus,
    setFooter,
    setPendingStatusText,
    isSlugLive,
  } = ctx;

  /**
   * The selected row's record, but only when the selection is still
   * the row being written to. Both write paths take a slug and the
   * modal can outlive a selection change; carrying a neighbour's
   * obligation onto this row would be worse than carrying none.
   */
  function workFor(slug: string): WorkStatusRecord | undefined {
    return current?.wt.slug === slug ? (current.work ?? undefined) : undefined;
  }

  function openStatusPicker(): void {
    if (!current) return;
    if (current.archived) {
      toast("archived rows don't track a work status", theme.fgDim, 2000);
      return;
    }
    const items = statusPickerItems(current.work);
    const idx = items.findIndex((it) => it.current);
    setModal({
      kind: "statusPicker",
      slug: current.wt.slug,
      items,
      index: Math.max(0, idx),
    });
  }

  function commitStatusPick(item: StatusPickerItem, slug: string): void {
    // The verify row never writes from here — it has a line to collect
    // first, on every path that reaches it (chord, Enter, digit).
    if (item.verify && item.state) {
      beginVerifySteps(item.state, slug);
      return;
    }
    setModal(null);
    // A fresh record, so a pick DROPS whatever the previous assertion
    // carried — note, risk, and any `--blocked-on` gate. Deliberate and
    // unchanged by the gate's arrival: the picker is the human's lenient
    // path, the human is the merge authority, and "I am asserting this
    // state now" is exactly what a gate should yield to. Agents clear a
    // gate the narrow way instead (`wt status --unblock`, which keeps
    // the state, risk, note and timestamp).
    const record: WorkStatusRecord | null = item.state
      ? {
          state: item.state,
          at: new Date().toISOString(),
          // Carried, not dropped — the one exception to the sentence
          // above, and for the same reason the CLI carries it: this
          // describes the BRANCH, not the assertion, and letting a
          // stray pick release a merged worktree back to the sweep
          // would lose the obligation with nothing printed anywhere.
          // `verified` and `dropped` are its two honest exits, here as
          // there.
          ...carriedVerify(workFor(slug), item.state),
        }
      : null;
    // The toast below is this pick's ack; mute the narration's default
    // toast for exactly the write we're about to make (the attention
    // line still lands in the pane feed). A clear writes no record, so
    // there's nothing to narrate or mute.
    if (record) markSelfStatusWrite(slug, record.at);
    Effect.runFork(
      Effect.tryPromise({
        try: () => setWorkStatus(slug, record),
        catch: (cause) => new WorkStatusFlowError({ cause }),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            toast(
              record ? `${slug} → ${record.state}` : `${slug} status cleared`,
              theme.info,
              2000,
            );
          }),
        ),
        Effect.catchAll((error) =>
          Effect.sync(() => reportActionError("set status", error.cause)),
        ),
      ),
    );
  }

  /**
   * The `ready + verify after merge` row: hand off to the footer to
   * collect the STEPS. Pre-filled with whatever the row already owes,
   * so the same row doubles as the amend path — Enter unchanged is a
   * no-op on the field, and the box shows the truth either way.
   */
  function beginVerifySteps(state: WorkState, slug: string): void {
    setModal(null);
    setPendingStatusText({ slug, state, field: "verifyAfterMerge" });
    setFooter({
      kind: "input",
      prompt: `${slug} → ${state} · verify after merge: `,
      edit: makeEdit(workFor(slug)?.verifyAfterMerge ?? ""),
      purpose: "status-text",
    });
  }

  /**
   * `m` in the status picker: pick the highlighted state AND attach a
   * note — the fast path (chords / Enter) never pays for this. Closes
   * the picker and hands off to the footer input; the actual write
   * happens in `commitStatusText` once the line is typed. Esc there
   * cancels the whole pick (no write), matching "the record describes
   * one moment" — there's no half-committed state to clean up.
   */
  function beginStatusNote(item: StatusPickerItem, slug: string): void {
    if (!item.state) {
      toast("clear takes no note", theme.fgDim, 1500);
      return;
    }
    // `m` on the verify row collects its steps rather than a note —
    // same gesture, and a prompt saying "note" that stored steps (or
    // dropped them) would be the worse of the two surprises.
    if (item.verify) {
      beginVerifySteps(item.state, slug);
      return;
    }
    setModal(null);
    setPendingStatusText({
      slug,
      state: item.state,
      field: "note",
      ...carriedVerify(workFor(slug), item.state),
    });
    setFooter({
      kind: "input",
      prompt: `${slug} → ${item.state} · note: `,
      edit: emptyEdit,
      purpose: "status-text",
    });
  }

  /** Footer-input Enter for a pending `m` / verify pick. */
  function commitStatusText(pending: PendingStatusText, text: string): void {
    // The line took human-paced time to type; the worktree can be gone
    // by now (destroy, clean, another instance). Writing anyway would
    // resurrect a ghost wtstate entry until the next boot reap.
    if (!isSlugLive(pending.slug)) {
      toast(`${pending.slug} is gone — status not written`, theme.warn, 2500);
      return;
    }
    const record = statusTextRecord(pending, text, new Date().toISOString());
    markSelfStatusWrite(pending.slug, record.at);
    Effect.runFork(
      Effect.tryPromise({
        try: () => setWorkStatus(pending.slug, record),
        catch: (cause) => new WorkStatusFlowError({ cause }),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (pending.field !== "verifyAfterMerge") {
              toast(`${pending.slug} → ${record.state}`, theme.info, 2000);
              return;
            }
            // Say which happened. An empty box on the verify row is a real
            // pick with no obligation attached, and the row it just wrote
            // is one the `c` sweep may take — the difference is invisible
            // on the board until the branch lands, so it gets said here.
            if (record.verifyAfterMerge) {
              toast(
                `${pending.slug} → ${record.state} · verification owed`,
                theme.info,
                2000,
              );
            } else {
              toast(
                `${pending.slug} → ${record.state} — no steps, nothing held back`,
                theme.warn,
                3000,
              );
            }
          }),
        ),
        Effect.catchAll((error) =>
          Effect.sync(() => reportActionError("set status", error.cause)),
        ),
      ),
    );
  }

  return {
    openStatusPicker,
    commitStatusPick,
    beginStatusNote,
    commitStatusText,
  };
}
