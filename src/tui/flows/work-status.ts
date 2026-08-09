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
import { markSelfStatusWrite } from "../hooks/useWorkStatusEvents.ts";
import type { WorktreeRow } from "../hooks/useWorktreeRows.ts";
import { theme } from "../theme.ts";

export type StatusPickerItem = { label: string; state: WorkState | null };

type WorkStatusFlowsCtx = {
  current: WorktreeRow | undefined;
  setModal: (m: Modal | null) => void;
  toast: (message: string, color?: string, ms?: number) => void;
  reportActionError: (label: string, err: unknown) => void;
  setWorkStatus: (slug: string, record: WorkStatusRecord | null) => Promise<void>;
};

export function makeWorkStatusFlows(ctx: WorkStatusFlowsCtx) {
  const { current, setModal, toast, reportActionError, setWorkStatus } = ctx;

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
    // toast for the write we're about to make (the attention line
    // still lands in the pane feed).
    markSelfStatusWrite(slug);
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

  return { openStatusPicker, commitStatusPick };
}
