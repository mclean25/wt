/**
 * Marks for wtstate writes made by THIS process.
 *
 * The TUI narrates work-status assertions and section moves by diffing
 * the wtstate slugs map (`tui/hooks/useWtStateEvents.ts`) rather than
 * emitting at the call site, because the writer is usually another
 * process (`wt status` / `wt section` in an agent's shell). The cost of
 * that is losing the one thing the call site knew: whether the human
 * sitting here caused it. These marks carry exactly that across the
 * write — the mutation records what it's about to persist, the diff
 * consumes the mark when it observes it, and anything unmarked is by
 * definition someone else's.
 *
 * Lives in `state/` rather than beside the hook so the mutations in
 * `state/hooks.ts` can mark at their single choke point without
 * importing upward into `tui/`. The TTL is only a backstop for a write
 * that never lands: a stale mark must not mute a later, unrelated
 * change to the same slug.
 */
const TTL_MS = 5000;

type Mark<T> = { value: T; markedAt: number };

function consume<T>(
  marks: Map<string, Mark<T>>,
  slug: string,
  observed: T,
): boolean {
  const mark = marks.get(slug);
  if (mark === undefined) return false;
  if (Date.now() - mark.markedAt >= TTL_MS) {
    marks.delete(slug);
    return false;
  }
  if (mark.value !== observed) return false; // someone else's write
  marks.delete(slug);
  return true;
}

/**
 * Status writes, keyed by the exact assertion timestamp being written,
 * not just the slug: an agent's external `wt status` landing on the
 * same slug inside the mute window must still toast.
 */
const statusWrites = new Map<string, Mark<string>>();

export function markSelfStatusWrite(slug: string, at: string): void {
  statusWrites.set(slug, { value: at, markedAt: Date.now() });
}

export function consumeSelfStatusWrite(slug: string, observedAt: string): boolean {
  return consume(statusWrites, slug, observedAt);
}

/**
 * Section moves, keyed on the destination — a section move carries no
 * assertion stamp, so the target section is the only identity available.
 */
const sectionWrites = new Map<string, Mark<string | null>>();

export function markSelfSectionWrite(slug: string, section: string | null): void {
  sectionWrites.set(slug, { value: section, markedAt: Date.now() });
}

export function consumeSelfSectionWrite(
  slug: string,
  observed: string | null,
): boolean {
  return consume(sectionWrites, slug, observed);
}
