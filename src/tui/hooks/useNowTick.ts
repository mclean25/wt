import { useEffect, useState } from "react";

/**
 * Re-render the subscribing component every `ms` (default 30s).
 *
 * For panes that render wall-clock ages ("needs-human · 17s ago",
 * "committed 54s"): rows compute those strings at render time, and on
 * a quiet instance nothing else re-renders — background refetches that
 * return unchanged data keep TanStack's structural sharing, so an idle
 * pane can freeze an age for minutes. Subscribing is the point; the
 * returned counter exists only so the hook has a value to change.
 */
export function useNowTick(ms = 30_000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((v) => v + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
  return tick;
}
