import type { KeyEvent } from "@opentui/core";

import type { Modal } from "../modal-state.ts";
import { handleOverlayScrollKey } from "../scrollbox.tsx";
import type { SimpleModalContext } from "./ctx.ts";

/** Keyboard contract for the `! l` dev-log overlay. */
export function handleDevLogsKey(
  k: KeyEvent,
  _modal: Extract<Modal, { kind: "devLogs" }>,
  { setModal }: SimpleModalContext,
): boolean {
  if (handleOverlayScrollKey(k)) return true;
  if (
    k.name === "escape" ||
    k.name === "q" ||
    k.sequence === "l" ||
    (k.ctrl && k.name === "c")
  ) {
    setModal(null);
  }
  return true;
}
