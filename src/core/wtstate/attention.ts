import { readWtState, withWtStateLock, writeWtState } from "./io.ts";

/**
 * Persist the attention-feed "seen" watermark (`x` in the TUI while
 * the attention feed is displayed). Monotonic by construction — a
 * concurrent older write can't regress a newer mark — because the
 * whole point is "everything up to now is handled".
 */
export function setAttentionSeen(ts: number): void {
  withWtStateLock(() => {
    const state = readWtState();
    if (ts <= state.attentionSeenTs) return;
    writeWtState({ ...state, attentionSeenTs: ts });
  });
}
