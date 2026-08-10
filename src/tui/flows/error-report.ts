/**
 * The `i` affordance inside the error overlay: hand the newest captured
 * error to the wt-source harness session as an investigate-and-fix
 * prompt, then drop the user into that session to watch the answer.
 *
 * Deliberately the same shape as `flows/perf-report.ts` — module-scope
 * in-flight/cancelled guards (they must hold BETWEEN keypress and
 * commit; see that file's comment for why React state can't), the flow
 * owning modal close, and the cancel hook stopping short of the
 * terminal handoff when the overlay was dismissed mid-send.
 */
import type { Dispatch, SetStateAction } from "react";

import type { HarnessId } from "../../core/harness/index.ts";
import { createLogger } from "../../core/logger.ts";
import { injectIntoSession } from "../../core/tmux.ts";
import {
  buildErrorInvestigationPrompt,
  latestCapturedError,
  markErrorsSeen,
} from "../error-store.ts";
import type { Modal } from "../modal-state.ts";
import { WT_SOURCE_SLOT, type SessionSlot } from "../sessions/slots.ts";
import { theme } from "../theme.ts";

const log = createLogger(WT_SOURCE_SLOT.label);

let inFlight = false;
let cancelled = false;

/**
 * Called when the error overlay closes. A send already in flight still
 * completes (the paste is on its way) but stops short of entering the
 * session.
 */
export function cancelErrorInvestigate(): void {
  if (inFlight) cancelled = true;
}

export type ErrorFlowCtx = {
  primaryHarness: HarnessId;
  setModal: Dispatch<SetStateAction<Modal | null>>;
  doEnterSlotSession: (slot: SessionSlot) => void;
  toast: (message: string, color?: string, ms?: number) => void;
};

export function makeErrorFlows(ctx: ErrorFlowCtx): {
  doErrorInvestigate: () => void;
} {
  const { primaryHarness, setModal, doEnterSlotSession, toast } = ctx;

  /** Patch inject state only while the error overlay is still up. */
  function patchInject(inject: Extract<Modal, { kind: "errors" }>["inject"]): void {
    setModal((m) => (m?.kind === "errors" ? { ...m, inject } : m));
  }

  function doErrorInvestigate(): void {
    if (inFlight) return;
    // Read the ring at keypress time, not render time — the newest
    // error is by definition the one the user is looking at.
    const captured = latestCapturedError();
    if (!captured) {
      toast("no captured error", theme.fgDim, 1500);
      return;
    }
    inFlight = true;
    cancelled = false;
    patchInject({ kind: "sending" });
    void (async () => {
      // Same tmux session `,` attaches to — the prompt lands in the
      // conversation the user is about to be dropped into.
      const result = await injectIntoSession({
        slug: WT_SOURCE_SLOT.slug,
        cwd: WT_SOURCE_SLOT.path,
        harnessId: primaryHarness,
        text: buildErrorInvestigationPrompt(captured),
      });
      inFlight = false;
      if (!result.ok) {
        patchInject({ kind: "failed", reason: result.reason });
        log.event.err(`error-report inject failed: ${result.reason}`);
        return;
      }
      if (cancelled) {
        log.event.info("error report sent (overlay closed — not entering)");
        return;
      }
      log.event.ok("error report sent — entering session");
      // Handing off counts as acknowledging: don't re-pop this error
      // on return from the session.
      markErrorsSeen();
      // Close before seizing the terminal — an overlay left open would
      // paint back over the session view on return.
      setModal(null);
      doEnterSlotSession(WT_SOURCE_SLOT);
    })();
  }

  return { doErrorInvestigate };
}
