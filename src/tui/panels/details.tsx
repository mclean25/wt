/**
 * Worktree details pane — driver only.
 *
 * Layout principles (relevant to row authors):
 *
 * - **Stable identity at top, dynamic activity at bottom.** The
 *   default order in `config.ui.rows` is tuned this way. Users can
 *   override but should follow the same churn-rate principle.
 *
 * - **Compact dense rows beat short stacked rows.** Related info
 *   collapses onto one line with `·`-separated segments — see
 *   `rows/git.tsx` and `rows/pr.tsx` for the established pattern.
 *
 * - **Staleness glyph and error display are handled here, not in row
 *   modules.** Modules declare their `sources`; this driver computes
 *   the trailing glyph and, once retries are exhausted, replaces the
 *   row body with the source's error message verbatim.
 *
 * - **Icons and colors follow `tui/badges.ts` and `tui/icons.ts`.**
 *   Same-concept-same-glyph between this pane and the row list is
 *   enforced via shared helpers.
 */
import { memo, type RefObject } from "react";
import { TextAttributes } from "@opentui/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { config } from "../../core/config.ts";
import type { ReviewRequestPr } from "../../core/github.ts";
import type { DerivedState } from "../../core/harness/status.ts";
import { StatusKind, type PrComment, type Worktree } from "../../core/types.ts";
import { useGithub } from "../../state/hooks.ts";
import { useHarnessSessions } from "../hooks/useHarnessSessions.ts";
import { useNowTick } from "../hooks/useNowTick.ts";
import { usePrimaryHarness } from "../hooks/usePrimaryHarness.ts";
import {
  aiSummaryQuery,
  wtDiffContextQuery,
  wtStateQuery,
} from "../../state/queries.ts";
import { resolveRows, type RowModule } from "../rows/index.ts";
import type { FetchLike, RowContext } from "../rows/types.ts";
import { WtScrollbox } from "../scrollbox.tsx";
import { ageMsToText, ELLIPSIS, truncateEnd } from "../text.ts";
import { Spinner, useBouncingBall } from "../spinner.tsx";
import { theme } from "../theme.ts";
import type { TitleSource, WorktreeRow } from "../hooks/useWorktreeRows.ts";
import type { RemovedWorktree } from "../../core/wtstate.ts";
import {
  isRemoteSummary,
  remoteEntryKey,
  remoteEntryLabel,
  type RemoteListEntry,
} from "../remote-creation.ts";
import { NF } from "../icons.ts";
import { Row } from "./details/row-cell.tsx";
import { RebaseBlock } from "./details/rebase-block.tsx";
import { WorkStatusBlock } from "./details/work-status-block.tsx";
import { RemovedBody } from "./details/removed-body.tsx";
import { ReviewRequestBody } from "./details/review-request-body.tsx";
import {
  SectionSummaryBody,
  type SectionMember,
  type SectionDetail,
} from "./details/section-summary-body.tsx";

export type { SectionMember, SectionDetail };

type Props = {
  row?: WorktreeRow;
  reviewRequest?: ReviewRequestPr;
  /** Set when a folded section header is selected — shows the stack summary. */
  section?: SectionDetail;
  /** Set in the removed-worktrees view (`h`) — shows the history snapshot. */
  removed?: RemovedWorktree;
  /** Transient SSH-hosted worktree selected in the local Inbox. */
  remote?: RemoteListEntry;
  remoteUnavailable?: boolean;
  remoteError?: string | null;
  width: number;
  /**
   * Ref to the inner scrollbox of whichever body is mounted, so the
   * app's global key handler can page it on PageUp/PageDown. Only one
   * body mounts at a time, so a single ref covers both the worktree and
   * review-request panes; switching rows remounts the box and resets
   * scroll to the top.
   */
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
  /**
   * Derived state of the selected row's active (F12-target) session,
   * when one is live. Feeds the rebase block's "conflict being
   * resolved" tint — same signal the list cluster reads.
   */
  sessionState?: DerivedState;
};

