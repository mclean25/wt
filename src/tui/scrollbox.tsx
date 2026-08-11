/**
 * The one scrolling standard for the TUI. Every scroll surface — panes,
 * modals, overlays — goes through this module so they all share:
 *
 * - **Step size.** `SCROLL_STEP` rows per line-scroll keystroke,
 *   everywhere: the bottom-pane feed chord, the details-pane chord, and
 *   overlay j/k. Key-repeat makes held scrolling smooth; viewport-
 *   proportional jumps (OpenTUI's focused-scrollbox default of 1/5, or
 *   the old 0.85 details page) read as teleports on tall panes.
 *   Half-viewport paging stays on PgUp/PgDn (+ Ctrl+D/U) only.
 * - **Scrollbar look.** One themed thumb/track (`SCROLLBAR_OPTIONS`)
 *   instead of the library's unthemed grays, and a reserved one-column
 *   gutter (`paddingRight: 1` on the content) so the thumb never sits
 *   on top of the last character of a full-width row.
 * - **No mount flash** via `useScrollbarNoFlash`.
 *
 * Use `WtScrollbox` for any new scroll region; a bare `<scrollbox>` is
 * only justified where one of the shared defaults genuinely can't
 * apply (none today).
 */
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { KeyEvent, ScrollBoxRenderable } from "@opentui/core";

import { isShiftedLetter } from "./app-helpers.ts";
import { useScrollbarNoFlash } from "./hooks/useScrollbarNoFlash.ts";
import { theme } from "./theme.ts";

/** Rows moved per line-scroll keystroke, on every scroll surface. */
export const SCROLL_STEP = 3;

/**
 * Themed scrollbar: dim thumb on a border-dim track, matching the pane
 * chrome. Applied by `WtScrollbox`; exported for the rare direct
 * `<scrollbox>` (none today).
 */
export const SCROLLBAR_OPTIONS = {
  trackOptions: {
    foregroundColor: theme.fgDim,
    backgroundColor: theme.borderDim,
  },
} as const;

type Props = {
  /** External handle for imperative scrolling (paging, toEdge, into-view). */
  scrollRef?: RefObject<ScrollBoxRenderable | null>;
  /** Follow appended content while the user hasn't scrolled back. */
  stickyScroll?: boolean;
  stickyStart?: "bottom" | "top";
  /**
   * Merged over the shared content defaults. Note `paddingRight: 1`
   * (the scrollbar gutter) is part of the standard — override only
   * with a reason.
   */
  contentOptions?: Record<string, unknown>;
  children: ReactNode;
};

/** The standard scroll region: themed bar, gutter, no mount flash. */
export function WtScrollbox({
  scrollRef,
  stickyScroll,
  stickyStart,
  contentOptions,
  children,
}: Props) {
  const ref = useScrollbarNoFlash(scrollRef);
  return (
    <scrollbox
      ref={ref}
      scrollY
      stickyScroll={stickyScroll}
      stickyStart={stickyStart}
      flexGrow={1}
      minHeight={0}
      verticalScrollbarOptions={SCROLLBAR_OPTIONS}
      contentOptions={{
        flexDirection: "column",
        paddingRight: 1,
        ...contentOptions,
      }}
    >
      {children}
    </scrollbox>
  );
}

/**
 * Handle to the scrollbox of whichever full-screen overlay (help /
 * perf / errors) is currently mounted — at most one exists at a time.
 * Same shape as `activityScroll` (panels/activity.tsx): the mounted
 * panel registers itself, the keyboard layer scrolls it without
 * owning focus or prop-drilling through the modal host.
 */
export const overlayScroll: { current: ScrollBoxRenderable | null } = {
  current: null,
};

/** Register a panel's scrollbox as THE overlay scroll target while mounted. */
export function useOverlayScroll(): RefObject<ScrollBoxRenderable | null> {
  const ref = useRef<ScrollBoxRenderable>(null);
  useEffect(() => {
    overlayScroll.current = ref.current;
    return () => {
      if (overlayScroll.current === ref.current) overlayScroll.current = null;
    };
  }, []);
  return ref;
}

/**
 * Shared scroll keymap for the full-screen overlays, replacing the
 * focused-scrollbox built-in (which steps 1/5 viewport — a different
 * feel from every other pane). j/k/↑/↓ move `SCROLL_STEP` rows —
 * plus Ctrl+J/K and Ctrl+E/Y so the bottom-pane chords keep working
 * inside an overlay — PgDn/PgUp (and vim Ctrl+D/U) move half a
 * viewport, g/G and Home/End jump to the edges (the list pane's g/G
 * convention). Returns false for anything else so the overlay's own
 * keys run; callers invoke this first, except inside text-input modes
 * (help search).
 */
export function handleOverlayScrollKey(k: KeyEvent): boolean {
  const box = overlayScroll.current;
  if (!box) return false;
  const plain = !k.ctrl && !k.meta && !k.shift;
  const chord = k.ctrl && !k.meta && !k.shift;
  if (
    (plain && (k.name === "j" || k.name === "down")) ||
    (chord && (k.name === "j" || k.name === "e")) ||
    k.name === "linefeed"
  ) {
    box.scrollBy(SCROLL_STEP);
    return true;
  }
  if (
    (plain && (k.name === "k" || k.name === "up")) ||
    (chord && (k.name === "k" || k.name === "y"))
  ) {
    box.scrollBy(-SCROLL_STEP);
    return true;
  }
  if (k.name === "pagedown" || (chord && k.name === "d")) {
    box.scrollBy(0.5, "viewport");
    return true;
  }
  if (k.name === "pageup" || (chord && k.name === "u")) {
    box.scrollBy(-0.5, "viewport");
    return true;
  }
  if ((plain && k.name === "g") || k.name === "home") {
    box.scrollBy(-1, "content");
    return true;
  }
  if (isShiftedLetter(k, "g") || k.name === "end") {
    box.scrollBy(1, "content");
    return true;
  }
  return false;
}
