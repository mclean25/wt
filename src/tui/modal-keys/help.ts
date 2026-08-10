import type { KeyEvent } from "@opentui/core";

import { printableText } from "../app-helpers.ts";
import type { Modal } from "../modal-state.ts";
import { applyEditKey, emptyEdit, insertText } from "../text-edit.tsx";
import type { SimpleModalContext } from "./ctx.ts";

export function handleHelpKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "help" }>,
  { setModal }: SimpleModalContext,
): boolean {
  if (modal.searching) {
    if (k.ctrl && k.name === "c") {
      setModal(null);
      return true;
    }
    if (k.name === "escape") {
      setModal({ ...modal, searching: false, query: emptyEdit });
      return true;
    }
    if (k.name === "return") {
      setModal({ ...modal, searching: false });
      return true;
    }
    // Backspace on empty query leaves search mode.
    if (k.name === "backspace" && modal.query.value.length === 0) {
      setModal({ ...modal, searching: false });
      return true;
    }
    // Cursor movement / deletion — shared editor logic.
    const edited = applyEditKey(k, modal.query);
    if (edited) {
      setModal({ ...modal, query: edited });
      return true;
    }
    const text = printableText(k.sequence);
    if (text) setModal({ ...modal, query: insertText(modal.query, text) });
    return true;
  }
  if (k.sequence === "/") {
    setModal({ ...modal, searching: true });
    return true;
  }
  if (k.name === "escape" && modal.query.value) {
    setModal({ ...modal, query: emptyEdit });
    return true;
  }
  if (
    k.name === "escape" ||
    k.sequence === "?" ||
    k.name === "q" ||
    (k.ctrl && k.name === "c")
  ) {
    setModal(null);
  }
  return true;
}
