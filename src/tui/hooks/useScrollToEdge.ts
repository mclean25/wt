import { useEffect, type RefObject } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";

/**
 * Imperative scroll-to-edge control shape the list panel exposes to
 * its parent's j/k handler — identical to `ListScrollHandle`
 * (`panels/list.tsx`), which keeps its own named alias for the public
 * prop but is structurally this same shape.
 */
export type ScrollToEdgeHandle = { toEdge: (dir: "top" | "bottom") => void };

/**
 * Wires `scrollHandle` (the `RefObject` a parent passed down as a prop)
 * to an imperative `toEdge` control backed by `listRef`'s live
 * `ScrollBoxRenderable`. A large `scrollBy` clamps at the content edge,
 * so `toEdge` reveals whatever trailing content the cursor itself can't
 * reach — blank space, or headers below the last selectable row.
 */
export function useScrollToEdge(
  listRef: RefObject<ScrollBoxRenderable | null>,
  scrollHandle: RefObject<ScrollToEdgeHandle | null> | undefined,
): void {
  useEffect(() => {
    if (!scrollHandle) return;
    scrollHandle.current = {
      toEdge: (dir) => listRef.current?.scrollBy(dir === "bottom" ? 9999 : -9999, "viewport"),
    };
    return () => {
      if (scrollHandle) scrollHandle.current = null;
    };
    // `listRef` deliberately excluded: it's a `useRef` object, stable
    // across renders, and the original inline effect in both panels
    // only ever depended on `scrollHandle`.
  }, [scrollHandle]);
}
