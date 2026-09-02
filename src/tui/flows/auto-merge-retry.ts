/**
 * Background retry for "merge when ready" refused because a required
 * check has not REGISTERED yet.
 *
 * This exists because of a refusal that reads like a verdict and is
 * actually a clock. A merge queue refuses a PR whose required check has
 * not REPORTED for its head sha, in two wordings that are the same
 * situation at two ages: `is expected` (the workflow has not created
 * the check run yet — 62 seconds on the PR that exposed it, armed
 * 23:55:21Z, created 23:56:23Z) and `is in progress` (created, still
 * running — 51s to 5min on this repo's suite). Both clear on their own,
 * and the only thing standing between the keystroke and success was a
 * human noticing and pressing it again. Absorbing that is the whole
 * job.
 *
 * Two properties make the retry safe rather than merely convenient:
 *
 *  - It re-sends the SAME `expectedHeadOid` the keystroke captured, so
 *    a push during the wait makes GitHub refuse rather than arming a
 *    merge for a commit the user never saw. The safety is structural,
 *    not a check this module performs.
 *  - It only ever continues while the failure keeps saying `retryable`.
 *    Any other refusal ends it immediately and loudly, so a genuine
 *    problem cannot hide inside a retry loop.
 *
 * Keyed by PR number, because that is what both the keystroke and the
 * disarm leg have in hand and it is stable across row re-renders.
 *
 * One fiber per PR lives in `retries`, a `FiberMap` built against a
 * dedicated `Scope` this module owns — re-arming a PR replaces (and
 * interrupts) any prior fiber under that key for free, and
 * `closeAutoMergeRetries` (awaited once by `runtime.tsx` as a real
 * finalizer during TUI shutdown) closes the scope, which interrupts
 * every retry still waiting. A synchronous cancel/replace can still
 * race a fiber that is mid-attempt (an `attempt` Effect can complete
 * before its interrupt request is observed), so `tokens` separately
 * guards callback delivery: a callback only fires when its fiber is
 * still the current one for that PR, independent of how quickly the
 * interrupt lands.
 */
import { Clock, Effect, Exit, Fiber, FiberMap, Option, Scope } from "effect";

import type { GhActionResult } from "../../core/github/types.ts";

/**
 * Gap between attempts. Sized for the LONGER of the two waits: a
 * registration gap is ~1 minute, but a running suite is minutes, and
 * noticing 30 seconds late costs nothing against a 6-minute CI run.
 */
const RETRY_EVERY_MS = 30_000;

/**
 * How long to keep asking. Past this the check genuinely is not coming
 * — a workflow that never ran, a required context nothing produces —
 * and continuing would turn a wrong config into silent inaction. It has
 * to clear a whole CI run plus a queued runner, since `is in progress`
 * means the budget starts when the suite does: this repo's required
 * checks land in ~6 minutes, so 20 gives room for a slow queue without
 * waiting out a workflow that will never report.
 */
export const RETRY_LIMIT_MS = 20 * 60_000;

const retryScope: Scope.Closeable = Effect.runSync(Scope.make());
const retries: FiberMap.FiberMap<number, void, never> = Effect.runSync(
  FiberMap.make<number, void, never>().pipe(Effect.provideService(Scope.Scope, retryScope)),
);

/** Guards callback delivery against a fiber superseded (or cancelled) mid-attempt. */
const tokens = new Map<number, object>();

export type RetryCallbacks = {
  /**
   * The arm finally took. May return an Effect (e.g. a GitHub refresh)
   * to run as part of the retry fiber instead of being forked
   * fire-and-forget by the caller.
   */
  onArmed: () => void | Effect.Effect<void>;
  /** A refusal that is not the registration gap; the loop stops. */
  onFailed: (error: string) => void;
  /** The budget ran out while still waiting on the same gap. */
  onGaveUp: () => void;
};

/**
 * Is a retry already in flight for this PR? Authoritative on `tokens`,
 * not on `retries` (the FiberMap): a cancel/re-arm must invalidate this
 * answer the instant it's called, synchronously, and interruption
 * landing in the FiberMap is asynchronous — see `cancelAutoMergeRetry`.
 */
export function autoMergeRetryPending(prNumber: number): boolean {
  return tokens.has(prNumber);
}