const RESOLVED_ROWS: readonly RowModule[] = resolveRows(config.ui.rows);

type GlyphKind = "spinner" | "ellipsis" | null;

/**
 * Row staleness indicator aggregated across a module's sources. Ellipsis
 * before any source has data (cold load); the animated spinner once
 * anything is in flight with cached data behind it; nothing when idle.
 */
function combinedGlyph(fs: readonly FetchLike[]): GlyphKind {
  if (fs.length === 0) return null;
  const anyFetching = fs.some((f) => f.isFetching);
  if (!anyFetching) return null;
  const anyHasData = fs.some((f) => f.data !== undefined);
  return anyHasData ? "spinner" : "ellipsis";
}

/**
 * First source whose retries are exhausted. Gating on `!isFetching`
 * suppresses the transient mid-retry error state — we only show the
 * banner once react-query has actually given up for now.
 */
function firstError(fs: readonly FetchLike[]): Error | null {
  for (const f of fs) {
    if (f.error && !f.isFetching) return f.error;
  }
  return null;
}

function Glyph({ kind }: { kind: GlyphKind }) {
  if (kind === null) return null;
  if (kind === "spinner") return <Spinner fg={theme.fgDim} />;
  return <text fg={theme.fgDim}>{ELLIPSIS}</text>;
}

/**
 * Italic summary line with a trailing spinner. Sub-component (rather
 * than embedding the spinner via `<span>` inside `<text>`) so the
 * spinner frame ends up as plain text content, which the reconciler
 * updates reliably.
 */
function SummaryWithSpinner({ summary }: { summary: string }) {
  const frame = useBouncingBall();
  return (
    <text fg={theme.fgDim} attributes={TextAttributes.ITALIC} wrapMode="word">
      {summary} {frame}
    </text>
  );
}

function GeneratingLine() {
  const frame = useBouncingBall();
  return (
    <text fg={theme.fgDim} attributes={TextAttributes.ITALIC}>
      Generating summary{ELLIPSIS} {frame}
    </text>
  );
}

/**
 * Right-aligned label column width: longest configured row label plus a
 * one-cell gap before the value column. Computed at module init from
 * `RESOLVED_ROWS` so reconfiguring `ui.rows` reclaims unused cells.
 */
const LABEL_WIDTH =
  RESOLVED_ROWS.reduce((m, r) => Math.max(m, r.label.length), 0) + 1;
/** Reserved cells for the trailing staleness glyph slot (1-cell `paddingLeft` + 2-cell spinner). */
const GLYPH_SLOT_WIDTH = 3;
/**
 * Border (1 left + 1 right) + content padding (1 each side) + the
 * scrollbox's reserved scrollbar column (`paddingRight: 1` on its
 * content — see the scrollbox below).
 */
const PANE_CHROME_WIDTH = 5;

/** Compute the row-value cell budget from the pane's outer width. */
function valueWidthFor(paneWidth: number): number {
  return Math.max(0, paneWidth - PANE_CHROME_WIDTH - LABEL_WIDTH - GLYPH_SLOT_WIDTH);
}

function RenderedRow({ module: m, ctx }: { module: RowModule; ctx: RowContext }) {
  if (m.visible && !m.visible(ctx)) return null;
  const sources = m.sources ? m.sources(ctx) : [];
  const err = firstError(sources);
  const glyph = combinedGlyph(sources);
  return (
    <Row
      label={m.label}
      labelWidth={LABEL_WIDTH}
      trailing={glyph ? <Glyph kind={glyph} /> : undefined}
    >
      {err ? (
        <text fg={theme.err} wrapMode="none" truncate>
          {err.message}
        </text>
      ) : (
        m.render(ctx)
      )}
    </Row>
  );
}

