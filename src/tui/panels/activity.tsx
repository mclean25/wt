import { Fragment, useEffect, useMemo, useRef } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";

import {
  useAttentionEvents,
  useAttentionSeenTs,
  useEvents,
  type WtEvent,
} from "../activity-log.ts";
import { useScrollbarNoFlash } from "../hooks/useScrollbarNoFlash.ts";
import { theme } from "../theme.ts";

/**
 * Handle to whichever events scrollbox is currently on screen (the
 * bottom pane shows exactly one at a time), so the keyboard layer can
 * scroll it without owning focus — the list panel keeps focus; ctrl+e
 * / ctrl+y (and alt+j/k) route here. Mouse-wheel scrolling is native
 * to the scrollbox and needs no wiring.
 */
export const activityScroll: { current: ScrollBoxRenderable | null } = {
  current: null,
};

function levelFg(level: WtEvent["level"]): string {
  switch (level) {
    case "ok":
      return theme.ok;
    case "warn":
      return theme.warn;
    case "err":
      return theme.err;
    case "info":
      return theme.fg;
    case "dim":
    default:
      return theme.fgDim;
  }
}

function fmtTime(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8);
}

/**
 * Non-slug sources are bracketed by convention (e.g. `[app]`, `[prs]`,
 * `[origin]`). They log cross-cutting system events rather than
 * activity on a specific worktree, so they render dimmer — the bright
 * accent color is reserved for slug-tagged rows.
 */
function sourceFg(source: string): string {
  return source.startsWith("[") ? theme.fgDim : theme.accentAlt;
}

/**
 * Pure renderer for an event tail — caller owns events and chrome.
 * Used by `ActivityContent` (full event log) and `DestroyContent`
 * (events filtered to a single slug).
 */
