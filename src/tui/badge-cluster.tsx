/** One location-neutral badge renderer for local and SSH-hosted rows. */
import {
  checkBadge,
  mqStateBadge,
  prSlotBadge,
  rebaseBadge,
  reviewBadge,
  reviewBotBadge,
  showReviewBot,
  type Badge,
} from "./badges.ts";
import { stateColor } from "./claude-state.ts";
import { NF } from "./icons.ts";
import { theme } from "./theme.ts";
import { config, type BadgeSlot } from "../core/config.ts";
import { getHarness, type HarnessId } from "../core/harness/index.ts";
import type { DerivedState } from "../core/harness/status.ts";
import {
  REVIEW_BOT_NONE,
  StatusKind,
  type MergeQueueEntry,
  type PullRequest,
} from "../core/types.ts";
import type { WorktreeRow } from "./hooks/useWorktreeRows.ts";
import type { WorktreeModel } from "./worktree-model.ts";

function shows(slot: BadgeSlot): boolean {
  return !config.ui.hiddenBadges.has(slot);
}

/** Every input the renderer needs, with location deliberately absent. */
export type WorktreeBadgeSignals = {
  pr: PullRequest | undefined;
  mq: MergeQueueEntry | undefined;
  archived: boolean;
  actionRunning: boolean;
  environmentLive: boolean;
  dirty: Badge | null;
  rebase: Badge | null;
  activeHarnessId: HarnessId | undefined;
  sessionState: DerivedState | undefined;
};

export function localBadgeSignals(
  row: WorktreeRow,
  actionRunning: boolean,
  activeHarnessId: HarnessId | undefined,
  sessionState?: DerivedState,
): WorktreeBadgeSignals {
  return {
    pr: row.pr,
    mq: row.mq,
    archived: row.archived,
    actionRunning,
    environmentLive:
      (row.fields.deploy.data ?? false) || (row.fields.dev.data?.running ?? false),
    dirty:
      row.status.kind === StatusKind.Dirty
        ? { glyph: NF.pencil, fg: theme.warn }
        : null,
    rebase: rebaseBadge(
      row.fields.lock.data,
      row.fields.conflict.data,
      sessionState,
    ),
    activeHarnessId,
    sessionState,
  };
}

/** Adapter for inventory-normalized rows (used by every remote surface). */
export function modelBadgeSignals(
  model: WorktreeModel,
  actionRunning: boolean,
): WorktreeBadgeSignals {
  return {
    pr: model.pr,
    mq: model.mq,
    archived: model.archived,
    actionRunning,
    environmentLive: model.deployed || model.dev.running,
    dirty: model.status.kind === StatusKind.Dirty
      ? { glyph: NF.pencil, fg: theme.warn }
      : null,
    rebase: null,
    activeHarnessId: undefined,
    sessionState: undefined,
  };
}

type VisibleSignals = {
  action: boolean;
  session: boolean;
  deploy: boolean;
  dirty: Badge | null;
  rebase: Badge | null;
  pr: PullRequest | undefined;
  mq: MergeQueueEntry | undefined;
  bot: Badge | null;
  review: Badge | null;
  checks: Badge | null;
};

/** Apply hidden-badge policy once for both width calculation and JSX. */
function visible(signals: WorktreeBadgeSignals): VisibleSignals {
  const pr = shows("pr") ? signals.pr : undefined;
  const mq = shows("pr") ? signals.mq : undefined;
  const bot = signals.pr && shows("review_bot") && showReviewBot(signals.pr)
    ? reviewBotBadge(signals.pr.reviewBot ?? REVIEW_BOT_NONE)
    : null;
  const review = signals.pr && shows("review") && signals.pr.state === "OPEN" &&
      !signals.pr.isDraft
    ? reviewBadge(signals.pr.review)
    : null;
  const checks = signals.pr && shows("checks") && signals.pr.state === "OPEN" &&
      signals.pr.checks !== "none"
    ? checkBadge(signals.pr.checks)
    : null;
  return {
    action: signals.actionRunning && shows("action"),
    session: signals.activeHarnessId !== undefined && shows("session"),
    deploy: signals.environmentLive && shows("deploy"),
    dirty: shows("dirty") ? signals.dirty : null,
    rebase: shows("rebase") ? signals.rebase : null,
    pr,
    mq,
    bot,
    review,
    checks,
  };
}

