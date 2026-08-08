/**
 * Work-status row — the details-pane counterpart of the list's
 * leftmost dot. Shows the ASSERTED record in full: state, merge risk,
 * age, a staleness hint when commits landed after the assertion, and
 * the note on its own line's worth of trailing text. The list dot's
 * derived session-asking upgrade is deliberately absent here — the
 * claude row already narrates the live session, and this row answers
 * "what did the agent last claim".
 */
import { workStatusBadge, workStateColor } from "../badges.ts";
import { workAge } from "../../core/work-status.ts";
import { theme } from "../theme.ts";
import type { RowModule } from "./types.ts";

export const statusRow: RowModule = {
  id: "status",
  label: "status",
  render: ({ row }) => {
    const record = row.work;
    if (!record) return <text fg={theme.fgDim}>—</text>;
    const badge = workStatusBadge(record, undefined)!;
    const color = workStateColor(record.state);
    const age = workAge(record.at);
    // Time-based staleness: commits after the assertion mean the
    // status describes an older tree. (The CLI's `stale` flag uses the
    // recorded sha; here `lastCommitMs` is what's already fetched.)
    const lastCommitMs = row.fields.gitActivity.data?.lastCommitMs ?? null;
    const assertedMs = Date.parse(record.at);
    const stale =
      lastCommitMs !== null &&
      !Number.isNaN(assertedMs) &&
      lastCommitMs > assertedMs;
    return (
      <text wrapMode="none" truncate>
        <span fg={badge.fg}>{badge.glyph}  </span>
        <span fg={color}>{record.state}</span>
        {record.risk ? (
          <span>
            <span fg={theme.fgDim}>{" · risk "}</span>
            <span fg={color}>{record.risk}</span>
          </span>
        ) : null}
        {age ? <span fg={theme.fgDim}>{` · ${age} ago`}</span> : null}
        {stale ? <span fg={theme.warn}>{" · commits since"}</span> : null}
        {record.note ? <span fg={theme.fg}>{`  ${record.note}`}</span> : null}
      </text>
    );
  },
  sources: ({ row }) => [row.fields.gitActivity],
};