/**
 * Border title for the details pane: the worktree's TITLE (best
 * available source), not its slug — the slug is already the list-pane
 * row and the `path` row, while the title used to cost two body lines
 * right at the top of a vertically tight pane. The muted `(source)`
 * tag stays so stale PR titles vs. fresh LLM ones remain spottable at
 * a glance; the whole thing renders in the border color (a border
 * title is chrome, not content). End-truncated by hand, with margin:
 * opentui's native drawBox DROPS a title that doesn't fit between the
 * corner chrome rather than clipping it, so an over-budget title
 * blanks the whole bar — observed at 110 cols, where titles within 3
 * cells of the pane width vanished under the old
 * `width - PANE_CHROME_WIDTH` budget while shorter ones rendered.
 */
function paneTitle(title: string, source: TitleSource, width: number): string {
  const suffix = ` (${source})`;
  const budget = Math.max(0, width - 8 - Bun.stringWidth(suffix));
  return ` ${truncateEnd(title, budget)}${suffix} `;
}

/**
 * One comment: a `@author · 2h ago` meta line, then the body on the
 * lines below (bodies can be long / multi-line, so they get their own
 * line rather than flowing after a colon). A malformed timestamp just
 * drops the age suffix.
 */
function CommentLine({ comment, first }: { comment: PrComment; first: boolean }) {
  const ts = Date.parse(comment.createdAt);
  const age = Number.isFinite(ts) ? ` · ${ageMsToText(Date.now() - ts)} ago` : "";
  return (
    <box marginTop={first ? 0 : 1}>
      <text fg={theme.fg} wrapMode="word">
        <span attributes={TextAttributes.BOLD}>@{comment.author}</span>
        <span fg={theme.fgDim}>{age}</span>
        {`\n${comment.body}`}
      </text>
    </box>
  );
}

/**
 * The PR's human conversation, newest-first: issue comments + review
 * bodies (bots already filtered out upstream). A trailing dim line
 * reports unresolved review threads, whose bodies we deliberately don't
 * inline. Renders nothing when there's neither a comment nor an open
 * thread. Sits at the bottom of the pane, below the AI description.
 */
function CommentsBlock({
  comments,
  unresolvedThreads,
}: {
  comments: readonly PrComment[];
  unresolvedThreads: number;
}) {
  if (comments.length === 0 && unresolvedThreads === 0) return null;
  return (
    <box marginTop={1} flexDirection="column">
      {comments.map((c, i) => (
        <CommentLine key={`${c.author}-${c.createdAt}-${i}`} comment={c} first={i === 0} />
      ))}
      {unresolvedThreads > 0 ? (
        <box marginTop={comments.length > 0 ? 1 : 0}>
          <text fg={theme.fgDim}>
            {`+${unresolvedThreads} unresolved ${unresolvedThreads === 1 ? "thread" : "threads"}`}
          </text>
        </box>
      ) : null}
    </box>
  );
}

/**
 * Dim one-liner flagging that automations are paused for this scope
 * (worktree, or its whole stack). Deliberately details-pane-only — the
 * list stays free of automation chrome; the global pause has its own
 * title-bar indicator.
 */
function AutomationsPausedLine({ scope }: { scope: "worktree" | "stack" }) {
  return (
    <box marginTop={1}>
      <text wrapMode="none" truncate>
        <span fg={theme.warn}>{"⏸ "}</span>
        <span fg={theme.fgDim}>
          {scope === "stack"
            ? "automations paused for this stack (ctrl+a resumes)"
            : "automations paused for this worktree (ctrl+a resumes)"}
        </span>
      </text>
    </box>
  );
}

/**
 * The harness's own wrap-up line for the row's F12-target session —
 * claude appends a `summary` entry when a session winds down, and the
 * tail exposes it only while nothing newer follows (stale summaries
 * vanish). Sits directly above the AI diff summary: "what the agent
 * says it did" over "what the diff says changed". Muted but upright,
 * against the description's italics. No header — the voice contrast
 * is the label.
 */
