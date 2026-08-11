/**
 * Merge edges — pairwise, self-expiring ordering assertions between
 * worktrees, the structured form of "merge A before B" that used to
 * live only in manager prose.
 *
 * Design rules (docs/fleet.md):
 *  - PAIRWISE, never a total order. A stored ordering breaks on every
 *    insert and forces the asserter to invent relationships between
 *    things that have none; edges only relate the pairs someone
 *    actually knows about. Absence of an edge means "no known
 *    constraint", never "safe".
 *  - SELF-EXPIRING, never maintained. Every edge records the HEAD of
 *    both endpoints at assert time; once either branch moves, the edge
 *    is STALE — greyed in listings, ignored by ordering — until the
 *    asserter re-states it. Nothing ever asks anyone to re-audit edges;
 *    a drifted constraint quietly stops steering instead of looking
 *    authoritative while wrong.
 *  - ADVISORY, never blocking. Edges reorder rows and inform the
 *    manager/human; they never gate a merge or prompt anyone.
 *
 * Vocabulary:
 *  - `before`    — merge `from` before `to` (risk ordering).
 *  - `enables`   — `from` landing makes `to` true/complete (a claim in
 *                  `to` only holds once `from` is in). Orders like
 *                  `before`; the distinction is for the reader.
 *  - `conflicts` — the pair touches the same files; sequence them and
 *                  expect a rebase, direction irrelevant. Does NOT
 *                  contribute to ordering.
 *  - `strength`  — `blocks` (hard dependency) vs `prefer` (risk
 *                  preference, safe to violate deliberately). The field
 *                  that tells a human what's safe to override at 11pm.
 *
 * Persistence lives in `wtstate/edges.ts` (the record rides
 * `WtState.edges`); this module is the pure vocabulary: parsing,
 * staleness, and the stable topological ordering pass.
 */

export const MERGE_EDGE_KINDS = ["before", "conflicts", "enables"] as const;
export type MergeEdgeKind = (typeof MERGE_EDGE_KINDS)[number];

export const MERGE_EDGE_STRENGTHS = ["blocks", "prefer"] as const;
export type MergeEdgeStrength = (typeof MERGE_EDGE_STRENGTHS)[number];

export type MergeEdge = {
  /** Slug of the worktree that should land first (or one conflict side). */
  from: string;
  /** Slug of the other endpoint. */
  to: string;
  kind: MergeEdgeKind;
  strength: MergeEdgeStrength;
  /** One line of why, for the human deciding whether to honor it. */
  why?: string;
  /** ISO assert time. */
  at: string;
  /**
   * Who asserted it: a worktree slug (asserted from inside that
   * worktree — it knows its own dependencies first-hand) or "fleet"
   * (asserted from outside any worktree, i.e. the manager or the
   * human). Cross-branch edges are usually fleet-asserted and carry
   * correspondingly less first-hand knowledge.
   */
  by: string;
  /**
   * HEAD of each endpoint at assert time — the decay anchors. An edge
   * whose endpoint has moved past its anchor is stale. Absent anchors
   * (hand-edited state) read as stale immediately: an edge that can't
   * self-expire is worse than no edge.
   */
  fromSha?: string;
  toSha?: string;
};

/** Whether this kind imposes a from-before-to ordering. */
export function edgeOrders(kind: MergeEdgeKind): boolean {
  return kind !== "conflicts";
}

/** Lenient per-edge parse for the wtstate read path; null = drop. */
export function parseMergeEdge(raw: unknown): MergeEdge | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<MergeEdge>;
  if (typeof r.from !== "string" || r.from.trim() === "") return null;
  if (typeof r.to !== "string" || r.to.trim() === "") return null;
  if (r.from === r.to) return null;
  if (!MERGE_EDGE_KINDS.includes(r.kind as MergeEdgeKind)) return null;
  const strength = MERGE_EDGE_STRENGTHS.includes(r.strength as MergeEdgeStrength)
    ? (r.strength as MergeEdgeStrength)
    : "prefer";
  const edge: MergeEdge = {
    from: r.from,
    to: r.to,
    kind: r.kind as MergeEdgeKind,
    strength,
    at: typeof r.at === "string" ? r.at : "",
    by: typeof r.by === "string" && r.by.trim() !== "" ? r.by : "fleet",
  };
  if (typeof r.why === "string" && r.why.trim() !== "") edge.why = r.why;
  if (typeof r.fromSha === "string" && r.fromSha.trim() !== "") edge.fromSha = r.fromSha;
  if (typeof r.toSha === "string" && r.toSha.trim() !== "") edge.toSha = r.toSha;
  return edge;
}

