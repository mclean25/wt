import type { KeyEvent } from "@opentui/core";

import { isShiftedLetter } from "../app-helpers.ts";
import { yankItemsFor, type Item } from "../panels/yank.tsx";
import type { Modal } from "../modal-state.ts";
import type { SimpleModalContext } from "./ctx.ts";
import { handleListPickerKey } from "./list-picker.ts";

export function handleYankKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "yank" }>,
  { setModal, current, doYank }: SimpleModalContext,
): boolean {
  if (!current) {
    setModal(null);
    return true;
  }
  const items = yankItemsFor(current);
  const slug = current.wt.slug;
  const commit = (item: Item | undefined): void => {
    if (!item) return;
    setModal(null);
    // Handles the null-value ("nothing to yank") toast itself — see
    // app.tsx's doYank.
    doYank(slug, item.label, item.value);
  };

  // `S` (stage url) and `I` (primary issue) are shifted-letter chords.
  // `handleListPickerKey`'s `chords` option matches via `isPlainLetter`
  // (no-shift guard) so it can't see them — pre-checked here, same as
  // any other picker-specific affordance, before delegating below.
  const shifted = items.find(
    (it) =>
      it.key.length === 1 &&
      it.key !== it.key.toLowerCase() &&
      isShiftedLetter(k, it.key.toLowerCase()),
  );
  if (shifted) {
    commit(shifted);
    return true;
  }

  const chords: Record<string, (index: number) => void> = {};
  for (const item of items) {
    if (item.key === item.key.toLowerCase()) chords[item.key] = () => commit(item);
  }
  return handleListPickerKey(k, {
    count: items.length,
    index: modal.index,
    onMove: (next) => setModal({ ...modal, index: next }),
    onCommit: (i) => commit(items[i]),
    onCancel: () => setModal(null),
    confirm: ["y"],
    chords,
  });
}
