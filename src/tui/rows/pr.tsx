import { memo, useMemo } from "react";

import { config } from "../../core/config.ts";
import {
  type MergeQueueEntry,
  type PrChecks,
  type PrReview,
  type PullRequest,
  REVIEW_BOT_NONE,
  type ReviewBotStatus,
} from "../../core/types.ts";
import { pluralize } from "../../core/text.ts";
import {
  checkBadge,
  mqStateBadge,
  prStateBadge,
  reviewBadge,
  reviewBotBadge,
  showReviewBot,
} from "../badges.ts";
import { NF } from "../icons.ts";
import { theme } from "../theme.ts";
import { fitSegments, type Segment } from "./fit.tsx";
import type { RowModule } from "./types.ts";

// Glyph/color from `checkBadge`; this only adds the details-pane prose.
function checksLabel(c: PrChecks): { glyph: string; text: string; fg: string } | null {
  const badge = checkBadge(c);
  if (!badge) return null;
  return { ...badge, text: c === "pending" ? "checks pending" : "checks" };
}

// Glyph/color from `reviewBadge`; this only adds the details-pane prose.
function reviewLabel(r: PrReview): { glyph: string; text: string; fg: string } | null {
  const badge = reviewBadge(r);
  if (!badge) return null;
  const text =
    r === "approved"
      ? "approved"
      : r === "changes_requested"
        ? "changes requested"
        : r === "pending"
          ? "review pending"
          : "no reviewers";
  return { ...badge, text };
}

// CodeRabbit keeps its themed "carrots / grazing / resting" vocabulary;
// any other configured bot gets neutral prose.
const BOT_WHIMSY = config.reviewBot.login === "coderabbitai";

// Glyph/color from `reviewBotBadge`; this only adds the details-pane
// `full`/`tiny` prose. Draft-hide lives at the `buildPrSegments` call
// site, not here. A stale review (checklist bots don't re-run on push)
// says so instead of implying the current head was reviewed.
function reviewBotLabel(
  rb: ReviewBotStatus,
): { glyph: string; full: string; tiny: string; fg: string } | null {
  const badge = reviewBotBadge(rb);
  if (!badge) return null;
  const staleSuffix = rb.stale ? " (old head)" : "";
  switch (rb.state) {
    case "unresolved":
      return {
        ...badge,
        full: `${pluralize(rb.unresolved, BOT_WHIMSY ? "carrot" : "issue")}${staleSuffix}`,
        tiny: String(rb.unresolved),
      };
    case "pending":
      return { ...badge, full: BOT_WHIMSY ? "grazing" : "reviewing", tiny: "" };
    case "clean":
      return {
        ...badge,
        full: `${BOT_WHIMSY ? "resting" : "reviewed"}${staleSuffix}`,
        tiny: "",
      };
    default:
      return null;
  }
}

/**
 * Build the PR row's segment list. Tiers picked so the PR id is sticky,
 * a real merge-queue entry (next action) outranks ambient signals, and
 * the auto-merge indicator drops first (tier 6) as the least load-
 * bearing signal — ahead of checks, review, and carrots.
 */
