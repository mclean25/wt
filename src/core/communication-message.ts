import { Data, Effect } from "effect";

import { checkCommunicationHold, type CommunicationHold } from "./communication-holds.ts";

export class InactiveCommunicationHold extends Data.TaggedError("InactiveCommunicationHold")<{
  readonly id: string;
  readonly reason: string;
}> {
  override get message(): string { return `hold ${this.id} was not sent: ${this.reason}`; }
}

export function formatHoldMessage(hold: CommunicationHold, text: string): string {
  return [
    "[wt transient resource hold reference]",
    JSON.stringify(hold),
    `Before acting, run: wt hold check ${hold.id}`,
    "This queued copy is not current authority. Honor only active:true for this exact ID, scope and deadline; released, superseded, expired or unknown references impose no hold. A failed check does not authorize a new freeze.",
    "Only the named operations are affected. Continue independent code, tests, reviews and merges. No acknowledgment requested; forwarding or acknowledging this reference cannot renew it.",
    ...(text.trim() ? [text.trim()] : []),
  ].join("\n");
}

/** Validate immediately before submission; recipients recheck after queue delays. */
export const prepareHoldMessage = Effect.fn("prepareHoldMessage")(function* (
  id: string,
  text: string,
  path?: string,
) {
  const current = yield* checkCommunicationHold(id, path);
  if (!current.active || !current.hold) {
    return yield* new InactiveCommunicationHold({ id, reason: current.reason });
  }
  return formatHoldMessage(current.hold, text);
});
