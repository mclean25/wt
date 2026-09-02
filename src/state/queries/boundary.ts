/**
 * The TanStack boundary. A `queryFn`/`mutationFn` must return a Promise,
 * so every source builds an Effect and hands it to `runQuery` with the
 * context's `signal`: cancellation (a superseded key, an unmounted
 * observer) then interrupts the fiber and reaches any subprocess it
 * spawned, instead of letting the stale fetch run to completion against
 * the shared `run()` concurrency budget.
 */
import { Effect } from "effect";

export { operationErrors, OperationError } from "../../core/errors.ts";

/** Run a query effect at the TanStack boundary, wired to its AbortSignal. */
export function runQuery<A, E>(
  effect: Effect.Effect<A, E>,
  signal: AbortSignal | undefined,
): Promise<A> {
  return Effect.runPromise(effect, signal ? { signal } : undefined);
}
