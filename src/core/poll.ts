/**
 * Wait for a condition, bounded.
 *
 * Extracted because the two delivery-confirmation paths — terminal
 * input (`tmux/inject.ts`) and prompt injection
 * (`harness/session-messaging.ts`) — had written the identical
 * poll-until-true-or-deadline loop twice, each with its own copy of the
 * same 8s/250ms constants. They confirm the same thing against the same
 * transcript, so a fix or a retune to one silently applied to only half
 * the fleet's messages.
 *
 * What a `false` return MEANS is deliberately left to the caller: for
 * one it's "the pane swallowed it", for the other it depends on whether
 * the target was idle. That judgement is the part that legitimately
 * differs; the loop is not.
 */
import { Clock, Data, Duration, Effect } from "effect";

export type PollUntilOptions = {
  /** Cheap, synchronous, side-effect-free. Called immediately, then per tick. */
  check(): boolean;
  budgetMs: number;
  intervalMs: number;
};

export class PollCheckError extends Data.TaggedError("PollCheckError")<{
  readonly cause: unknown;
}> {}

/** Effect-native polling loop. Clock is injectable, so tests never use real timers. */
export function pollUntil(opts: PollUntilOptions): Effect.Effect<boolean, PollCheckError> {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const deadline = startedAt + opts.budgetMs;
    for (;;) {
      const satisfied = yield* Effect.try({
        try: opts.check,
        catch: (cause) => new PollCheckError({ cause }),
      });
      if (satisfied) return true;
      if ((yield* Clock.currentTimeMillis) >= deadline) return false;
      yield* Effect.sleep(Duration.millis(opts.intervalMs));
    }
  });
}

export async function pollUntilPromise(opts: {
  /** Cheap, synchronous, side-effect-free. Called immediately, then per tick. */
  check(): boolean;
  budgetMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}): Promise<boolean> {
  if (!opts.now && !opts.sleep) {
    return Effect.runPromise(
      pollUntil(opts),
      opts.signal ? { signal: opts.signal } : undefined,
    );
  }
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => Effect.runPromise(Effect.sleep(ms)));
  const deadline = now() + opts.budgetMs;
  for (;;) {
    opts.signal?.throwIfAborted();
    if (opts.check()) return true;
    if (now() >= deadline) return false;
    await sleep(opts.intervalMs);
  }
}
