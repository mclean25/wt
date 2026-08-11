/**
 * Full-width work-status banner at the very top of the details pane —
 * replaces the old one-line `status` definition row, whose note was
 * truncated into uselessness exactly when it mattered (ready-note
 * merge impacts, needs-human asks). Header line mirrors the list
 * dot's glyph/color so the banner doubles as its legend; the note
 * gets the pane's full width and word-wraps.
 */
import { isWorkStatusStale, workAge } from "../../../core/work-status.ts";
import { workStateColor } from "../../badges.ts";
import type { WorkState } from "../../../core/work-status.ts";

/**
 * Base-font circle, not the Nerd Font dot the list uses: the NF icon
 * is measured 1 cell but its ink spills wide, so its visual center
 * lands right of the cell center — visibly off-axis from the note
 * rail's `│` (a base-font glyph, dead-centered) directly below it.
 * `●`/`○` center exactly like `│`, so dot and rail line up.
 */
function bannerGlyph(state: WorkState): string {
  return state === "todo" ? "○" : "●";
}
import type { WorktreeRow } from "../../hooks/useWorktreeRows.ts";
import { wrapText } from "../../text.ts";
import { theme } from "../../theme.ts";

export function WorkStatusBlock({
  row,
  contentWidth,
}: {
  row: WorktreeRow;
  /** Details-pane width inside its chrome; the rail costs 2 more cells. */
  contentWidth: number;
}) {
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
        <span fg={color}>{bannerGlyph(record.state)}{" "}</span>
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
        // Blockquote rail: a left-only border draws a hairline `│` in
        // the state color down however many lines the note wraps to (a
        // backgroundColor cell reads as a chunky block); the mid-tone
        // text keeps the colored header dominant without dimming the
        // note to metadata-gray.
        <box
          border={["left"]}
          borderStyle="single"
          borderColor={color}
          paddingLeft={1}
          flexDirection="column"
        >
          {/* Pre-wrapped rather than `wrapMode="word"`: the native
              wrapper left the whitespace it broke on at the head of each
              continuation line and spent a blank line on the last
              character, which showed up as a phantom empty row of rail
              under every long note. */}
          {wrapText(record.note, Math.max(1, contentWidth - 2)).map((line, i) => (
            <text key={i} fg={theme.fgMid} wrapMode="none">
              {line}
            </text>
          ))}
        </box>
      ) : null}
    </box>
  );
}
