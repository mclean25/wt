import type { KeyEvent } from "@opentui/core";

import { operationErrors } from "../../core/errors.ts";
import { forkReported } from "../effect-boundary.ts";
import type { Modal } from "../modal-state.ts";
import type { SimpleModalContext } from "./ctx.ts";
import { handleListPickerKey } from "./list-picker.ts";

const io = operationErrors("modal-keys/reviewers");

export function handleReviewerPickerKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "reviewerPicker" }>,
  { setModal, submitReviewerPicker, reportActionError }: SimpleModalContext,
): boolean {
  // Multi-select toggle stays a pre-check (space isn't a letter chord).
  if (k.name === "space" || k.sequence === " ") {
    const item = modal.items[modal.index];
    if (item) {
      const next = new Set(modal.checked);
      if (next.has(item.key)) next.delete(item.key);
      else next.add(item.key);
      setModal({ ...modal, checked: next });
    }
    return true;
  }
  return handleListPickerKey(k, {
    count: modal.items.length,
    index: modal.index,
    onMove: (next) => setModal({ ...modal, index: next }),
    // Enter / `v v` submit the checked SET — digits would ambiguously
    // toggle vs. submit, so they're off for multi-select.
    onCommit: () =>
      forkReported(
        io.promise("reviewer picker", () => submitReviewerPicker(modal)),
        (error) => reportActionError("reviewer picker", error),
      ),
    onCancel: () => setModal(null),
    confirm: ["v"],
    digits: false,
  });
}
