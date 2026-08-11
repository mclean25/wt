/**
 * The `i` affordance inside the `P` perf overlay: hand the current
 * snapshot to the wt-source harness session as a prompt, then drop the
 * user into that session to read the answer.
 *
 * Same per-render-factory pattern as the other flows — called with the
 * live snapshot each render so the closure never sends a stale sample.
 */
import type { Dispatch, SetStateAction } from "react";

import type { HarnessId } from "../../core/harness/index.ts";
import { sendSessionMessage } from "../../core/harness/session-messaging.ts";
import { createLogger } from "../../core/logger.ts";
import { buildPerfInvestigationPrompt, type PerfSnapshot } from "../../core/perf.ts";
import type { Modal } from "../modal-state.ts";
import { WT_SOURCE_SLOT, type SessionSlot } from "../sessions/slots.ts";
import { theme } from "../theme.ts";

const log = createLogger(WT_SOURCE_SLOT.label);

/**
 * In-flight state for the send, held at module scope rather than in
 * React state because both guards have to hold *between* the keypress
 * and the next commit.
 *
 * `inFlight` blocks a second `i` because a cold-started send can take
 * seconds, and a repeat keystroke lands long before a re-render, so a
 * React-state guard would miss it. Two sends mean the prompt submitted
 * twice AND two concurrent
 * `doEnterSlotSession` calls racing for the terminal, which corrupts tty
 * state (both suspend the renderer; whichever finishes first resumes it
 * while the other tmux client still holds stdin).
 *
 * `cancelled` records that the user closed the overlay mid-send. The
 * visible status line already no-ops in that case, but the side effects
 * that matter — closing whatever modal is now open and seizing the
 * terminal — must be skipped too, or Esc stops meaning Esc.
 */
let inFlight = false;
let cancelled = false;

/**
 * Called when the perf overlay closes. A send already in flight still
 * completes (the message is on its way; there's no un-sending it) but
 * stops short of the terminal handoff.
 */
export function cancelPerfInvestigate(): void {
  if (inFlight) cancelled = true;
}

export type PerfFlowCtx = {
  snapshot: PerfSnapshot | undefined;
  primaryHarness: HarnessId;
  setModal: Dispatch<SetStateAction<Modal | null>>;
  doEnterSlotSession: (slot: SessionSlot) => void;
  toast: (message: string, color?: string, ms?: number) => void;
};

export function makePerfFlows(ctx: PerfFlowCtx): {
  doPerfInvestigate: () => void;
} {
  const { snapshot, primaryHarness, setModal, doEnterSlotSession, toast } = ctx;

  /**
   * Patch the perf modal's send state, but only if it's still the
   * modal on screen — the user can Esc out mid-send, and resurrecting
   * a closed overlay to show a status line would be worse than silence.
   */
  function patchInject(inject: Extract<Modal, { kind: "perf" }>["inject"]): void {
    setModal((m) => (m?.kind === "perf" ? { ...m, inject } : m));
  }

  function doPerfInvestigate(): void {
    if (inFlight) return;
    if (!snapshot) {
      toast("no perf sample yet", theme.fgDim, 1500);
      return;
    }
    inFlight = true;
    cancelled = false;
    patchInject({ kind: "sending" });
    void (async () => {
      // Targets the same harness session `,` attaches to:
      // sendSessionMessage and doEnterSlotSession both resolve the name
      // from (slug, primaryHarness), so the prompt lands in the
      // conversation the user is about to be dropped into rather than a
      // second one.
      const result = await sendSessionMessage({
        slug: WT_SOURCE_SLOT.slug,
        cwd: WT_SOURCE_SLOT.path,
        harnessId: primaryHarness,
        text: buildPerfInvestigationPrompt(snapshot),
      });
      inFlight = false;
      if (!result.ok) {
        patchInject({ kind: "failed", reason: result.reason });
        log.event.err(`perf send failed: ${result.reason}`);
        return;
      }
      // Closed mid-send: the prompt landed, but don't yank the terminal
      // out from under whatever the user moved on to.
      if (cancelled) {
        log.event.info("perf snapshot sent (overlay closed — not entering)");
        return;
      }
      log.event.ok("perf snapshot sent — entering session");
      // Close before handing over the terminal: entering suspends the
      // renderer, and an overlay left open would paint back over the
      // session view on return.
      setModal(null);
      doEnterSlotSession(WT_SOURCE_SLOT);
    })();
  }

  return { doPerfInvestigate };
}
