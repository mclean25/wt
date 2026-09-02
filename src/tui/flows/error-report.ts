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
import { Effect, Option } from "effect";

import type { HarnessId } from "../../core/harness/index.ts";
import { sendSessionMessage } from "../../core/harness/session-messaging.ts";
import { createLogger } from "../../core/logger.ts";
import {
  buildErrorInvestigationPrompt,
  latestCapturedError,
  markErrorsSeen,
} from "../error-store.ts";
import type { Modal } from "../modal-state.ts";
import { WT_SOURCE_SLOT, type SessionSlot } from "../sessions/slots.ts";
import { theme } from "../theme.ts";

const log = createLogger(WT_SOURCE_SLOT.label);

/** A wedged transport must not permanently disable the `i` affordance. */
const SEND_TIMEOUT = "30 seconds";

let inFlight = false;
let cancelled = false;

/**
 * Called when the error overlay closes. A send already in flight still
 * completes in the background (the message is on its way) but stops
 * short of entering the session — `cancelled` gates that last step.
 * `inFlight` is reset here too, immediately, rather than waiting for
 * that background send (or its timeout) to settle: the `i` affordance
 * is a UI throttle, not a concurrency guard (the transport already
 * serializes per target), so there's no reason a dismissed overlay
 * should keep it disabled.
 */
export function cancelErrorInvestigate(): void {
  if (inFlight) {
    cancelled = true;
    inFlight = false;
  }
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
    Effect.runFork(
      // Same tmux session `,` attaches to. The prompt lands in the
      // conversation the user is about to enter.
      sendSessionMessage({
        slug: WT_SOURCE_SLOT.slug,
        cwd: WT_SOURCE_SLOT.path,
        harnessId: primaryHarness,
        text: buildErrorInvestigationPrompt(captured),
      }).pipe(
        Effect.timeoutOption(SEND_TIMEOUT),
        Effect.match({
          onFailure: (error) => {
            const reason = error.message;
            patchInject({ kind: "failed", reason });
            log.event.err(`error-report send failed: ${reason}`);
          },
          onSuccess: (outcome) => {
            if (Option.isNone(outcome)) {
              patchInject({ kind: "failed", reason: "timed out waiting for the session" });
              log.event.err("error-report send timed out");
              return;
            }
            const result = outcome.value;
            if (!result.ok) {
              patchInject({ kind: "failed", reason: result.reason });
              log.event.err(`error-report send failed: ${result.reason}`);
              return;
            }
      // `ok` is not delivery. It used to be, for Claude: the old
      // transport only resolved ok once the prompt was in the
      // transcript. Now `delivered: false` is a real outcome, and
      // treating it as success here would ALSO mark the errors seen —
      // burying a captured crash whose investigation prompt never
      // arrived.
            if (result.delivered === false) {
              patchInject({
                kind: "failed",
                reason: "the session never received it",
              });
              log.event.err("error-report send was not received by the session");
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
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            inFlight = false;
          }),
        ),
      ),
    );
  }

  return { doErrorInvestigate };
}
