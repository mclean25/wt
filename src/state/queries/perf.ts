import { queryOptions } from "@tanstack/react-query";

import { samplePerfPromise, type PerfSnapshot } from "../../core/perf.ts";
import { qk } from "../keys.ts";

export type { PerfSnapshot };

/**
 * Resample cadence while the `P` overlay is open. Fast enough that the
 * bars track a burst of test runs, slow enough that three shell-outs per
 * tick stay invisible against the load being measured.
 */
export const PERF_SAMPLE_MS = 2_000;

/**
 * Live perf snapshot for the `P` overlay.
 *
 * The one query in the app that polls as its *primary* mechanism rather
 * than as a backstop. There is no event to push off: nothing notifies us
 * when some process starts burning CPU, and the overlay's whole job is
 * to show the number moving. Gated hard on `enabled` so the sampling
 * stops the moment the overlay closes — this must never run in the
 * background.
 *
 * Deliberately not persisted (see the predicate in `state/client.ts`):
 * a restored snapshot would paint a previous run's dead pids, and
 * writing one SQLite row every 2s for data with zero cross-session value
 * is exactly what that filter exists to prevent.
 */
export function perfSnapshotQuery(opts: { enabled: boolean }) {
  return queryOptions({
    queryKey: qk.perf(),
    // Forward the signal so closing the overlay actually kills an
    // in-flight `ps`/`tmux` rather than leaving it to finish unobserved.
    queryFn: ({ signal }) => samplePerfPromise(signal),
    enabled: opts.enabled,
    refetchInterval: opts.enabled ? PERF_SAMPLE_MS : false,
    // Always stale: every observation wants a fresh sample.
    staleTime: 0,
    // Overrides the app-wide 24h default — the snapshot is worthless
    // once the overlay closes, so let it go rather than pinning a
    // process table in memory until gc.
    gcTime: 30_000,
  });
}
