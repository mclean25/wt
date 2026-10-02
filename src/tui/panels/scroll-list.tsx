import { useEffect, useRef, type ReactNode } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";

import { scrollCursorIntoView, WtScrollbox } from "../scrollbox.tsx";

type Props = {
  /**
   * Stable `id` of the currently-selected child row. When it changes the
   * list scrolls that row into view, so j/k navigation past the fold
   * keeps the cursor on screen instead of clipping at the modal's bottom
   * edge. Rows must carry a matching `id` prop. Omit for a scroll region
   * with no cursor (e.g. a confirm list or a text preview).
   */
  selectedId?: string;
  /**
   * Extra value that should also re-run scroll-into-view when it changes
   * — typically the items array (a rebuild re-anchors the cursor) or the
   * text being typed (so the input stays visible as it grows).
   */
  revision?: unknown;
  children: ReactNode;
};

/**
 * Vertical-scroll wrapper for modal / picker lists whose content can
 * exceed the modal height. A `WtScrollbox` (shared bar styling, gutter,
 * no mount flash) that scrolls the selected row into view as the cursor
 * moves — the shared version of the pattern first used in
 * `removed-list.tsx`. The `Modal` shell clips overflow with no scrollback
 * of its own, so any list that maps unbounded user data (actions,
 * sessions, branches, outputs, clean candidates) must wrap it in this or
 * rows past the fold become unreachable.
 *
 * Rows keep owning their own HORIZONTAL truncation (`wrapMode="none"
 * truncate` inside a `flexGrow`/`flexShrink`/`overflow="hidden"` box);
 * this only handles the vertical axis.
 */
export function ScrollableList({ selectedId, revision, children }: Props) {
  const listRef = useRef<ScrollBoxRenderable>(null);
  const lastLayout = useRef("");
  useEffect(() => {
    if (selectedId) scrollCursorIntoView(listRef.current, selectedId);
  }, [selectedId, revision]);
  return (
    <box
      flexGrow={1}
      flexShrink={1}
      minHeight={0}
      renderAfter={() => {
        const list = listRef.current;
        if (!list || !selectedId) return;
        const selected = list.content.findDescendantById(selectedId);
        if (!selected) return;
        // Effects run before Yoga has placed a newly mounted list. Re-anchor
        // once its viewport is real, and again when a resize changes it.
        // Do not re-anchor unchanged frames: mouse scrolling remains free.
        // Candidate order can change without changing the content height.
        // Relative position stays stable during mouse scrolling.
        const selectedY = selected.y - list.content.y;
        const layout = `${list.viewport.width}:${list.viewport.height}:${list.content.height}:${selectedId}:${selectedY}:${selected.height}`;
        if (layout !== lastLayout.current) {
          lastLayout.current = layout;
          scrollCursorIntoView(list, selectedId);
        }
      }}
    >
      <WtScrollbox scrollRef={listRef}>{children}</WtScrollbox>
    </box>
  );
}
