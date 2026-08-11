import { useMemo } from "react";

import type { WtState } from "../../core/wtstate.ts";
import type { ActiveSessionGlyph } from "./useHarnessSessions.ts";
import type { SectionDetail } from "../panels/details.tsx";
import { rowLabel } from "../panels/list.tsx";
import type { SelectedSection } from "./useVisualItems.ts";

type UseSectionDetailArgs = {
  selectedSection: SelectedSection | undefined;
  wtState: WtState | undefined;
  activeActions: ReadonlySet<string>;
  activeSessionBySlug: ReadonlyMap<string, ActiveSessionGlyph>;
};

export function useSectionDetail({
  selectedSection,
  wtState,
  activeActions,
  activeSessionBySlug,
}: UseSectionDetailArgs): SectionDetail | undefined {
  return useMemo<SectionDetail | undefined>(() => {
    if (!selectedSection) return undefined;
    // A section can hold several stacks and several loose rows, so
    // "paused" is per member: individually (its own slug record) or via
    // the stack it belongs to (Ctrl+A pauses a whole stack).
    const pausedStacks = new Set(wtState?.pausedStacks ?? []);
    const pausedCount = selectedSection.rows.filter(
      (r) =>
        wtState?.slugs[r.wt.slug]?.automationsPaused === true ||
        (r.stack ? pausedStacks.has(r.stack.stackId) : false),
    ).length;
    return {
      sectionKey: selectedSection.sectionKey,
      label: selectedSection.label,
      pausedCount,
      members: selectedSection.rows.map((r) => ({
        label: rowLabel(r),
        row: r,
        actionRunning: activeActions.has(r.wt.slug),
        activeHarnessId: activeSessionBySlug.get(r.wt.slug)?.harnessId,
        sessionState: activeSessionBySlug.get(r.wt.slug)?.state ?? undefined,
      })),
    };
  }, [selectedSection, wtState, activeActions, activeSessionBySlug]);
}
