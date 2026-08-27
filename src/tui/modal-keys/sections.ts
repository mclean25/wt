import type { KeyEvent } from "@opentui/core";

import { printableText } from "../app-helpers.ts";
import type { Modal } from "../modal-state.ts";
import { applyEditKey, insertText } from "../text-edit.tsx";
import type { SimpleModalContext } from "./ctx.ts";
import { handleListPickerKey } from "./list-picker.ts";

export function handleSectionPickerKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "sectionPicker" }>,
  ctx: SimpleModalContext,
): boolean {
  const {
    setModal,
    consumePrTargetChord,
    commitSectionPick,
  } = ctx;
  if (consumePrTargetChord(k)) {
    setModal(null);
    return true;
  }
  if (modal.newName !== null) {
    if (k.name === "escape") {
      setModal({ ...modal, newName: null });
      return true;
    }
    if (k.ctrl && k.name === "c") {
      setModal(null);
      return true;
    }
    if (k.name === "return") {
      const name = modal.newName.value.trim();
      if (!name) {
        setModal({ ...modal, newName: null });
        return true;
      }
      commitSectionPick({ kind: "section", name }, modal.target);
      return true;
    }
    // Backspace on empty input backs out to the picker list.
    if (k.name === "backspace" && modal.newName.value.length === 0) {
      setModal({ ...modal, newName: null });
      return true;
    }
    // Cursor movement / deletion — shared editor logic.
    const edited = applyEditKey(k, modal.newName);
    if (edited) {
      setModal({ ...modal, newName: edited });
      return true;
    }
    const text = printableText(k.sequence);
    if (text) setModal({ ...modal, newName: insertText(modal.newName, text) });
    return true;
  }
  return handleListPickerKey(k, {
    count: modal.items.length,
    index: modal.index,
    onMove: (next) => setModal({ ...modal, index: next }),
    onCommit: (i) => {
      const item = modal.items[i];
      if (item) commitSectionPick(item, modal.target);
    },
    onCancel: () => setModal(null),
    confirm: ["l"],
    // `n` jumps straight to the "+ new section" affordance.
    chords: {
      n: () => {
        const createIdx = modal.items.findIndex((it) => it.kind === "create");
        if (createIdx >= 0) {
          commitSectionPick(modal.items[createIdx]!, modal.target);
        }
      },
    },
    // Digits pick sections only — the create row keeps its letter.
    digits: (n) => {
      const item = modal.items[n - 1];
      if (item && item.kind !== "create") {
        commitSectionPick(item, modal.target);
      }
    },
  });
}
