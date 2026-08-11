/**
 * Inferred-stack layout: pure helpers that group live worktrees into
 * stacks by following their recorded fork bases (`wt new --base` →
 * wtstate `slugs[slug].baseBranch`) and lay each stack out as a tree
 * spine (connector glyph + depth) for the worktree list.
 *
 * There is no stored stack state: a worktree whose recorded base names
 * another live worktree's branch is that worktree's child, and every
 * connected tree of two or more worktrees renders as a stack. Stack
 * identity is the root's branch name, so it shifts when the root lands
 * and is cleaned (the first child re-roots the tree) — cheap, derived,
 * and nothing depends on it being durable. No git/gh/IO here — just
 * the member list — so the TUI render path can import it freely.
 */
import { config } from "./config.ts";

/** One live worktree, as the inference input. */
export type ChainMember = {
  slug: string;
  branch: string;
  /**
   * Recorded fork base for the worktree (wtstate `baseBranch`), when
   * present. The trunk name and `undefined` both mean trunk-based.
   */
  baseBranch?: string;
};

/**
 * Tree-spine connector glyphs, the `tree(1)` / `git log --graph`
 * idiom. Three questions, three answers, nothing carrying two meanings
 * at once:
 *
 *   - COLUMN says depth. The rail is an indent: siblings share a
 *     column, a chain steps right, so a fan reads as a fan without a
 *     legend.
 *   - GLYPH says position among siblings. `├` when another sibling
 *     follows, `└` when this is the last one, `┌` for the row that
 *     tops the spine. `│` continues an ancestor's column past rows
 *     that belong to a deeper branch.
 *   - COLOR says lane (`StackNode.lane`), which is the one thing a
 *     single column of glyphs genuinely can't express: which parallel
 *     branch of a fork a row descends from.
 *
 * The glyph used to be picked from a node's own CHILD count (`┯` where
 * a stack forks, `┌` for a root with one child), which read as
 * box-drawing but didn't connect: a root's connector was never drawn
 * at all, so `┌` and `┯` were unreachable and every spine below a root
 * hung off nothing. Position-among-siblings is what box-drawing glyphs
 * mean everywhere else, and it joins up.
 */
export const STACK_CONNECTOR = {
  /** Tops the spine — the shallowest row of the group. */
  root: "┌",
  /** Another sibling follows below. */
  more: "├",
  /** Last sibling under this parent. */
  last: "└",
  /** Column continuation: an ancestor's spine passing this row. */
  trail: "│",
} as const;

export type StackNode = {
  /** Stack identity: the root member's branch. */
  stackId: string;
  slug: string;
  branch: string;
  /** Distance from the stack root (root = 0). */
  depth: number;
  /**
   * Parallel-lane index → connector color. The root path is lane 0
   * (rendered dim, the "main" spine). At every fork the FIRST child
   * continues its parent's lane; each additional child opens a fresh
   * lane. A purely linear stack stays lane 0 throughout.
   */
  lane: number;
  /**
   * Branch to diff/label against. `null` for a trunk-based root; a root
   * whose recorded base names a branch with no live worktree (an
   * external ref, or a parent cleaned with the branch kept) carries
   * that branch even though it roots the spine. The render diff/sync
   * paths run a dead ref through `effectiveBaseOrTrunk` (falls back to
   * trunk at the git layer), so emitting it here is safe.
   */
  parentBranch: string | null;
  /** Display index within the stack (spine order, 0-based). */
  index: number;
};

export type StackLayout = {
  stackId: string;
  /** Nodes in display order: the spine top-to-bottom, forks linearized pre-order. */
  nodes: StackNode[];
  byBranch: Map<string, StackNode>;
};

export type StackIndexEntry = { layout: StackLayout; node: StackNode };

/**
 * Infer every stack from the live member list and build a branch →
 * (layout, node) index so the row pipeline can answer "is this worktree
 * stacked, and where does it sit?" in O(1). Layouts are returned too
 * (roots in branch order) for section headers.
 *
 * Only trees with ≥2 members become stacks — a lone worktree with a
 * recorded base (its parent isn't a live worktree) stays flat; the row
 * pipeline still shows its fork base via the per-slug record. Malformed
 * record graphs degrade gracefully: a cycle of records has no root, so
 * its members simply render as flat worktrees rather than crashing.
 */
