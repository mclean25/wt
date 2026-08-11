import { TextAttributes } from "@opentui/core";

import { StatusKind } from "../../../core/types.ts";
import type { HarnessId } from "../../../core/harness/index.ts";
import type { DerivedState } from "../../../core/harness/status.ts";
import {
  WORK_STATES,
  effectiveWorkState,
  workStateRank,
  type WorkState,
} from "../../../core/work-status.ts";
import type { WorktreeRow } from "../../hooks/useWorktreeRows.ts";
import { workStateColor, workStateGlyph } from "../../badges.ts";
import { BadgeCluster } from "../../badge-cluster.tsx";
import { NF } from "../../icons.ts";
import {
  rowSpine,
  spineGutterCells,
  StackConnector,
  StatusMarker,
} from "../../row-gutter.tsx";
import type { SpineCell } from "../../../core/stack-layout.ts";
import { wrapText } from "../../text.ts";
import { theme } from "../../theme.ts";

/**
 * What the detail pane shows when a FOLDED section header is the cursor.
 *
 * A folded section is a BATCH the human made ("To Merge", "Hold: Verify
 * on Dev"), so this pane answers the questions asked of a batch — how
 * much of it is ready, what it is waiting on, and whether any of it is
 * waiting on YOU — rather than restating each row's git state. Member
 * rows are built from the same `row-gutter` + `badge-cluster`
 * components the list pane uses, so folding a section can never change
 * what a glyph means.
 *
 * Built by `tui/hooks/useSectionDetail.ts` from the folded section
 * item's rows, so this pane stays free of state reads.
 */
export type SectionMember = {
  /** Same label the list row shows (`rowLabel`), so the folded summary
   *  and the expanded rows read identically. */
  label: string;
  /** The live list row — status/work/stack plus everything the shared
   *  badge cluster reads (pr, mq, deploy). */
  row: WorktreeRow;
  /** Badge-cluster inputs the list pane computes per slug (action
   *  glyph, harness session glyph + tint), passed through so the
   *  folded summary shows the identical cluster. */
  actionRunning: boolean;
  activeHarnessId: HarnessId | undefined;
  sessionState: DerivedState | undefined;
};

export type SectionDetail = {
  /** Stable section identity — keys the body so a label change doesn't
   *  remount the pane under a stationary cursor. */
  sectionKey: string;
  label: string;
  members: SectionMember[];
  /** Members whose automations are paused, individually or via their
   *  stack (Ctrl+A). A section can hold several stacks, so this is a
   *  count rather than the old whole-section flag. */
  pausedCount: number;
};

/** Effective state of a member — the record plus the session override,
 *  the same resolution the list dot renders. */
function memberState(m: SectionMember): WorkState | null {
  return effectiveWorkState(m.row.work, m.sessionState)?.state ?? null;
}

/**
 * Work-status rollup: `●3 ready · ●1 needs-human · ●2 working`, most
 * urgent first, each dot in its state's color. This replaced a
 * git-status breakdown ("2 dirty · 2 clean"), which described the
 * checkouts rather than the work — nobody folds a section to find out
 * how many of its worktrees have unsaved edits.
 */
