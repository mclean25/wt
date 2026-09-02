import type { KeyEvent } from "@opentui/core";

import { writeClipboardPromise } from "../../core/macos.ts";
import {
  formatCapturedError,
  latestCapturedError,
  markErrorsSeen,
} from "../error-store.ts";
import { cancelErrorInvestigate } from "../flows/error-report.ts";
import { handleOverlayScrollKey } from "../scrollbox.tsx";
import type { Modal } from "../modal-state.ts";
import type { SimpleModalContext } from "./ctx.ts";

/**
 * Keys for the auto-popping error overlay. Scrolling goes through the
 * shared overlay keymap (`handleOverlayScrollKey` — j/k, PgUp/PgDn,
 * g/G) so the step size matches every other pane; this only owns the
 * explicit affordances. No trigger re-press leg — the overlay has no
 * opening key (it pops on capture), and the modal UX rules say not to
 * invent one.
 *
 * Returns true unconditionally: while the overlay is up it swallows
 * every key, so a stray letter can't fall through to a destructive
 * normal-mode binding behind it.
 */
export function handleErrorsKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "errors" }>,
  { setModal, toast, doErrorInvestigate, infoColor, warnColor }: SimpleModalContext,
): boolean {
  if (handleOverlayScrollKey(k)) return true;
  // Send the newest error to the wt-source session and enter it. The
  // flow owns closing the overlay (only once the paste landed).
  if (k.name === "i" && !k.ctrl && !k.meta) {
    if (modal.inject.kind !== "sending") doErrorInvestigate();
    return true;
  }
  if (k.name === "y" && !k.ctrl && !k.meta) {
    const captured = latestCapturedError();
    if (!captured) {
      toast("no captured error", warnColor, 1500);
      return true;
    }
    try {
      writeClipboardPromise(formatCapturedError(captured));
      toast("copied error", infoColor, 1500);
    } catch (err) {
      toast(
        `copy failed: ${err instanceof Error ? err.message : String(err)}`,
        warnColor,
        3000,
      );
    }
    return true;
  }
  if (
    k.name === "escape" ||
    k.name === "q" ||
    (k.ctrl && k.name === "c")
  ) {
    // Tell an in-flight inject to stop short of the terminal handoff,
    // and acknowledge everything shown so only a NEW error re-pops.
    cancelErrorInvestigate();
    markErrorsSeen();
    setModal(null);
  }
  return true;
}
