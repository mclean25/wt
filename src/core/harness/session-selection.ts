import type { HarnessSession } from "./types.ts";

/**
 * Pick the wt-owned primary conversation for a single-slot harness.
 *
 * Codex and OpenCode generate their own opaque session ids, so wt persists a
 * stable `primary` / `2` / `3` mapping in `extras.managedName`. Recency says
 * which conversation changed last, not which one owns the primary slot. The
 * newest fallback is only for pre-mapping data or a failed name-store read.
 */
export function primarySingleSlotSession<T extends HarnessSession>(
  sessions: readonly T[],
): T | null {
  const mapped = sessions.find((session) => session.extras.managedName === "primary");
  if (mapped) return mapped;

  let newest: T | null = null;
  for (const session of sessions) {
    if (!newest || (session.lastActiveMs ?? 0) > (newest.lastActiveMs ?? 0)) {
      newest = session;
    }
  }
  return newest;
}
