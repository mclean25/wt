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
import { WORK_STATES } from "../../core/work-status.ts";
import type { Modal } from "../modal-state.ts";
import type { FooterMode } from "../panels/footer.tsx";
import { markSelfStatusWrite } from "../../state/self-writes.ts";
import type { WorktreeRow } from "../hooks/useWorktreeRows.ts";
import { emptyEdit } from "../text-edit.tsx";
import { theme } from "../theme.ts";

export type StatusPickerItem = { label: string; state: WorkState | null };

/** What `m` in the status picker parked while the footer collects a note. */
export type PendingStatusNote = { slug: string; state: WorkState };

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
};

type WorkStatusFlowsCtx = {
  current: WorktreeRow | undefined;
  setModal: (m: Modal | null) => void;
  toast: (message: string, color?: string, ms?: number) => void;
  reportActionError: (label: string, err: unknown) => void;
  setWorkStatus: (slug: string, record: WorkStatusRecord | null) => Promise<void>;
  setFooter: (f: FooterMode) => void;
  setPendingStatusNote: (v: PendingStatusNote | null) => void;
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
    setPendingStatusNote,
    isSlugLive,
  } = ctx;

  function openStatusPicker(): void {
    if (!current) return;
    if (current.archived) {
      toast("archived rows don't track a work status", theme.fgDim, 2000);
      return;
    }
    const recorded = current.work?.state ?? null;
    const items: StatusPickerItem[] = [
      ...WORK_STATES.map((s) => ({
        label: s === recorded ? `${s} (current)` : s,
        state: s as WorkState | null,
      })),
      { label: "clear — no status", state: null },
    ];
    const idx = recorded ? items.findIndex((it) => it.state === recorded) : 0;
    setModal({
      kind: "statusPicker",
      slug: current.wt.slug,
      items,
      index: Math.max(0, idx),
    });
  }

  function commitStatusPick(item: StatusPickerItem, slug: string): void {
    setModal(null);
    const record: WorkStatusRecord | null = item.state
      ? { state: item.state, at: new Date().toISOString() }
      : null;
    // The toast below is this pick's ack; mute the narration's default
    // toast for exactly the write we're about to make (the attention
    // line still lands in the pane feed). A clear writes no record, so
    // there's nothing to narrate or mute.
    if (record) markSelfStatusWrite(slug, record.at);
    setWorkStatus(slug, record).then(
      () => {
        toast(
          record ? `${slug} → ${record.state}` : `${slug} status cleared`,
          theme.info,
          2000,
        );
      },
      (err) => reportActionError("set status", err),
    );
  }

  /**
   * `m` in the status picker: pick the highlighted state AND attach a
   * note — the fast path (chords / Enter) never pays for this. Closes
   * the picker and hands off to the footer input; the actual write
   * happens in `commitStatusWithNote` once the note is typed. Esc there
   * cancels the whole pick (no write), matching "the record describes
   * one moment" — there's no half-committed state to clean up.
   */
  function beginStatusNote(item: StatusPickerItem, slug: string): void {
    if (!item.state) {
      toast("clear takes no note", theme.fgDim, 1500);
      return;
    }
    setModal(null);
    setPendingStatusNote({ slug, state: item.state });
    setFooter({
      kind: "input",
      prompt: `${slug} → ${item.state} · note: `,
      edit: emptyEdit,
      purpose: "status-note",
    });
  }

  /** Footer-input Enter for a pending `m` pick. Empty note = plain pick. */
  function commitStatusWithNote(pending: PendingStatusNote, note: string): void {
    // The note took human-paced time to type; the worktree can be gone
    // by now (destroy, clean, another instance). Writing anyway would
    // resurrect a ghost wtstate entry until the next boot reap.
    if (!isSlugLive(pending.slug)) {
      toast(`${pending.slug} is gone — status not written`, theme.warn, 2500);
      return;
    }
    const trimmed = note.trim();
    const record: WorkStatusRecord = {
      state: pending.state,
      at: new Date().toISOString(),
      ...(trimmed ? { note: trimmed } : {}),
    };
    markSelfStatusWrite(pending.slug, record.at);
    setWorkStatus(pending.slug, record).then(
      () => {
        toast(`${pending.slug} → ${record.state}`, theme.info, 2000);
      },
      (err) => reportActionError("set status", err),
    );
  }

  return { openStatusPicker, commitStatusPick, beginStatusNote, commitStatusWithNote };
}
