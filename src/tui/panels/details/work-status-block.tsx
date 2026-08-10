/**
 * Full-width work-status banner at the very top of the details pane —
 * replaces the old one-line `status` definition row, whose note was
 * truncated into uselessness exactly when it mattered (ready-note
 * merge impacts, needs-human asks). Header line mirrors the list
 * dot's glyph/color so the banner doubles as its legend; the note
 * gets the pane's full width and word-wraps.
 */
import { isWorkStatusStale, workAge } from "../../../core/work-status.ts";
import { workStateColor, workStateGlyph } from "../../badges.ts";
import type { WorktreeRow } from "../../hooks/useWorktreeRows.ts";
import { theme } from "../../theme.ts";

export function WorkStatusBlock({ row }: { row: WorktreeRow }) {
  const record = row.work;
  if (!record) return null;
  const color = workStateColor(record.state);
  const age = workAge(record.at);
  // Time-based staleness: commits after the assertion mean the status
  // describes an older tree. (The CLI's `stale` flag uses the recorded
  // sha; here `lastCommitMs` is what's already fetched.)
  const stale = isWorkStatusStale(record, row.fields.gitActivity.data?.lastCommitMs ?? null);
  return (
    <box flexDirection="column" marginBottom={1}>
      <text wrapMode="none" truncate>
        <span fg={color}>{workStateGlyph(record.state)}{"  "}</span>
        <span fg={color} attributes={1}>
          {record.state}
        </span>
        {record.risk ? (
          <span>
            <span fg={theme.fgDim}>{" · risk "}</span>
            <span fg={color}>{record.risk}</span>
          </span>
        ) : null}
        {age ? <span fg={theme.fgDim}>{` · ${age} ago`}</span> : null}
        {stale ? <span fg={theme.warn}>{" · commits since"}</span> : null}
      </text>
      {record.note ? (
        // Blockquote rail: a 1-cell bar in the state color contains
        // the note (it stretches to however many lines the text wraps
        // to) and marks where the block ends; the mid-tone text keeps
        // the colored header dominant without dimming the note to
        // metadata-gray.
        <box flexDirection="row">
          <box width={1} flexShrink={0} backgroundColor={color} />
          <box flexGrow={1} flexShrink={1} paddingLeft={1}>
            <text fg={theme.fgMid} wrapMode="word">
              {record.note}
            </text>
          </box>
        </box>
      ) : null}
    </box>
  );
}