export function worktreeBadgeClusterCells(signals: WorktreeBadgeSignals): number {
  const v = visible(signals);
  const content =
    (v.action ? 2 : 0) +
    (v.dirty ? 2 : 0) +
    (v.rebase ? 2 : 0) +
    (v.deploy ? 2 : 0) +
    (v.session ? 2 : 0) +
    (v.bot ? 2 : 0) +
    (v.review ? 2 : 0) +
    (v.mq ? 4 : v.pr ? 2 : 0) +
    (v.checks ? 2 : 0);
  return content === 0 ? 0 : content + 2;
}

/**
 * Shared list/details cluster. Remote location is represented beside the row
 * title; it is not a rendering mode and therefore cannot change these badges.
 */
export function WorktreeBadgeCluster({ signals }: { signals: WorktreeBadgeSignals }) {
  if (worktreeBadgeClusterCells(signals) === 0) return null;
  const v = visible(signals);
  const dim = signals.archived ? theme.fgDim : undefined;
  const prBadge = v.pr ? prSlotBadge(v.pr, v.mq) : null;
  const mqText = v.mq
    ? `${NF.mergeQueue} ${v.mq.position >= 10 ? "+" : String(v.mq.position)}`
    : "";
  const harnessId = signals.activeHarnessId;
  return (
    <box flexShrink={0} flexDirection="row">
      <text>  </text>
      {v.action ? <box width={2} flexShrink={0}><text fg={theme.ok}>{NF.comment}</text></box> : null}
      {v.dirty ? <box width={2} flexShrink={0}><text fg={dim ?? v.dirty.fg}>{v.dirty.glyph}</text></box> : null}
      {v.rebase ? <box width={2} flexShrink={0}><text fg={dim ?? v.rebase.fg}>{v.rebase.glyph}</text></box> : null}
      {v.deploy ? <box width={2} flexShrink={0}><text fg={dim ?? theme.warn}>{NF.bolt}</text></box> : null}
      {v.session && harnessId ? (
        <box width={2} flexShrink={0}>
          <text fg={signals.sessionState
            ? stateColor(harnessId, signals.sessionState)
            : getHarness(harnessId).color}>
            {getHarness(harnessId).glyph}
          </text>
        </box>
      ) : null}
      {v.bot ? <box width={2} flexShrink={0}><text fg={dim ?? v.bot.fg}>{v.bot.glyph}</text></box> : null}
      {v.review ? <box width={2} flexShrink={0}><text fg={dim ?? v.review.fg}>{v.review.glyph}</text></box> : null}
      {v.mq ? (
        <box width={4} flexShrink={0}><text fg={dim ?? mqStateBadge(v.mq.state).fg}>{mqText}</text></box>
      ) : prBadge ? (
        <box width={2} flexShrink={0}><text fg={dim ?? prBadge.fg}>{prBadge.glyph}</text></box>
      ) : null}
      {v.checks ? <box width={2} flexShrink={0}><text fg={dim ?? v.checks.fg}>{v.checks.glyph}</text></box> : null}
    </box>
  );
}

/** Local adapter retained for callers that still own a WorktreeRow. */
export function badgeClusterCells(
  row: WorktreeRow,
  actionRunning: boolean,
  activeHarnessId: HarnessId | undefined,
): number {
  return worktreeBadgeClusterCells(
    localBadgeSignals(row, actionRunning, activeHarnessId),
  );
}

/** Local adapter retained for list/section composition. */
export function BadgeCluster({
  row,
  actionRunning,
  activeHarnessId,
  sessionState,
}: {
  row: WorktreeRow;
  actionRunning: boolean;
  activeHarnessId: HarnessId | undefined;
  sessionState: DerivedState | undefined;
}) {
  return (
    <WorktreeBadgeCluster
      signals={localBadgeSignals(row, actionRunning, activeHarnessId, sessionState)}
    />
  );
}