function SessionSummaryLine({ wt }: { wt: Worktree }) {
  const primary = usePrimaryHarness();
  const { f12Target } = useHarnessSessions(wt.slug, wt.path, primary);
  const summary = f12Target?.extras.sessionSummary ?? null;
  if (!summary) return null;
  return (
    <box marginTop={1}>
      <text fg={theme.fgDim} wrapMode="word">
        {summary}
      </text>
    </box>
  );
}

/**
 * Multi-line AI summary below the rows. Renders muted text, falls back
 * to a placeholder while the first generation is in flight, and stays
 * silent on errors / when the row is dirty-but-uncached (avoid noise).
 * `null` summary means "AI not configured" and the section is omitted
 * entirely.
 */
function DescriptionBlock({
  summary,
  isLlmRunning,
  hasContext,
  blockedReason,
  error,
}: {
  summary: string | null;
  /**
   * True only while the AI endpoint call itself is in flight — *not* for
   * the cheap diff-context revalidation. Drives the refresh glyph and
   * the "generating summary…" placeholder. Intentionally narrower than
   * the per-row staleness glyph elsewhere: a hash-stable cache check
   * shouldn't make this row look like it's regenerating when it isn't.
   */
  isLlmRunning: boolean;
  hasContext: boolean;
  blockedReason: string | null;
  error: Error | null;
}) {
  // No AI config and no cached value → don't reserve space.
  if (!summary && !isLlmRunning && !hasContext && !blockedReason && !error) return null;
  let body: React.ReactNode;
  // Errors win over everything except an in-flight retry: while
  // re-fetching after a failure we'd rather show "generating…" than
  // the stale error. Once the retry settles, the error reappears (or
  // gets replaced by the new summary).
  if (error && !isLlmRunning) {
    body = (
      <text fg={theme.err} wrapMode="word">
        {error.message}
      </text>
    );
  } else if (summary) {
    body = isLlmRunning ? (
      <SummaryWithSpinner summary={summary} />
    ) : (
      <text fg={theme.fgDim} attributes={TextAttributes.ITALIC} wrapMode="word">
        {summary}
      </text>
    );
  } else if (isLlmRunning) {
    body = <GeneratingLine />;
  } else if (blockedReason) {
    body = <text fg={theme.fgDim}>{blockedReason}</text>;
  } else {
    body = <text fg={theme.fgDim}>No summary yet</text>;
  }
  return <box marginTop={1}>{body}</box>;
}