function WorkRollup({ members }: { members: SectionMember[] }) {
  const counts = new Map<WorkState | "none", number>();
  for (const m of members) {
    const k = memberState(m) ?? "none";
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const ordered = [...WORK_STATES, "none" as const]
    .filter((s) => counts.has(s))
    .sort((a, b) =>
      workStateRank(a === "none" ? null : a) - workStateRank(b === "none" ? null : b),
    );
  return (
    <box flexShrink={0} flexDirection="row" overflow="hidden">
      <text fg={theme.fgDim} wrapMode="none">
        {`${members.length} worktree${members.length === 1 ? "" : "s"}`}
      </text>
      {ordered.map((s) => (
        <text key={s} wrapMode="none">
          <span fg={theme.fgDim}>{" · "}</span>
          <span fg={s === "none" ? theme.fgDim : workStateColor(s)}>
            {s === "none" ? NF.dotOutline : workStateGlyph(s)}
          </span>
          <span fg={theme.fgDim}>{`${counts.get(s)} ${s === "none" ? "unset" : s}`}</span>
        </text>
      ))}
    </box>
  );
}

/**
 * The batch's mechanical facts, each omitted when zero. These are the
 * things that decide whether the batch can move: open PRs, red CI,
 * uncommitted work that would be lost to a restack, and any member
 * whose automations someone parked. Absent lines mean absent facts —
 * a quiet row here is the point, not a gap.
 */
function BatchFacts({ members, pausedCount }: { members: SectionMember[]; pausedCount: number }) {
  const prs = members.filter((m) => m.row.pr?.state === "OPEN");
  const drafts = prs.filter((m) => m.row.pr?.isDraft);
  const failing = members.filter((m) => m.row.pr?.checks === "fail");
  const dirty = members.filter((m) => m.row.status.kind === StatusKind.Dirty);
  const queued = members.filter((m) => m.row.mq);
  const parts: { text: string; fg: string }[] = [];
  if (prs.length > 0) {
    parts.push({
      text: `${prs.length} PR${prs.length === 1 ? "" : "s"} open${drafts.length ? ` (${drafts.length} draft)` : ""}`,
      fg: theme.fgDim,
    });
  }
  if (queued.length > 0) parts.push({ text: `${queued.length} queued`, fg: theme.info });
  if (failing.length > 0) {
    parts.push({ text: `${failing.length} checks failing`, fg: theme.err });
  }
  if (dirty.length > 0) parts.push({ text: `${dirty.length} dirty`, fg: theme.warn });
  if (pausedCount > 0) parts.push({ text: `${pausedCount} paused`, fg: theme.warn });
  if (parts.length === 0) return null;
  return (
    <box flexShrink={0} flexDirection="row" overflow="hidden">
      {parts.map((p, i) => (
        <text key={p.text} wrapMode="none">
          {i > 0 ? <span fg={theme.fgDim}>{" · "}</span> : null}
          <span fg={p.fg}>{p.text}</span>
        </text>
      ))}
    </box>
  );
}

/** One member, rendered exactly as the list pane renders it. */
function MemberRow({
  m,
  gutterCells,
  spineCell,
}: {
  m: SectionMember;
  gutterCells: number;
  /** This member's rail cell, laid out over the members shown here (so a
   *  parent filed in another section draws nothing) — `rowSpine`. */
  spineCell: SpineCell | null;
}) {
  const dim = m.row.archived;
  const state = memberState(m);
  const risk = state === "ready" ? m.row.work?.risk : undefined;
  return (
    <box flexDirection="row" flexShrink={0}>
      <StackConnector row={m.row} cell={spineCell} cells={gutterCells} />
      <StatusMarker row={m.row} sessionState={m.sessionState} />
      <box flexGrow={1} flexShrink={1} overflow="hidden">
        <text fg={dim ? theme.fgDim : theme.fg} wrapMode="none" truncate>
          {m.label}
        </text>
      </box>
      {/* Risk is the merge decision, so it rides the row rather than
          hiding one keystroke away in the member's own detail pane. */}
      {risk ? (
        <box flexShrink={0}>
          <text fg={risk === "low" ? theme.ok : risk === "medium" ? theme.warn : theme.err}>
            {` ${risk} `}
          </text>
        </box>
      ) : null}
      <BadgeCluster
        row={m.row}
        actionRunning={m.actionRunning}
        activeHarnessId={m.activeHarnessId}
        sessionState={m.sessionState}
      />
    </box>
  );
}

/**
 * The notes of members blocked on the human, verbatim. `needs-human`
 * requires a note saying what is needed, and that sentence is the
 * single most actionable thing in the section — without it the human
 * has to unfold, select the row, and read the detail pane to find out
 * that a batch of eight is waiting on one credential.
 */
function BlockedNotes({ members, width }: { members: SectionMember[]; width: number }) {
  const blocked = members.filter((m) => memberState(m) === "needs-human" && m.row.work?.note);
  if (blocked.length === 0) return null;
  return (
    <>
      <box height={1} flexShrink={0} />
      <text fg={theme.err} wrapMode="none">
        {`${NF.conflict} blocked on you`}
      </text>
      {blocked.map((m) => (
        <box key={m.row.wt.slug} flexDirection="column" flexShrink={0}>
          <text fg={theme.fgDim} wrapMode="none" truncate>
            {`  ${m.label}`}
          </text>
          {/* Capped: a section can hold several blocked members and the
              pane is not the place to read a full note — enough to know
              whether it is your turn, then TAB in. */}
          {wrapText(m.row.work?.note ?? "", Math.max(10, width - 4))
            .slice(0, 2)
            .map((line, i) => (
              <text key={i} fg={theme.fg} wrapMode="none">
                {`    ${line}`}
              </text>
            ))}
        </box>
      ))}
    </>
  );
}

/** Detail-pane body for a folded section header. */
export function SectionSummaryBody({ section, width }: { section: SectionDetail; width: number }) {
  // The members are one contiguous run here, so they lay out as one
  // spine group — exactly as they would if the section were unfolded.
  const spine = rowSpine([section.members.map((m) => m.row)]);
  const gutterCells = spineGutterCells(spine);
  // Border (2) + padding (2) — the text budget inside the box.
  const inner = Math.max(10, width - 4);
  return (
    <box
      flexGrow={1}
      width={width}
      flexShrink={0}
      border
      borderStyle="single"
      borderColor={theme.border}
      title=" section "
      titleAlignment="left"
      padding={1}
    >
      <box flexShrink={0} overflow="hidden">
        <text fg={theme.fgBright} attributes={TextAttributes.BOLD} wrapMode="none" truncate>
          {section.label}
        </text>
      </box>
      <WorkRollup members={section.members} />
      <BatchFacts members={section.members} pausedCount={section.pausedCount} />
      <box height={1} flexShrink={0} />
      {section.members.length === 0 ? (
        <text fg={theme.fgDim}>no worktrees</text>
      ) : (
        section.members.map((m) => (
          <MemberRow
            key={m.row.wt.slug}
            m={m}
            gutterCells={gutterCells}
            spineCell={spine.get(m.row.wt.slug) ?? null}
          />
        ))
      )}
      <BlockedNotes members={section.members} width={inner} />
      <box flexGrow={1} flexShrink={1} minHeight={0} />
      <text fg={theme.fgDim} wrapMode="none" truncate>
        TAB expand · L rename · J/K move
      </text>
    </box>
  );
}
