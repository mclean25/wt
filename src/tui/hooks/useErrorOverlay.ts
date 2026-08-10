/**
 * Auto-pop wiring for the error overlay: when the capture ring
 * (src/tui/error-store.ts) holds unacknowledged errors and no other
 * modal is open, open the overlay. Exactly-one-modal contention is
 * handled by QUEUEING, not stealing: while another modal is up the
 * capture's `{toast: true}` footer flash is the only signal, and the
 * overlay pops the moment that modal closes (this effect re-runs on
 * every `modal` transition). Dismissing the overlay calls
 * `markErrorsSeen`, so only a NEW distinct error re-pops it.
 */
import { useEffect } from "react";
import type { Dispatch, SetStateAction } from "react";

import { hasUnseenErrors, useCapturedErrors } from "../error-store.ts";
import type { Modal } from "../modal-state.ts";

export function useErrorOverlayAutoPop({
  modal,
  setModal,
}: {
  modal: Modal | null;
  setModal: Dispatch<SetStateAction<Modal | null>>;
}): void {
  const errors = useCapturedErrors();
  useEffect(() => {
    if (errors.length === 0 || !hasUnseenErrors()) return;
    if (modal !== null) return; // queued — pops when the open modal closes
    setModal({ kind: "errors", inject: { kind: "idle" } });
  }, [errors, modal, setModal]);
}
