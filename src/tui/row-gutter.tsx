/**
 * The LEFT-hand glyphs of a worktree row: the stack rail and the
 * status marker. Twin of `badge-cluster.tsx`, which owns the right-hand
 * side — between them, a row rendered in the list pane and the same row
 * rendered in the detail pane's section summary are built from one set
 * of components and cannot drift.
 *
 * They drifted before this module existed: the list moved its leftmost
 * slot to the work-status dot and the section summary kept rendering
 * the old git status badge, so folding a section silently changed what
 * every row's first glyph meant.
 */
import { isWorkStatusStale } from "../core/work-status.ts";
import { STACK_CONNECTOR } from "../core/stack-layout.ts";
import { StatusKind } from "../core/types.ts";
import type { DerivedState } from "../core/harness/status.ts";
import { statusBadge, workStatusBadge } from "./badges.ts";
import type { WorktreeRow } from "./hooks/useWorktreeRows.ts";
import { laneColor, theme } from "./theme.ts";

/** Cells the marker occupies including its trailing gap. */
export const STATUS_MARKER_CELLS = 3;

/**
 * Whether the git-derived status keeps the marker slot: the rare, loud
 * states (busy op / path missing / branch gone / merged) still render
 * their glyph there. `dirty` moved to the badge cluster and `clean`
 * renders nothing — the slot's steady-state occupant is the
 * work-status dot (`workStatusBadge`).
 */
function statusKeepsMarker(kind: StatusKind): boolean {
  return kind !== StatusKind.Dirty && kind !== StatusKind.Clean;
}

/** Stale signal for the row's work-status dot (see `isWorkStatusStale`). */
export function rowWorkStale(row: WorktreeRow): boolean {
  return isWorkStatusStale(row.work, row.fields.gitActivity.data?.lastCommitMs ?? null);
}

/**
 * Leftmost glyph — the loud git states (busy / missing / gone /
 * merged) when present, else the work-status dot (a dim hollow
 * default when nothing is asserted, so the column never has holes).
 * Background refetch state is hinted via the spinner badge in the
 * right cluster instead, so it doesn't masquerade as a primary
 * status. Archived rows render dim.
 */
export function StatusMarker({
  row,
  sessionState,
}: {
  row: WorktreeRow;
  sessionState: DerivedState | undefined;
}) {
  const base = statusKeepsMarker(row.status.kind)
    ? statusBadge(row.status)
    : workStatusBadge(row.work, sessionState, rowWorkStale(row));
  const fg = row.archived ? theme.fgDim : base.fg;
  return (
    <box flexShrink={0} flexDirection="row">
      {/* Mirror the right-cluster pattern: width=2 box for the icon,
          then a width=1 box for the gap. Same shape that produces
          tight left-aligned icons over there. Every row gets this,
          stacked or not, so the dot column never has holes. */}
      <box width={2} flexShrink={0}>
        <text fg={fg}>{base.glyph}</text>
      </box>
      <box width={1} flexShrink={0}>
        <text> </text>
      </box>
    </box>
  );
}

/**
 * Stack connector gutter — a structural rail drawn to the LEFT of the
 * status marker, never in place of it.
 *
 * It used to REPLACE the dot with a connector + `01`/`02` ordinal,
 * which cost stacked rows the one glyph the board is scanned by: two
 * worktrees could both be ready/high and blocked on a human and render
 * with no status indicator at all, purely because they were stack
 * parents. Stacked work was invisible to the primary scanning
 * behaviour.
 *
 * The ordinals are gone too, and that's a correctness fix rather than a
 * preference: `01/02/03` asserts a linear chain, but a fork's children
 * are SIBLINGS off one parent with no order between them. Numbering
 * them claims a merge order that doesn't exist, and a reader who trusts
 * it can sequence dependent work backwards. Depth expresses fan vs
 * chain for free and can't lie: siblings share a column, a chain steps
 * right. If ordinals are ever wanted, derive them from merge EDGES,
 * which actually encode order — stack position never did.
 *
 * `cells` is the gutter width the whole list shares (see
 * `stackGutterCells`), so the marker column stays straight across
 * stacked and unstacked rows and the eye still runs down it. The
 * connector sits at `depth - 1`; a root (depth 0) draws none.
 */
export function StackConnector({
  row,
  cells,
  split = false,
}: {
  row: WorktreeRow;
  cells: number;
  /** Parent lives in another section — see the suppression note below. */
  split?: boolean;
}) {
  if (cells === 0) return null;
  // A member whose parent sits in a DIFFERENT section draws no rail:
  // the spine would point at a row that isn't above it (or on screen at
  // all). Splits are legitimate — finished parents in a verification
  // bucket, unstarted children in a backlog — so the relationship is
  // carried by a section reference on the label instead, and the rail
  // is reserved for members actually adjacent to their parent.
  const info = split ? null : row.stack;
  const col = info ? Math.min(info.depth - 1, cells - 1) : -1;
  return (
    <box flexShrink={0} flexDirection="row">
      {Array.from({ length: cells }, (_, i) => (
        <box key={i} width={1} flexShrink={0}>
          <text fg={info ? laneColor(info.lane) : theme.fgDim}>
            {info && i === col ? STACK_CONNECTOR[info.pos] : " "}
          </text>
        </box>
      ))}
    </box>
  );
}

/**
 * Width of the shared stack gutter: enough columns for the deepest
 * stack among `rows`, capped so a pathological chain can't eat the
 * label column, and ZERO when none of them is stacked — a board with
 * no stacks pays nothing for the feature.
 */
export function stackGutterCells(rows: readonly WorktreeRow[]): number {
  let max = 0;
  for (const r of rows) if (r.stack) max = Math.max(max, r.stack.depth);
  return Math.min(max, 3);
}