const DetailsBody = memo(function DetailsBody({
  row,
  width,
  scrollRef,
  sessionState,
}: {
  row: WorktreeRow;
  width: number;
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
  sessionState?: DerivedState;
}) {
  // Subscribe to the combined GitHub fetch so per-row indicators
  // reflect its fetch state. Observers dedupe by key — this doesn't
  // trigger an extra fetch, it joins the existing observer in
  // `useWorktreeRows`.
  const github = useGithub();

  const isBusy = row.status.kind === StatusKind.Busy;
  // The diff context is `base..HEAD` only — uncommitted work is never
  // included, so a dirty tree doesn't change what the AI would see.
  // Only pause for busy worktrees, where racing the destroy is unsafe.
  const aiEnabled = !!config.ai;
  const allowFetch = aiEnabled && !isBusy;

  // Diff context + summary observers are duplicated with `useWorktreeRows`
  // (cache-shared, not refetched) so this pane has direct access to the
  // *description* and the per-fetch state for the spinner / error
  // gating, neither of which is exposed on `WorktreeRow`. The resolved
  // title itself comes pre-computed from the row.
  //
  // The diff base is resolved once in `useWorktreeRows` and exposed via
  // `row.stackedOn.diffBase`. Reading it from there (rather than
  // re-deriving) keeps the two observers' query keys identical, which
  // is what lets the cache hit cross-pane and avoids re-running LM
  // Studio every time the details pane mounts for a stacked worktree.
  const effectiveBase = row.stackedOn?.diffBase ?? null;
  const diffCtx = useQuery({
    ...wtDiffContextQuery(row.wt, effectiveBase),
    enabled: allowFetch,
  });

  // Per-worktree / per-stack automations pause indicator. Joins the
  // wtState observer already alive in `useWorktreeRows` (cache-shared).
  // Stack pause wins the label — it explains why a slice with no flag
  // of its own is still protected. The global pause is title-bar chrome,
  // not repeated here.
  const wtState = useQuery({
    ...wtStateQuery(),
    enabled: config.automations.length > 0,
  });
  const stackPaused =
    !!row.stack &&
    (wtState.data?.pausedStacks ?? []).includes(row.stack.stackId);
  const slugPaused =
    wtState.data?.slugs[row.wt.slug]?.automationsPaused === true;
  const pausedScope: "stack" | "worktree" | null =
    config.automations.length === 0
      ? null
      : stackPaused
        ? "stack"
        : slugPaused
          ? "worktree"
          : null;

  // Hash-keyed AI summary: when the diff hash changes, the queryKey
  // changes; `keepPreviousData` keeps the prior summary on screen
  // while the new fetch runs. The mismatch-detect effect that lived
  // here in the slug-keyed era is gone — the cache key swap *is* the
  // trigger now.
  const summary = useQuery({
    ...aiSummaryQuery(row.wt.slug, diffCtx.data ?? null),
    enabled: allowFetch && !!diffCtx.data,
    placeholderData: keepPreviousData,
  });

  const valueWidth = valueWidthFor(width);
  // No useMemo: `github` is a UseQueryResult wrapper with a fresh identity
  // every render, so a memo keyed on it would never hold anyway — build
  // the ctx inline and keep the cost honest. Rows re-render with the pane
  // regardless (none are React.memo'd on ctx identity).
  const ctx: RowContext = { row, github, valueWidth };

  // Pick a single user-facing reason when we're suppressing AI work.
  const blockedReason: string | null = !aiEnabled
    ? null
    : isBusy
      ? "Summary paused while worktree is busy"
      : null;

  return (
    <box
      flexGrow={1}
      flexShrink={1}
      overflow="hidden"
      border
      borderStyle="single"
      borderColor={theme.border}
      title={paneTitle(row.title, row.titleSource, width)}
      titleAlignment="left"
      padding={1}
      flexDirection="column"
    >
      <WtScrollbox scrollRef={scrollRef}>
        {/* Asserted work status, full width — the note is the payload
            (merge impacts, needs-human asks) and must never truncate. */}
        <WorkStatusBlock row={row} contentWidth={Math.max(0, width - PANE_CHROME_WIDTH)} />
        {RESOLVED_ROWS.map((m) => (
          <RenderedRow key={m.id} module={m} ctx={ctx} />
        ))}
        {/* Rebase lifecycle (restacking / mid-rebase / resolving /
            conflict + files) renders as a block below the definitions —
            the conflict file list never fit the one-line definition
            format. */}
        <RebaseBlock row={row} sessionState={sessionState} />
        {pausedScope ? <AutomationsPausedLine scope={pausedScope} /> : null}
        <SessionSummaryLine wt={row.wt} />
        <DescriptionBlock
          summary={summary.data?.description ?? null}
          isLlmRunning={summary.isFetching}
          hasContext={!!diffCtx.data}
          blockedReason={blockedReason}
          error={summary.error ?? diffCtx.error ?? null}
        />
        <CommentsBlock
          comments={row.pr?.comments ?? []}
          unresolvedThreads={row.pr?.unresolvedThreads ?? 0}
        />
      </WtScrollbox>
    </box>
  );
});