function EventsList({
  events,
  emptyText,
  seenTs,
  wrap = false,
}: {
  events: readonly WtEvent[];
  emptyText: string;
  /**
   * Attention "seen" watermark (`x`): rows at or before it render
   * entirely dim, with a `── seen HH:MM:SS` rule after the last one —
   * the feed reads "only new stuff" while the handled history stays
   * scrollable. Undefined (firehose, destroy view, never marked) =
   * no dimming, no rule.
   */
  seenTs?: number;
  /**
   * Word-wrap long messages instead of truncating. On for the
   * attention feed — its lines (ready notes, needs-human asks) are the
   * payload and losing their tails made them unreadable — off for the
   * firehose and destroy views, where one-line-per-event scannability
   * wins and the full text is recoverable from the log file.
   * Continuation lines align under the message column for free: the
   * time+source prefix is a fixed-width sibling box, so the wrapped
   * text block starts (and stays) at the message column.
   */
  wrap?: boolean;
}) {
  // Scrollbox with sticky-bottom: follows the live tail like before,
  // releases when the user scrolls up (wheel, or ctrl+e/ctrl+y via
  // `activityScroll`), and re-sticks once they return to the bottom.
  // The full buffer renders as children; viewport culling keeps the
  // per-frame cost at "what's visible", same as the old tail slice.
  const listRef = useRef<ScrollBoxRenderable>(null);
  const scrollRef = useScrollbarNoFlash(listRef);
  useEffect(() => {
    activityScroll.current = listRef.current;
    return () => {
      if (activityScroll.current === listRef.current) activityScroll.current = null;
    };
  }, []);
  if (events.length === 0) {
    return <text fg={theme.fgDim}>{emptyText}</text>;
  }
  // Events are appended in arrival order, so "last seen row" is a
  // single reverse scan; per-row dimming still compares each row's own
  // ts (backfill seeding keeps order too, so the two always agree).
  let lastSeenIdx = -1;
  if (seenTs !== undefined) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]!.ts <= seenTs) {
        lastSeenIdx = i;
        break;
      }
    }
  }
  return (
    <scrollbox
      ref={scrollRef}
      scrollY
      stickyScroll
      stickyStart="bottom"
      flexGrow={1}
      minHeight={0}
      contentOptions={{ flexDirection: "column" }}
    >
      {events.map((e, i) => {
        const seen = seenTs !== undefined && e.ts <= seenTs;
        return (
          <Fragment key={e.id}>
            {/* The prefix (time + source) is grouped into a
                flexShrink=0 container so flex pressure from a long
                message can only shrink the message column — without
                this wrapping, the bare `<text> </text>` spacers get
                zero-width-collapsed under pressure, jamming the
                time+source columns together. `overflow="hidden"` on
                the row clips any residual horizontal overrun; in wrap
                mode the row grows vertically instead and the prefix
                box stays on the first line. Seen rows drop every color
                to fgDim — handled history recedes, new rows keep their
                level colors. */}
            <box flexDirection="row" flexShrink={0} overflow="hidden">
              <box flexShrink={0} flexDirection="row">
                <text fg={theme.fgDim}>{fmtTime(e.ts)}</text>
                <text> </text>
                <text fg={seen ? theme.fgDim : sourceFg(e.source)}>
                  {e.source.slice(0, 16).padStart(16)}
                </text>
                <text> </text>
              </box>
              <box flexGrow={1} flexShrink={1} overflow="hidden">
                <text
                  fg={seen ? theme.fgDim : levelFg(e.level)}
                  wrapMode={wrap ? "word" : "none"}
                  truncate={!wrap}
                >
                  {e.text}
                </text>
              </box>
            </box>
            {i === lastSeenIdx ? (
              // The seen rule: everything above is handled. A blank
              // row above gives it air; when it's the last line the
              // sticky-bottom tail itself reads as "caught up".
              <box flexDirection="row" flexShrink={0} overflow="hidden" marginTop={1}>
                {/* Over-long on purpose; the row box's overflow="hidden"
                    hard-clips it to the pane, so the rule spans full
                    width at any size (no `truncate` — its middle
                    ellipsis would punch a "..." into the rule). */}
                <text fg={theme.fgDim} wrapMode="none">
                  {`── seen ${fmtTime(seenTs!)} ${"─".repeat(400)}`}
                </text>
              </box>
            ) : null}
          </Fragment>
        );
      })}
    </scrollbox>
  );
}

/**
 * Inner content for the events tail — caller owns the surrounding
 * `<box>` chrome. Rendered inside `OutputViewer`'s border when the
 * `events` output is selected.
 */
export function ActivityContent({
  feed = "firehose",
}: {
  /**
   * `attention` shows the curated channel plus any error-level line
   * (an error is attention-worthy wherever it was emitted) from its
   * own reserved buffer, so firehose churn can't evict a needs-you
   * line; `firehose` shows everything, both channels — the superset,
   * not the complement.
   */
  feed?: "attention" | "firehose";
}) {
  const all = useEvents();
  const attention = useAttentionEvents();
  const seenTs = useAttentionSeenTs();
  return (
    <EventsList
      events={feed === "attention" ? attention : all}
      emptyText={feed === "attention" ? "(nothing needs you)" : "(no events yet)"}
      // 0 = never marked. Attention-only: the firehose is the record
      // and stays fully bright.
      seenTs={feed === "attention" && seenTs > 0 ? seenTs : undefined}
      wrap={feed === "attention"}
    />
  );
}

/**
 * Inner content for an in-flight destroy — events filtered to that
 * slug's source. Destroy logs are tailed by `useLogTails` and pushed
 * into the global events log under `source = <slug>`, so this view
 * is the right slice rather than a separate buffer. Slug-tagged
 * non-destroy events for the same slug also land here, but during a
 * destroy the destroy lines dominate by volume.
 */
export function DestroyContent({ slug }: { slug: string }) {
  const events = useEvents();
  const filtered = useMemo(
    () => events.filter((e) => e.source === slug),
    [events, slug],
  );
  return (
    <EventsList events={filtered} emptyText="(waiting for destroy output…)" />
  );
}