function buildPrSegments(
  pr: PullRequest,
  mq: MergeQueueEntry | undefined,
): Segment[] {
  const segs: Segment[] = [];
  const badge = prStateBadge(pr);
  const num = `#${pr.number}`;
  const numW = Bun.stringWidth(num);

  segs.push({
    key: "id",
    tier: 1,
    modes: [
      {
        width: 3 + numW,
        render: () => (
          <span fg={badge.fg}>
            {badge.glyph}  {num}
          </span>
        ),
      },
      { width: numW, render: () => <span fg={badge.fg}>{num}</span> },
      { width: 0, render: () => null },
    ],
  });

  if (mq) {
    const label = mqStateBadge(mq.state);
    // The merge-queue glyph already prefixes the segment, so a "queue" word
    // is redundant — just the position + state.
    const full = `#${mq.position} ${label.text}`;
    const tiny = `#${mq.position}`;
    segs.push({
      key: "queue",
      tier: 2,
      modes: [
        {
          width: 3 + Bun.stringWidth(full),
          render: () => (
            <span fg={label.fg}>
              {NF.mergeQueue}  {full}
            </span>
          ),
        },
        {
          width: 3 + Bun.stringWidth(tiny),
          render: () => (
            <span fg={label.fg}>
              {NF.mergeQueue}  {tiny}
            </span>
          ),
        },
        { width: 0, render: () => null },
      ],
    });
  } else if (pr.autoMerge && pr.state === "OPEN") {
    // Occupies the queue slot (mutually exclusive with a real queue
    // entry) but ranks dead last — highest tier, so it compacts and
    // drops before checks, review, and the review bot. Auto-merge is "armed but
    // idle" (waiting on preconditions), the least load-bearing signal on
    // the line, so it's the first thing to yield when space is tight.
    // Dimmer color than `queue mergeable` for the same reason.
    const full = "auto-merge";
    const tiny = "auto";
    segs.push({
      key: "automerge",
      tier: 6,
      modes: [
        {
          width: 3 + Bun.stringWidth(full),
          render: () => (
            <span fg={theme.info}>
              {NF.mergeQueue}  {full}
            </span>
          ),
        },
        {
          width: 3 + Bun.stringWidth(tiny),
          render: () => (
            <span fg={theme.info}>
              {NF.mergeQueue}  {tiny}
            </span>
          ),
        },
        { width: 0, render: () => null },
      ],
    });
  }

  if (pr.state === "OPEN") {
    const ck = checksLabel(pr.checks);
    if (ck) {
      const modes: Segment["modes"] = [];
      // When checks are failing, name the culprits if we know them — but
      // only as the widest mode, so `fitSegments` drops back to a bare
      // "checks" (glyph still red) before it starts dropping other
      // segments. The `--log-failed` keybind (`f`) tails their logs.
      // `?? []` guards a stale persisted PR from before this field existed
      // (the github query is cached to disk; old entries lack it until the
      // next live refetch overwrites them).
      const failed = pr.failedChecks ?? [];
      if (pr.checks === "fail" && failed.length > 0) {
        const named = `checks: ${failed.join(", ")}`;
        modes.push({
          width: 3 + Bun.stringWidth(named),
          render: () => (
            <span fg={ck.fg}>
              {ck.glyph}  {named}
            </span>
          ),
        });
      }
      modes.push({
        width: 3 + Bun.stringWidth(ck.text),
        render: () => (
          <span fg={ck.fg}>
            {ck.glyph}  {ck.text}
          </span>
        ),
      });
      modes.push({ width: 0, render: () => null });
      segs.push({ key: "checks", tier: 3, modes });
    }

    // Review before the bot: human review is the primary signal, the
    // review bot is the supplementary "second review" — left-to-right
    // reading order mirrors that priority and the list-pane cluster's
    // [bot] [review] [pr] arrangement (which reads pr-first
    // right-to-left, putting review adjacent to the PR icon there).
    if (!pr.isDraft) {
      const rv = reviewLabel(pr.review);
      if (rv) {
        segs.push({
          key: "review",
          tier: 4,
          modes: [
            {
              width: 3 + Bun.stringWidth(rv.text),
              render: () => (
                <span fg={rv.fg}>
                  {rv.glyph}  {rv.text}
                </span>
              ),
            },
            { width: 0, render: () => null },
          ],
        });
      }
    }

    // Visibility (incl. the mode-specific draft rule) lives in the
    // shared `showReviewBot` so this and the list-pane cluster agree.
    const rb = showReviewBot(pr)
      ? reviewBotLabel(pr.reviewBot ?? REVIEW_BOT_NONE)
      : null;
    if (rb) {
      const modes = [
        {
          width: 3 + Bun.stringWidth(rb.full),
          render: () => (
            <span fg={rb.fg}>
              {rb.glyph}  {rb.full}
            </span>
          ),
        },
      ];
      if (rb.tiny) {
        modes.push({
          width: 3 + Bun.stringWidth(rb.tiny),
          render: () => (
            <span fg={rb.fg}>
              {rb.glyph}  {rb.tiny}
            </span>
          ),
        });
      }
      modes.push({ width: 0, render: () => null });
      segs.push({ key: "reviewbot", tier: 5, modes });
    }
  }

  return segs;
}

export const PrLine = memo(function PrLine({
  pr,
  mq,
  valueWidth,
}: {
  pr: PullRequest | undefined;
  mq: MergeQueueEntry | undefined;
  valueWidth: number;
}) {
  const segments = useMemo(
    () => (pr ? buildPrSegments(pr, mq) : null),
    [pr, mq],
  );
  const fit = useMemo(
    () => (segments ? fitSegments(segments, valueWidth) : null),
    [segments, valueWidth],
  );
  if (!fit) return <text fg={theme.fgDim}>—</text>;
  return (
    <text fg={theme.fg} wrapMode="none" truncate>
      {fit.rendered}
    </text>
  );
});

export const prRow: RowModule = {
  id: "pr",
  label: "pr",
  sources: ({ github }) => [github],
  render: ({ row, valueWidth }) => (
    <PrLine pr={row.pr} mq={row.mq} valueWidth={valueWidth} />
  ),
};