export function buildStackIndex(members: readonly ChainMember[]): {
  byBranch: Map<string, StackIndexEntry>;
  layouts: StackLayout[];
} {
  const trunk = config.branch.base;
  const byBranchMember = new Map<string, ChainMember>();
  for (const m of members) {
    if (m.branch) byBranchMember.set(m.branch, m);
  }

  /** The member's parent member, when its recorded base names one. */
  const parentOf = (m: ChainMember): ChainMember | null => {
    if (!m.baseBranch || m.baseBranch === trunk) return null;
    if (m.baseBranch === m.branch) return null; // self-loop guard
    return byBranchMember.get(m.baseBranch) ?? null;
  };

  const children = new Map<string, ChainMember[]>();
  const roots: ChainMember[] = [];
  for (const m of byBranchMember.values()) {
    const parent = parentOf(m);
    if (!parent) {
      roots.push(m);
    } else {
      const arr = children.get(parent.branch);
      if (arr) arr.push(m);
      else children.set(parent.branch, [m]);
    }
  }
  roots.sort((a, b) => a.branch.localeCompare(b.branch));
  for (const arr of children.values()) {
    arr.sort((a, b) => a.branch.localeCompare(b.branch));
  }

  const byBranch = new Map<string, StackIndexEntry>();
  const layouts: StackLayout[] = [];
  for (const root of roots) {
    if ((children.get(root.branch) ?? []).length === 0) continue; // not a stack
    const stackId = root.branch;
    const nodes: StackNode[] = [];
    let index = 0;
    let nextLane = 0;
    // Pre-order DFS down the spine, threading `lane` and branching it
    // at each fork. Connector glyphs are NOT decided here — they depend
    // on which members are rendered together and in what order, which
    // only the render surface knows (see `spineLayout`).
    const seen = new Set<string>();
    const walk = (m: ChainMember, depth: number, lane: number): void => {
      if (seen.has(m.branch)) return; // cycle guard
      seen.add(m.branch);
      const kids = children.get(m.branch) ?? [];
      nodes.push({
        stackId,
        slug: m.slug,
        branch: m.branch,
        depth,
        lane,
        parentBranch:
          depth === 0
            ? m.baseBranch && m.baseBranch !== trunk && m.baseBranch !== m.branch
              ? m.baseBranch // external / dangling parent ref
              : null // trunk-based, or a nonsense self-referential record
            : m.baseBranch!,
        index: index++,
      });
      // First child stays on this node's lane; each extra child at a
      // fork opens a fresh lane so parallel siblings get distinct colors.
      kids.forEach((c, ci) => walk(c, depth + 1, ci === 0 ? lane : ++nextLane));
    };
    walk(root, 0, 0);
    const layout: StackLayout = {
      stackId,
      nodes,
      byBranch: new Map(nodes.map((n) => [n.branch, n])),
    };
    layouts.push(layout);
    for (const node of nodes) byBranch.set(node.branch, { layout, node });
  }
  return { byBranch, layouts };
}

/** One row's input to `spineLayout`, in the order it will be drawn. */
export type SpineMember = {
  /** Whatever the caller keys rows by (a slug); returned as the map key. */
  key: string;
  branch: string;
  /** Recorded fork base. Only matters when it names another member. */
  parentBranch: string | null;
};

/** Where a row's connector sits and what continues past it. */
export type SpineCell = {
  /** Gutter column for the connector: in-group depth, root at 0. */
  col: number;
  /** The connector glyph itself (`STACK_CONNECTOR`). */
  glyph: string;
  /**
   * Ancestor columns 0..col-1: `true` draws `│`, because that
   * ancestor's spine continues past this row to a later sibling.
   */
  trail: boolean[];
};

/**
 * Lay out the tree spine for ONE CONTIGUOUS GROUP of rows, in the order
 * they are drawn — a section in the list pane, a section's members in
 * the details pane. The rail describes the sub-tree ACTUALLY ON SCREEN,
 * which is what makes it honest:
 *
 *   - a member whose parent is in another section (or folded away) has
 *     no in-group parent, so it tops its own spine or, if nothing else
 *     from its stack is here either, draws no rail at all — the
 *     relationship is carried by the section reference on its label
 *     instead of by a stroke pointing at a row that isn't there;
 *   - depth is measured within the group, so a stack whose root sits
 *     elsewhere starts at column 0 rather than floating one column in
 *     with an empty gutter beside it;
 *   - "has a later sibling" is decided by render order, so `├` vs `└`
 *     and the `│` continuations always agree with what's above and
 *     below on screen, whatever order the row pipeline emitted.
 *
 * Rows not in the returned map draw a blank gutter.
 */
export function spineLayout(
  group: readonly SpineMember[],
): Map<string, SpineCell> {
  const indexByBranch = new Map<string, number>();
  group.forEach((m, i) => {
    if (m.branch && !indexByBranch.has(m.branch)) indexByBranch.set(m.branch, i);
  });
  // In-group parent, or -1. A parent named but not present here is the
  // same as no parent: the spine only draws what it can point at.
  const parentOf = group.map((m, i) => {
    const p = m.parentBranch ? (indexByBranch.get(m.parentBranch) ?? -1) : -1;
    return p === i ? -1 : p; // self-loop guard
  });

  const depthOf = group.map(() => 0);
  const lastChildOf = new Map<number, number>();
  group.forEach((_, i) => {
    let d = 0;
    for (let p = parentOf[i]!, hops = 0; p >= 0 && hops < group.length; hops++) {
      d++;
      p = parentOf[p]!;
    }
    depthOf[i] = d;
    const p = parentOf[i]!;
    if (p >= 0) lastChildOf.set(p, Math.max(lastChildOf.get(p) ?? -1, i));
  });
  /** Is another child of this row's parent drawn below it? */
  const moreBelow = (i: number): boolean => {
    const p = parentOf[i]!;
    return p >= 0 && (lastChildOf.get(p) ?? -1) > i;
  };

  const out = new Map<string, SpineCell>();
  group.forEach((m, i) => {
    const d = depthOf[i]!;
    // A row alone in the group — no parent here, no children here — is
    // not part of any visible spine and stays blank.
    if (d === 0 && !lastChildOf.has(i)) return;
    if (d === 0) {
      out.set(m.key, { col: 0, glyph: STACK_CONNECTOR.root, trail: [] });
      return;
    }
    // Ancestors at depths 1..d-1 own columns 0..d-2; each continues
    // only if IT has a sibling still to come below this row.
    const trail: boolean[] = [];
    let anc = parentOf[i]!;
    while (anc >= 0 && depthOf[anc]! > 0) {
      trail.unshift(moreBelow(anc));
      anc = parentOf[anc]!;
    }
    out.set(m.key, {
      col: d - 1,
      glyph: moreBelow(i) ? STACK_CONNECTOR.more : STACK_CONNECTOR.last,
      trail,
    });
  });
  return out;
}