function RemoteDetails({
  entry,
  unavailable,
  error,
}: {
  entry: RemoteListEntry;
  unavailable: boolean;
  error: string | null;
}) {
  const status = unavailable
    ? "host unavailable"
    : isRemoteSummary(entry)
      ? entry.statusLabel
      : entry.status;
  return (
    <box
      flexGrow={1}
      flexShrink={1}
      // Every detail body clips: a pane that overflows doesn't stop at
      // its own border, it paints over whatever is below it.
      overflow="hidden"
      border
      borderStyle="single"
      borderColor={theme.border}
      title={` ${remoteEntryLabel(entry)} `}
      titleAlignment="left"
      padding={1}
      flexDirection="column"
    >
      <text fg={theme.fg} attributes={TextAttributes.BOLD}>
        {`${NF.remote} Remote worktree`}
      </text>
      <box marginTop={1} flexDirection="column">
        <text><span fg={theme.fgDim}>host   </span>{entry.hostLabel}</text>
        <text>
          <span fg={theme.fgDim}>state  </span>
          <span fg={unavailable ? theme.warn : theme.fg}>{status}</span>
        </text>
        {isRemoteSummary(entry) ? (
          <>
            <text><span fg={theme.fgDim}>branch </span>{entry.branch}</text>
            <text><span fg={theme.fgDim}>path   </span>{entry.path}</text>
          </>
        ) : null}
      </box>
      <box marginTop={1}>
        <text fg={unavailable ? theme.warn : theme.fgDim}>
          {unavailable
            ? error ?? "SSH host is offline; showing the last-known worktree state."
            : isRemoteSummary(entry)
            ? "F10 shell · F11 diff · F12 AI session"
            : "Remote checkout is being prepared."}
        </text>
      </box>
    </box>
  );
}

/**
 * Memoized: props are identity-stable across unrelated App renders
 * (`row` via the useWorktreeRows cache, `section` via its hook memo,
 * the rest primitives/refs), so background churn elsewhere doesn't
 * re-render the pane. The 30s age tick below is internal state and
 * unaffected by the memo boundary.
 */
export const Details = memo(function Details({
  row,
  reviewRequest,
  section,
  removed,
  remote,
  remoteUnavailable = false,
  remoteError = null,
  width,
  scrollRef,
  sessionState,
}: Props) {
  // Ages ("· 17s ago", "committed 54s") are computed at render time;
  // tick so they don't freeze on a quiet instance.
  useNowTick();
  if (removed) {
    // Key by slug so cursor moves across history entries remount cleanly.
    return <RemovedBody key={`removed:${removed.slug}`} entry={removed} width={width} />;
  }
  if (section) {
    return (
      <SectionSummaryBody
        key={`section:${section.sectionKey}`}
        section={section}
        width={width}
        scrollRef={scrollRef}
      />
    );
  }
  if (reviewRequest) {
    // Key by url so navigating across review-request rows remounts
    // cleanly — no chance of bleeding state from one PR to another.
    return (
      <ReviewRequestBody
        key={reviewRequest.url}
        pr={reviewRequest}
        scrollRef={scrollRef}
      />
    );
  }
  if (remote) {
    return (
      <RemoteDetails
        key={`remote:${remoteEntryKey(remote)}`}
        entry={remote}
        unavailable={remoteUnavailable}
        error={remoteError}
      />
    );
  }
  if (!row) {
    return (
      <box
        flexGrow={1}
        border
        borderStyle="single"
        borderColor={theme.border}
        title=" details "
        titleAlignment="left"
        padding={1}
      >
        <text fg={theme.fgDim}>No worktree selected.</text>
      </box>
    );
  }
  // Key by slug so the AI summary observer below resets across
  // worktree switches. Without this, `placeholderData: keepPreviousData`
  // bleeds the previous slug's summary into the new slug whenever the
  // new slug has no cache entry (cold key, or disabled because no diff
  // context yet) — so navigating A → B parks A's description on B until
  // B's own fetch lands or the user restarts.
  return (
    <DetailsBody
      key={row.wt.slug}
      row={row}
      width={width}
      scrollRef={scrollRef}
      sessionState={sessionState}
    />
  );
});
