/**
 * Full-width work-status banner at the very top of the details pane —
 * replaces the old one-line `status` definition row, whose note was
 * truncated into uselessness exactly when it mattered (ready-note
 * merge impacts, needs-human asks). Header line mirrors the list
 * dot's glyph/color so the banner doubles as its legend; the note
 * gets the pane's full width and word-wraps.
 *
 * Block order is gate → note → steps, and it is load-bearing. The
 * three fields answer questions at different times: the gate says
 * whether the row may be merged AT ALL, the note is what someone
 * merging unread code needs to know NOW, and the steps are for
 * whoever holds the row AFTER it lands. Rendering the steps first —
 * which this pane did, dimming them because "nothing can act on it
 * yet" while still giving them the top slot and the most space — put
 * a 1896-character dormant field above both, pushing the note, the
 * gate and every definition row below the fold on a 50-row terminal.
 */
import {
  isGated,
  isWorkStatusStale,
  owesPostMergeVerification,
  verificationOverdue,
  workAge,
} from "../../../core/work-status.ts";
import { rowHasLanded } from "../../app-helpers.ts";
import { workStateColor } from "../../badges.ts";
import type { WorkState } from "../../../core/work-status.ts";
import type { WorkStatusRecord } from "../../../core/work-status.ts";
import { parseVerifySteps, revertVerdict, splitNoteSections } from "../../work-status-text.ts";

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
import { clipLines, wrapText } from "../../text.ts";
import { theme } from "../../theme.ts";

/**
 * Lines of the steps' preamble shown while the block is collapsed.
 *
 * Enough to tell whether the verification is the one you're thinking
 * of, and not enough to be worth scrolling past. `clipLines` marks the
 * cut, so a preview can't be misread as the whole field.
 */
const COLLAPSED_PREAMBLE_LINES = 2;

/**
 * Whether the steps block starts open for `row`.
 *
 * Open exactly when the obligation has come DUE — the branch landed
 * and someone is now holding a row that owes a check. Before that the
 * field is dormant by construction (it does not gate the merge and
 * does not move the row), so it opens on request rather than by
 * default. Exported because the `V` key has to know what it is
 * toggling away from.
 */
export function verifyStepsOpenByDefault(row: WorktreeRow): boolean {
  return row.work ? owesPostMergeVerification(row.work, rowHasLanded(row)) : false;
}

/**
 * One `LABEL  value` row of a structured ready note, wrapped under a
 * hanging indent so the values line up as a column.
 */
function NoteSection({
  label,
  body,
  width,
  gutter,
}: {
  label: string | null;
  body: string;
  width: number;
  gutter: number;
}) {
  // The lead line has no label and spends the full width — it is a
  // sentence, not a field.
  const indent = label === null ? 0 : gutter;
  const lines = wrapText(body, Math.max(1, width - indent));
  // `UNTESTED` is the honest twin of the risk level, so it carries the
  // only warn-toned label; the rest are signposts, not signals.
  const labelFg = label === "UNTESTED" ? theme.warn : theme.fgDim;
  const verdict = label === "REVERT" ? revertVerdict(body) : null;
  const bodyFg =
    verdict === "safe"
      ? theme.ok
      : verdict === "unsafe"
        ? theme.err
        : // "OPS: none" is the common case and asks nothing of anyone;
          // an OPS line that names real work should not look like it.
          label === "OPS" && /^none\b/i.test(body.trim())
          ? theme.fgDim
          : theme.fgMid;
  return (
    <>
      {lines.map((line, i) => (
        <text key={i} wrapMode="none">
          {i === 0 && label !== null ? (
            <span fg={labelFg}>{label.padEnd(gutter)}</span>
          ) : (
            <span>{" ".repeat(indent)}</span>
          )}
          <span fg={bodyFg}>{line}</span>
        </text>
      ))}
    </>
  );
}

/**
 * The post-merge verification the branch owes.
 *
 * Collapsed to a header plus a two-line preview unless it has come
 * due, because the field is deliberately verbose: it is an executable
 * contract for an agent that is not the one who wrote it, so nothing
 * here rewrites the text — it only stops showing all of it to a reader
 * who cannot act on it yet.
 *
 * Colour discriminates rather than decorates. Rendering every line at
 * full warn saturation (which is what a single wrapped blob did) is a
 * shout with no shape: fourteen equally loud lines say only "this is
 * long". The header and the step numbers carry the state colour; the
 * prose sits at the same mid-tone the note uses, so the eye can find
 * the structure inside the block instead of just the block.
 */
