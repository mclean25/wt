import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSyncExternalStore } from "react";

import {
  RECENT_WINDOW_MS,
  actionRegistry,
  type ActionRun,
} from "../../core/actions.ts";

/**
 * The current run for a slug, or `null` when there is none. Per-key
 * selector: the registry replaces only the touched entry on an update,
 * so this re-renders on THIS slug's run changing (per-line while it
 * streams — which is load-bearing: the action viewer reads the
 * registry non-reactively and rides its parent's re-render), never on
 * other slugs' runs.
 */
export function useAction(slug: string | undefined): ActionRun | null {
  const get = useCallback(
    () => (slug ? actionRegistry.getSnapshot().get(slug) ?? null : null),
    [slug],
  );
  return useSyncExternalStore(actionRegistry.subscribe, get, get);
}

/**
 * Set of slugs whose action is *currently* running (not the recent
 * window — that's handled separately by `useActionVisible`). Drives
 * the per-row glyph in the worktree list. Membership is computed from
 * the registry snapshot inside `useMemo`, which re-runs whenever the
 * registry mutates; every run-line append produces a new map identity,
 * but consumers only care about which slugs are running, not how many
 * lines they've emitted.
 */
export function useActiveActions(): ReadonlySet<string> {
  const map = useSyncExternalStore(
    actionRegistry.subscribe,
    actionRegistry.getSnapshot,
    actionRegistry.getSnapshot,
  );
  // Identity-stabilized: the registry snapshot changes on every line a
  // running action emits, but consumers (the memoized list pane, the
  // section detail) only care about membership. Returning the previous
  // Set when membership is unchanged keeps their memo/React.memo
  // boundaries intact through an action's output stream.
  const prevRef = useRef<ReadonlySet<string>>(new Set());
  return useMemo(() => {
    const out = new Set<string>();
    for (const [slug, run] of map) {
      if (run.status === "running") out.add(slug);
    }
    const prev = prevRef.current;
    if (prev.size === out.size && [...out].every((s) => prev.has(s))) {
      return prev;
    }
    prevRef.current = out;
    return out;
  }, [map]);
}

/**
 * Whether a finished run for `slug` is still inside the `RECENT_WINDOW_MS`
 * "recent" window — drives the activity-pane swap. Returns true while
 * the run is running, true for the recent window after exit, false
 * thereafter. Re-evaluates on every registry mutation AND on a
 * dedicated timer that fires once at the window expiry, so the swap
 * unmounts at the right moment without polling every render.
 */
export function useActionVisible(slug: string | undefined): boolean {
  const run = useAction(slug);
  // `tick` forces a re-render at the window boundary.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!run || run.status === "running" || run.endedAt === undefined) return;
    const remaining = RECENT_WINDOW_MS - (Date.now() - run.endedAt);
    if (remaining <= 0) return;
    const timer = setTimeout(() => setTick((n) => n + 1), remaining + 50);
    return () => clearTimeout(timer);
  }, [run?.slug, run?.status, run?.endedAt]);
  if (!run) return false;
  if (run.status === "running") return true;
  return run.endedAt !== undefined && Date.now() - run.endedAt < RECENT_WINDOW_MS;
}