/**
 * Stop retrying. Returns whether anything was actually cancelled, so a
 * disarm can say "cancelled the pending arm" rather than the
 * meaningless "merge when ready not armed" — nothing is armed during
 * the wait, which is exactly why the disarm leg has to consult this
 * before it decides there is nothing to do. Also what lets a SECOND
 * cancel of the same PR report "nothing to do" instead of "cancelled"
 * again: `tokens.delete` below is synchronous, so it can't observe its
 * own prior call as still-pending the way asking the FiberMap would
 * (a fiber is only forgotten there once its interruption actually
 * lands).
 *
 * The interrupt itself stays fire-and-forget (`Fiber.interrupt` via
 * `getUnsafe`, not `FiberMap.remove`): the attempt that calls this can
 * be the very fiber being cancelled (see `autoMergeRetry.test.ts`'s
 * in-flight-cancel case), and `FiberMap.remove` awaits the interruption
 * completing — which would deadlock a fiber interrupting itself
 * synchronously.
 */
export function cancelAutoMergeRetry(prNumber: number): boolean {
  if (!tokens.has(prNumber)) return false;
  tokens.delete(prNumber);
  const fiber = Option.getOrNull(FiberMap.getUnsafe(retries, prNumber));
  if (fiber) Effect.runFork(Fiber.interrupt(fiber));
  return true;
}

/**
 * Stop every retry during TUI teardown. Closes the scope backing
 * `retries`, which interrupts every fiber still in it — a real Effect
 * so `runtime.tsx` can `yield*`/`Effect.addFinalizer` it and know
 * every retry is actually gone before the rest of teardown proceeds.
 */
export const closeAutoMergeRetries: Effect.Effect<void> = Scope.close(
  retryScope,
  Exit.succeed(undefined),
).pipe(Effect.andThen(Effect.sync(() => tokens.clear())));

export const autoMergeRetry = Effect.fn("autoMergeRetry")(function* (
  attempt: Effect.Effect<GhActionResult>,
  cb: RetryCallbacks,
  opts: { everyMs?: number; now?: () => number } = {},
): Effect.fn.Return<void> {
  const everyMs = opts.everyMs ?? RETRY_EVERY_MS;
  const currentTime = opts.now
    ? Effect.sync(opts.now)
    : Clock.currentTimeMillis;
  const startedAt = yield* currentTime;
  while (true) {
    yield* Effect.sleep(`${everyMs} millis`);
    const result = yield* attempt;
    if (result.ok) {
      const armed = cb.onArmed();
      if (Effect.isEffect(armed)) yield* armed;
      return;
    }
    if (!result.retryable) {
      cb.onFailed(result.error);
      return;
    }
    if ((yield* currentTime) - startedAt >= RETRY_LIMIT_MS) {
      cb.onGaveUp();
      return;
    }
  }
});

/**
 * Begin retrying `attempt` until it arms, refuses for a different
 * reason, or the budget expires. Re-arming over an existing retry
 * replaces it rather than stacking a second loop (`FiberMap.run`'s own
 * semantics).
 */
export function startAutoMergeRetry(
  prNumber: number,
  attempt: Effect.Effect<GhActionResult>,
  cb: RetryCallbacks,
  opts: {
    everyMs?: number;
    now?: () => number;
    /**
     * Test seam: how the retry fiber is launched. Defaults to the live
     * runtime; tests substitute a `ManagedRuntime` built from
     * `TestClock.layer()` so the retry loop is driven by fake time
     * instead of blocking on real timers.
     */
    runFork?: (effect: Effect.Effect<void>) => void;
  } = {},
): void {
  const token = {};
  tokens.set(prNumber, token);
  const isCurrent = () => tokens.get(prNumber) === token;
  const guarded: RetryCallbacks = {
    onArmed: () => (isCurrent() ? cb.onArmed() : undefined),
    onFailed: (error) => {
      if (isCurrent()) cb.onFailed(error);
    },
    onGaveUp: () => {
      if (isCurrent()) cb.onGaveUp();
    },
  };
  const program = autoMergeRetry(attempt, guarded, opts).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (isCurrent()) tokens.delete(prNumber);
      }),
    ),
  );
  const run = opts.runFork ?? ((effect: Effect.Effect<void>) => void Effect.runFork(effect));
  run(FiberMap.run(retries, prNumber, program).pipe(Effect.asVoid));
}
