import { config } from "../../core/config.ts";
import { truncateEnd } from "../text.ts";
import { theme } from "../theme.ts";
import type { RowModule } from "./types.ts";

/**
 * `<branch> → <base>` on one line.
 *
 * These were two rows, and the pair is one fact: where this work lives
 * and where it lands. Merging them buys back the line the title costs
 * at the top of the pane, and reads better than a `base` row three
 * cells wide under a branch name.
 *
 * The base defaults to `config.branch.base` (trunk) and switches to
 * the parent branch when this worktree has a recorded fork base
 * (`row.stackedOn`, from the slug's `baseBranch` — set by
 * `wt new --base` / `wt base` / the `b` picker); a muted "(forked)"
 * flags the non-trunk case.
 *
 * The BRANCH gives up cells when the line doesn't fit, never the base:
 * a truncated branch is still recognizable (and is on the row above in
 * full, as the pane's border), while a truncated target tells you
 * nothing about where the work lands.
 */
export const branchRow: RowModule = {
  id: "branch",
  label: "branch",
  render: ({ row, valueWidth }) => {
    const branch = row.wt.branch || "(none)";
    const stackedOn = row.stackedOn;
    const base = stackedOn?.branch ?? config.branch.base;
    const forked = stackedOn ? " (forked)" : "";
    const tail = ` → ${base}${forked}`;
    const branchText = truncateEnd(
      branch,
      Math.max(8, valueWidth - Bun.stringWidth(tail)),
    );
    return (
      <text wrapMode="none" truncate>
        <span fg={theme.fg}>{branchText}</span>
        <span fg={theme.fgDim}>{" → "}</span>
        <span fg={theme.fg}>{base}</span>
        {stackedOn ? <span fg={theme.fgDim}>{forked}</span> : null}
      </text>
    );
  },
};
