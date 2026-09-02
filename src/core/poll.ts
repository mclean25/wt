/**
 * Wait for a condition, bounded.
 *
 * Extracted from the terminal-input delivery-confirmation path
 * (`tmux/inject.ts`), which used to carry its own private copy of the
 * poll-until-true-or-deadline loop. Kept as its own module rather than
 * folded back in so a fix or a retune doesn't require re-deriving the
 * loop from scratch, and so any other bounded-condition wait (prompt
 * injection currently confirms delivery a different way) can reuse it
 * without writing the loop a third time.
 *
 * What a `false` return MEANS is deliberately left to the caller — here
 * it's "the pane swallowed it" — since that judgement is the part that
 * legitimately differs per caller; the loop is not.
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
export const pollUntil = Effect.fn("pollUntil")(function* (opts: PollUntilOptions) {
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
