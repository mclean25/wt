import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { wtStateQuery } from "../../state/index.ts";

/**
 * Fold state + the wtstate query the list pane needs.
 *
 * This used to also generate an AI TITLE per stack, because a stack was
 * its own pseudo-section and therefore needed a header. Stacks now
 * render as a spine INSIDE the human's section, so there is no stack
 * header to name — the section already has the name the human gave it,
 * and generating a second one was the thing that produced three
 * mutually indistinguishable headers all reading "stack".
 */
export function useStackSections() {
  const wtStateForStacks = useQuery(wtStateQuery());
  const foldedSections = useMemo<ReadonlySet<string>>(
    () => new Set(wtStateForStacks.data?.foldedSections ?? []),
    [wtStateForStacks.data?.foldedSections],
  );
  return { wtStateForStacks, foldedSections };
}
