/**
 * Persistence for merge edges (`WtState.edges`) — see
 * `core/merge-edges.ts` for the vocabulary and design rules
 * (pairwise, self-expiring, advisory). Writers mirror the shapes in
 * `sections.ts`: every mutation runs under the state lock and rewrites
 * the file atomically.
 */
import type { MergeEdge } from "../merge-edges.ts";
import { readWtState, withWtStateLock, writeWtState } from "./io.ts";
import type { WtState } from "./types.ts";

/**
 * Upsert an edge. Keyed by the ORDERED (from, to) pair: re-asserting
 * A→B replaces the previous A→B edge (fresh anchors, fresh why), while
 * B→A is a distinct edge — asserting both directions of `before` is a
 * cycle the ordering pass tolerates, not something this setter guards.
 */
export function setMergeEdge(edge: MergeEdge): void {
  withWtStateLock(() => {
    const state = readWtState();
    const next: WtState = {
      ...state,
      edges: [
        ...state.edges.filter((e) => !(e.from === edge.from && e.to === edge.to)),
        edge,
      ],
    };
    writeWtState(next);
  });
}

/** Remove the (from, to) edge. Returns whether one existed. */
export function removeMergeEdge(from: string, to: string): boolean {
  return withWtStateLock(() => {
    const state = readWtState();
    const edges = state.edges.filter((e) => !(e.from === from && e.to === to));
    if (edges.length === state.edges.length) return false;
    writeWtState({ ...state, edges });
    return true;
  });
}

/**
 * Drop edges with a dead endpoint against the live slug set — a merged
 * or destroyed endpoint satisfies (or moots) its edges, so they simply
 * disappear rather than dangling. Called from `reapWtState` alongside
 * the per-slug reap; also safe standalone.
 */
export function pruneMergeEdges(liveSlugs: ReadonlySet<string>): void {
  withWtStateLock(() => {
    const state = readWtState();
    const edges = state.edges.filter(
      (e) => liveSlugs.has(e.from) && liveSlugs.has(e.to),
    );
    if (edges.length === state.edges.length) return;
    writeWtState({ ...state, edges });
  });
}