/**
 * SHA-precision staleness (CLI / fleet, which resolve HEADs anyway):
 * stale when an anchor is missing or an endpoint's HEAD no longer
 * matches it. An unresolvable HEAD (null — transient git failure)
 * doesn't stale the edge by itself; the endpoint that CAN'T be read
 * shouldn't kill a constraint the readable one still supports.
 */
export function edgeIsStaleBySha(
  edge: MergeEdge,
  headOf: (slug: string) => string | null,
): boolean {
  if (!edge.fromSha || !edge.toSha) return true;
  const f = headOf(edge.from);
  if (f !== null && f !== edge.fromSha) return true;
  const t = headOf(edge.to);
  if (t !== null && t !== edge.toSha) return true;
  return false;
}

/**
 * Commit-time staleness for the TUI, which has `lastCommitMs` per row
 * but no HEADs (same signal family `isWorkStatusStale` uses): stale
 * when either endpoint committed after the assert. Missing anchors
 * stale here too; an unknown lastCommit (null) doesn't.
 */
export function edgeIsStaleByTime(
  edge: MergeEdge,
  lastCommitMsOf: (slug: string) => number | null | undefined,
): boolean {
  if (!edge.fromSha || !edge.toSha) return true;
  const at = Date.parse(edge.at);
  if (!Number.isFinite(at)) return true;
  for (const slug of [edge.from, edge.to]) {
    const ms = lastCommitMsOf(slug);
    if (typeof ms === "number" && ms > at) return true;
  }
  return false;
}

/**
 * Stable topological pass: reorder `order` so every ordering edge
 * (fresh `before`/`enables` whose endpoints are both present) puts
 * `from` above `to`, disturbing the incoming order as little as
 * possible — Kahn's algorithm picking the earliest-incoming available
 * item each round, so unconstrained rows keep exactly their positions
 * relative to each other. A cycle (A before B before A) degrades
 * gracefully: the earliest remaining item is released, effectively
 * ignoring one edge of the cycle rather than throwing or stalling.
 * Callers pre-filter to fresh edges; this function orders whatever
 * it's given.
 */
export function topoOrderSlugs(
  order: readonly string[],
  edges: readonly MergeEdge[],
): string[] {
  const present = new Set(order);
  const indegree = new Map<string, number>();
  const outs = new Map<string, string[]>();
  for (const s of order) indegree.set(s, 0);
  for (const e of edges) {
    if (!edgeOrders(e.kind)) continue;
    if (e.from === e.to || !present.has(e.from) || !present.has(e.to)) continue;
    const list = outs.get(e.from);
    if (list) list.push(e.to);
    else outs.set(e.from, [e.to]);
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }
  if (outs.size === 0) return [...order];
  const remaining = new Set(order);
  const result: string[] = [];
  while (remaining.size > 0) {
    let pick: string | undefined;
    for (const s of order) {
      if (remaining.has(s) && (indegree.get(s) ?? 0) === 0) {
        pick = s;
        break;
      }
    }
    if (pick === undefined) {
      // Cycle: release the earliest remaining item.
      for (const s of order) {
        if (remaining.has(s)) {
          pick = s;
          break;
        }
      }
    }
    remaining.delete(pick!);
    result.push(pick!);
    for (const t of outs.get(pick!) ?? []) {
      if (remaining.has(t)) indegree.set(t, (indegree.get(t) ?? 0) - 1);
    }
  }
  return result;
}
