import type { KeyEvent } from "@opentui/core";

import { isShiftedLetter } from "../app-helpers.ts";
import { cancelPerfInvestigate } from "../flows/perf-report.ts";
import { handleOverlayScrollKey } from "../scrollbox.tsx";
import type { Modal } from "../modal-state.ts";
import type { SimpleModalContext } from "./ctx.ts";

/**
 * Keys for the `P` perf overlay. Scrolling goes through the shared
 * overlay keymap (`handleOverlayScrollKey` — j/k, PgUp/PgDn, g/G) so
 * the step size matches every other pane; this only owns the explicit
 * affordances.
 *
 * Returns true unconditionally: while the overlay is up it swallows
 * every key, so a stray letter can't fall through to a destructive
 * normal-mode binding behind it.
 */
export function handlePerfKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "perf" }>,
  { setModal, refreshPerf, doPerfInvestigate }: SimpleModalContext,
): boolean {
  if (handleOverlayScrollKey(k)) return true;
  // Send the snapshot to the wt-source session and enter it. The flow
  // owns closing the overlay — it only does so once the paste has
  // actually landed, so a failure leaves the overlay up with a reason.
  // Ignored while one is already going out: the flow guards this too,
  // but bailing here keeps the "sending" state visibly authoritative.
  if (k.name === "i" && !k.ctrl && !k.meta) {
    if (modal.inject.kind !== "sending") doPerfInvestigate();
    return true;
  }
  if (k.name === "r" && !k.ctrl && !k.meta) {
    void refreshPerf();
    return true;
  }
  if (
    k.name === "escape" ||
    isShiftedLetter(k, "p") ||
    k.name === "q" ||
    (k.ctrl && k.name === "c")
  ) {
    // Tell an in-flight inject to stop short of the terminal handoff.
    cancelPerfInvestigate();
    setModal(null);
  }
  return true;
}
