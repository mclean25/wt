import type { Dispatch, SetStateAction } from "react";
import type { KeyEvent } from "@opentui/core";

import type { ActionDef } from "../../core/actions.ts";
import type { HarnessId } from "../../core/harness/index.ts";
import type { WorkState } from "../../core/work-status.ts";
import type { Output } from "../../core/outputs.ts";
import type { RemovedWorktree } from "../../core/wtstate.ts";
import type { Modal } from "../modal-state.ts";
import type { PickerItem } from "../panels/action-picker.tsx";
import type { PickerRow } from "../panels/sessions-picker.tsx";
import type { SectionPickerItem } from "../panels/section-picker.tsx";
import type { WorktreeRow } from "../hooks/useWorktreeRows.ts";
import type { SelectedSection } from "../hooks/useVisualItems.ts";
import type { RemoteConfig } from "../../core/config.ts";

export type SimpleModalContext = {
  setModal: Dispatch<SetStateAction<Modal | null>>;
  current: WorktreeRow | undefined;
  refreshTmuxSessions: () => Promise<unknown>;
  /** Force a fresh perf sample (`r` inside the `P` overlay). */
  refreshPerf: () => Promise<unknown>;
  /** Send the current perf snapshot to the wt session, then enter it. */
  doPerfInvestigate: () => void;
  /** Send the newest captured error to the wt session, then enter it. */
  doErrorInvestigate: () => void;
  commitBasePick: (
    item: { label: string; branch: string | null },
    slug: string,
  ) => void;
  commitStatusPick: (
    item: { label: string; state: WorkState | null },
    slug: string,
  ) => void;
  /** `m` in the status picker: pick highlight + collect a note. */
  beginStatusNote: (
    item: { label: string; state: WorkState | null },
    slug: string,
  ) => void;
  /** Set when the cursor is on a folded section header — `y` yanks the
   *  batch (name, member slugs) instead of a row. */
  selectedSection: SelectedSection | undefined;
  doYank: (slug: string, label: string, value: string | null) => void;
  doClean: () => void;
  doRemove: (slug: string, opts?: { force?: boolean }) => Promise<void>;
  doRemoteRemove: (
    remote: RemoteConfig,
    slug: string,
    opts?: { force?: boolean },
  ) => Promise<void>;
  doAutoMerge: (slug: string, mode: "enable" | "disable") => Promise<void>;
  doMarkReady: (slug: string) => Promise<void>;
  doShipPr: (slug: string) => Promise<void>;
  doCheckoutReview: (branch: string) => Promise<void>;
  doRestoreRemoved: (entry: RemovedWorktree) => Promise<void>;
  clearAll: () => Promise<void>;
  submitReviewerPicker: (
    picker: Extract<Modal, { kind: "reviewerPicker" }>,
  ) => Promise<void>;
  commitSectionPick: (item: SectionPickerItem, slug: string) => void;
  consumePrTargetChord: (k: KeyEvent) => boolean;
  setLastMoveTarget: Dispatch<SetStateAction<string | null>>;
  setSection: (slug: string, section: string | null) => Promise<unknown>;
  /** Re-aim the cursor off rows that are leaving their slot — see
   *  `cursorSuccessor`. */
  advanceCursorPast: (keys: readonly string[]) => void;
  toast: (message: string, color?: string, ms?: number) => void;
  reportActionError: (label: string, err: unknown) => void;
  visibleOutputs: readonly Output[];
  currentSlug: string | undefined;
  setFocus: (slug: string | null, patch: { focused?: string | null }) => void;
  rows: readonly WorktreeRow[];
  buildActionPickerItems: (slug: string) => PickerItem[];
  /** `M` palette items — fleet builtins + row-scoped manager entries. */
  buildManagerPickerItems: (rowSlug: string | null) => PickerItem[];
  /** Slot-palette items (`<` / `>` / `\`) — uniform across slots. */
  buildSlotPickerItems: () => PickerItem[];
  canPickAction: (item: PickerItem) => boolean;
  // Return is deliberately loose: callers here fire-and-forget, and the
  // real impl returns a `LaunchOutcome` the automations engine consumes.
  launchAction: (
    slug: string,
    def: ActionDef | null,
    extras: string,
    arg?: string,
  ) => void | Promise<unknown>;
  /** Slot-scoped palette delivery (no row context, no [re:] prefix). */
  launchSlotCommand: (
    slotSlug: string,
    def: ActionDef | null,
    extras: string,
  ) => void | Promise<unknown>;
  doSpawnNamedClaudeSession: (slug: string, name: string) => void;
  doEnterHarnessSession: (
    slug: string,
    harnessId: HarnessId,
    opts: Record<string, unknown>,
  ) => void;
  pickerRows: ReadonlyArray<PickerRow>;
  doKillClaudeSession: (slug: string, name: string | null) => void;
  refreshHarnessSessions: (slug: string) => Promise<unknown>;
  refreshClaudeSummaries: (slug: string) => Promise<unknown>;
  infoColor: string;
  fgDimColor: string;
  warnColor: string;
  logInfo: (message: string) => void;
  logWarn: (message: string) => void;
  logErr: (message: string) => void;
};
