import type { KeyEvent } from "@opentui/core";

import type { Modal } from "../modal-state.ts";
import { previewFocusPatch } from "../picker-preview.ts";
import { WORK_STATE_CHORDS } from "../flows/work-status.ts";
import type { SimpleModalContext } from "./ctx.ts";
import { handleListPickerKey } from "./list-picker.ts";

export function handleBranchPickerKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "branchPicker" }>,
  { setModal }: SimpleModalContext,
): boolean {
  return handleListPickerKey(k, {
    count: modal.items.length,
    index: modal.index,
    onMove: (next) => setModal({ ...modal, index: next }),
    onCommit: (i) => {
      const chosen = modal.items[i];
      if (chosen === undefined) return;
      modal.resolve(chosen);
      setModal(null);
    },
    onCancel: () => {
      modal.resolve(null);
      setModal(null);
    },
  });
}

export function handleBasePickerKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "basePicker" }>,
  { setModal, commitBasePick }: SimpleModalContext,
): boolean {
  return handleListPickerKey(k, {
    count: modal.items.length,
    index: modal.index,
    onMove: (next) => setModal({ ...modal, index: next }),
    onCommit: (i) => {
      const item = modal.items[i];
      if (item) commitBasePick(item, modal.slug);
    },
    onCancel: () => setModal(null),
    confirm: ["b"],
  });
}

export function handleStatusPickerKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "statusPicker" }>,
  { setModal, commitStatusPick }: SimpleModalContext,
): boolean {
  // Every state has a direct chord (`u t` → todo, …, `x` clears) —
  // the letters render dim in the picker rows.
  const chords: Record<string, (index: number) => void> = {};
  for (const item of modal.items) {
    const letter = item.state === null ? "x" : WORK_STATE_CHORDS[item.state];
    chords[letter] = () => commitStatusPick(item, modal.slug);
  }
  return handleListPickerKey(k, {
    count: modal.items.length,
    index: modal.index,
    onMove: (next) => setModal({ ...modal, index: next }),
    onCommit: (i) => {
      const item = modal.items[i];
      if (item) commitStatusPick(item, modal.slug);
    },
    onCancel: () => setModal(null),
    confirm: ["u"],
    chords,
  });
}

export function handleOutputsPickerKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "outputsPicker" }>,
  { setModal, visibleOutputs, currentSlug, setFocus }: SimpleModalContext,
): boolean {
  const commit = (i: number): void => {
    const target = visibleOutputs[i];
    if (target) setFocus(currentSlug ?? null, { focused: target.id });
    setModal(null);
  };
  return handleListPickerKey(k, {
    count: visibleOutputs.length,
    index: modal.index,
    onMove: (next) => {
      setModal({ kind: "outputsPicker", index: next });
      const patch = previewFocusPatch(visibleOutputs[next]?.id ?? null);
      if (patch) setFocus(currentSlug ?? null, patch);
    },
    onCommit: commit,
    onCancel: () => setModal(null),
    confirm: ["'"],
  });
}
