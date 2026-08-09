import { useEffect, useMemo, useState } from "react";

import type { ActionRun } from "../../core/actions.ts";
import { createLogger } from "../../core/logger.ts";
import {
  type Output,
  actionOutputId,
  destroyOutputId,
  eventsOutputId,
  outputsForSlug,
} from "../../core/outputs.ts";
import { StatusKind } from "../../core/types.ts";
import { useOutputs } from "./useOutputs.ts";
import type { WorktreeRow } from "./useWorktreeRows.ts";

type SlugFocus = { focused: string | null };
const NO_ROW_KEY = "__no_row__";
const EMPTY_FOCUS: SlugFocus = { focused: null };

type Args = {
  rows: readonly WorktreeRow[];
  currentSlug: string | undefined;
  currentRun: ActionRun | null;
  showActionViewer: boolean;
};

export function useOutputFocus({
  rows,
  currentSlug,
  currentRun,
  showActionViewer,
}: Args) {
  const [slugFocus, setSlugFocus] = useState<Record<string, SlugFocus>>({});

  const destroyingSlugs = useMemo(
    () =>
      rows
        .filter(
          (r) => r.status.kind === StatusKind.Busy && r.status.op === "remove",
        )
        .map((r) => r.wt.slug),
    [rows],
  );
  const outputs = useOutputs({ destroyingSlugs });
  const focusKey = currentSlug ?? NO_ROW_KEY;
  const focusBucket = slugFocus[focusKey] ?? EMPTY_FOCUS;
  const visibleOutputs = useMemo(
    () => outputsForSlug(outputs, currentSlug ?? null),
    [outputs, currentSlug],
  );
  const isDestroying =
    currentSlug !== undefined && destroyingSlugs.includes(currentSlug);

  // Auto-focus shows the attention feed by default — navigating onto a
  // row no longer surfaces its harness session output (that was churn:
  // every j/k flipped the pane). The two exceptions are event-driven,
  // not navigation-driven: a destroy in flight and a just-launched
  // action run genuinely ARE "what's happening right now". An explicit
  // `'` pick is remembered per worktree (slugFocus below) until the
  // output dies or the worktree goes away.
  const autoOutputId = useMemo<string>(() => {
    if (currentSlug && isDestroying) {
      return destroyOutputId(currentSlug);
    }
    if (currentSlug && currentRun && showActionViewer) {
      return actionOutputId(currentSlug, currentRun.startedAt);
    }
    return eventsOutputId();
  }, [currentSlug, isDestroying, currentRun?.startedAt, showActionViewer]);

  const desiredOutputId = focusBucket.focused ?? autoOutputId;
  const displayedOutput: Output =
    visibleOutputs.find((o) => o.id === desiredOutputId) ??
    visibleOutputs.find((o) => o.id === autoOutputId) ??
    visibleOutputs[0]!;

  useEffect(() => {
    const liveSlugs = new Set<string>([NO_ROW_KEY]);
    for (const r of rows) liveSlugs.add(r.wt.slug);
    const liveOutputIds = new Set<string>();
    for (const o of outputs) liveOutputIds.add(o.id);

    let changed = false;
    const next: Record<string, SlugFocus> = {};
    const evictedSlugs: string[] = [];
    for (const [key, bucket] of Object.entries(slugFocus)) {
      if (!liveSlugs.has(key)) {
        if (bucket.focused !== null) evictedSlugs.push(key);
        changed = true;
        continue;
      }
      const focused =
        bucket.focused && liveOutputIds.has(bucket.focused)
          ? bucket.focused
          : null;
      if (focused !== bucket.focused) changed = true;
      if (focused === null) {
        changed = true;
        continue;
      }
      next[key] = { focused };
    }

    if (!changed) return;
    for (const key of evictedSlugs) {
      createLogger("[app]").event.dim(`dropped output state for ${key} (worktree gone)`);
    }
    setSlugFocus(next);
  }, [outputs, rows, slugFocus]);

  function setFocus(slug: string | null, patch: Partial<SlugFocus>): void {
    const key = slug ?? NO_ROW_KEY;
    setSlugFocus((prev) => {
      const cur = prev[key] ?? EMPTY_FOCUS;
      const next = { ...cur, ...patch };
      if (next.focused === null) {
        if (!(key in prev)) return prev;
        const { [key]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [key]: next };
    });
  }

  return {
    visibleOutputs,
    displayedOutput,
    focusedOutputId: focusBucket.focused,
    setFocus,
  };
}