function VerifyStepsBlock({
  steps,
  width,
  color,
  owed,
  overdue,
  expanded,
}: {
  steps: string;
  width: number;
  color: string;
  owed: boolean;
  overdue: boolean;
  expanded: boolean;
}) {
  const parsed = parseVerifySteps(steps);
  const headFg = owed ? color : theme.fgDim;
  const bodyFg = owed ? theme.fgMid : theme.fgDim;
  const count = parsed.steps.length;
  // A gutter sized to the widest number, so the step bodies form a
  // column rather than stepping right at item 10.
  const gutter = String(Math.max(count, 1)).length + 2;
  const preamble = expanded
    ? wrapText(parsed.preamble, Math.max(1, width))
    : clipLines(parsed.preamble, Math.max(1, width), COLLAPSED_PREAMBLE_LINES);
  return (
    <box flexDirection="column">
      <text wrapMode="none" truncate>
        {/* No leading glyph, deliberately: every Nerd Font icon here is
            measured 1 cell but inks wider, so a header wearing one sits
            two cells right of the preamble and steps directly beneath
            it and reads as a misalignment rather than as a heading. The
            colour, the step count and the key hint mark it well enough,
            and it lines up with the gate line — its sibling field. */}
        <span fg={headFg} attributes={owed ? 1 : 0}>
          {`${overdue ? "OVERDUE — " : ""}verify after merge`}
        </span>
        {count > 0 ? (
          <span fg={theme.fgDim}>{` · ${count} step${count === 1 ? "" : "s"}`}</span>
        ) : null}
        <span fg={theme.fgDim}>{expanded ? " · V collapses" : " · V expands"}</span>
      </text>
      {preamble.map((line, i) => (
        <text key={`p${i}`} fg={bodyFg} wrapMode="none">
          {line}
        </text>
      ))}
      {expanded
        ? parsed.steps.map((step, i) => {
            const lines = wrapText(step, Math.max(1, width - gutter));
            return lines.map((line, j) => (
              <text key={`s${i}-${j}`} wrapMode="none">
                <span fg={j === 0 ? headFg : theme.fgDim}>
                  {j === 0 ? `${i + 1}.`.padEnd(gutter) : " ".repeat(gutter)}
                </span>
                <span fg={bodyFg}>{line}</span>
              </text>
            ));
          })
        : null}
    </box>
  );
}

export function WorkStatusBlock({
  row,
  contentWidth,
  verifyExpanded,
}: {
  row: WorktreeRow;
  /** Details-pane width inside its chrome; the rail costs 2 more cells. */
  contentWidth: number;
  /**
   * `V`'s override of the steps block, or `null` to follow the row's
   * own default (open once the check has come due). Reset when the
   * cursor moves, so each row is judged on its own state.
   */
  verifyExpanded: boolean | null;
}) {
  return (
    <WorkStatusRecordBlock
      record={row.work ?? null}
      contentWidth={contentWidth}
      verifyExpanded={verifyExpanded}
      landed={rowHasLanded(row)}
      lastCommitMs={row.fields.gitActivity.data?.lastCommitMs ?? null}
    />
  );
}

/** Location-neutral work-status banner used by local and remote details. */
export function WorkStatusRecordBlock({
  record,
  contentWidth,
  verifyExpanded,
  landed,
  lastCommitMs,
}: {
  record: WorkStatusRecord | null;
  contentWidth: number;
  verifyExpanded: boolean | null;
  landed: boolean;
  lastCommitMs: number | null;
}) {
  if (!record) return null;
  const blocked = isGated(record);
  // Same relationship as the gate, at the other end of the lifecycle:
  // the row asserts `ready` and the branch has landed, so the state
  // alone reads as finished while a check is still owed.
  const owed = owesPostMergeVerification(record, landed);
  const overdue = owed && verificationOverdue(record, landed);
  // The gate owns the banner's color when set: this block is the
  // legend for the list dot, and the two disagreeing is how a note
  // saying BLOCKED lost to a field saying ready.
  const color = overdue
    ? theme.err
    : blocked || owed
      ? theme.warn
      : workStateColor(record.state);
  const age = workAge(record.at);
  // Time-based staleness: commits after the assertion mean the status
  // describes an older tree. (The CLI's `stale` flag uses the recorded
  // sha; here `lastCommitMs` is what's already fetched.)
  const stale = isWorkStatusStale(record, lastCommitMs);
  const sections = record.note ? splitNoteSections(record.note) : [];
  // Sized to the widest label actually present, so a note carrying
  // only `OPS:` doesn't indent its values past an absent `IF WRONG`.
  const noteGutter =
    sections.reduce((w, s) => Math.max(w, s.label ? s.label.length : 0), 0) + 2;
  return (
    <box flexDirection="column" marginBottom={1}>
      <text wrapMode="none" truncate>
        <span fg={color}>{blocked ? "⊘" : bannerGlyph(record.state)}{" "}</span>
        <span fg={color} attributes={1}>
          {blocked
            ? `blocked · ${record.state}`
            : owed
              ? `unverified · ${record.state}`
              : record.state}
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
      {record.blockedOn ? (
        // First, and never truncated into the note: the gate is the one
        // fact that changes what the reader may DO with the row, and it
        // lost to a note once already.
        <box flexDirection="column">
          {wrapText(`blocked on: ${record.blockedOn}`, Math.max(1, contentWidth)).map(
            (line, i) => (
              <text key={i} fg={theme.warn} wrapMode="none">
                {line}
              </text>
            ),
          )}
        </box>
      ) : null}
      {sections.length > 0 ? (
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
          {sections.map((s, i) => (
            <NoteSection
              key={i}
              label={s.label}
              body={s.body}
              width={Math.max(1, contentWidth - 2)}
              gutter={noteGutter}
            />
          ))}
        </box>
      ) : null}
      {record.verifyAfterMerge ? (
        <VerifyStepsBlock
          steps={record.verifyAfterMerge}
          width={Math.max(1, contentWidth)}
          color={color}
          owed={owed}
          overdue={overdue}
          expanded={verifyExpanded ?? owed}
        />
      ) : null}
    </box>
  );
}
