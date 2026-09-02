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
 */
import { Clock, Data, Effect, Fiber } from "effect";

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

type Pending = {
  fiber: Fiber.RuntimeFiber<void, never> | null;
  token: object;
};

const pending = new Map<number, Pending>();

export type RetryCallbacks = {
  /** The arm finally took. */
  onArmed: () => void;
  /** A refusal that is not the registration gap; the loop stops. */
  onFailed: (error: string) => void;
  /** The budget ran out while still waiting on the same gap. */
  onGaveUp: () => void;
};

/** Is a retry already in flight for this PR? */
export function autoMergeRetryPending(prNumber: number): boolean {
  return pending.has(prNumber);
}

/**
 * Stop retrying. Returns whether anything was actually cancelled, so a
 * disarm can say "cancelled the pending arm" rather than the
 * meaningless "merge when ready not armed" — nothing is armed during
 * the wait, which is exactly why the disarm leg has to consult this
 * before it decides there is nothing to do.
 */
export function cancelAutoMergeRetry(prNumber: number): boolean {
  const entry = pending.get(prNumber);
  if (!entry) return false;
  pending.delete(prNumber);
  if (entry.fiber) Effect.runFork(Fiber.interrupt(entry.fiber));
  return true;
}

/** Stop every retry during TUI teardown. */
export function cancelAllAutoMergeRetries(): void {
  for (const prNumber of [...pending.keys()]) cancelAutoMergeRetry(prNumber);
}

class AutoMergeAttemptError extends Data.TaggedError("AutoMergeAttemptError")<{
  readonly cause: unknown;
}> {}

export function autoMergeRetryEffect(
  attempt: () => Promise<GhActionResult>,
  cb: RetryCallbacks,
  opts: { everyMs?: number; now?: () => number } = {},
): Effect.Effect<void> {
  const everyMs = opts.everyMs ?? RETRY_EVERY_MS;
  const currentTime = opts.now
    ? Effect.sync(opts.now)
    : Clock.currentTimeMillis;
  return Effect.gen(function* () {
    const startedAt = yield* currentTime;
    while (true) {
      yield* Effect.sleep(`${everyMs} millis`);
      const result = yield* Effect.tryPromise({
        try: attempt,
        catch: (cause) => new AutoMergeAttemptError({ cause }),
      }).pipe(Effect.either);
      if (result._tag === "Left") {
        cb.onFailed(
          result.left.cause instanceof Error
            ? result.left.cause.message
            : String(result.left.cause),
        );
        return;
      }
      if (result.right.ok) {
        cb.onArmed();
        return;
      }
      if (!result.right.retryable) {
        cb.onFailed(result.right.error);
        return;
      }
      if ((yield* currentTime) - startedAt >= RETRY_LIMIT_MS) {
        cb.onGaveUp();
        return;
      }
    }
  });
}

/**
 * Begin retrying `attempt` until it arms, refuses for a different
 * reason, or the budget expires. Re-arming over an existing retry
 * replaces it rather than stacking a second loop.
 */
export function startAutoMergeRetry(
  prNumber: number,
  attempt: () => Promise<GhActionResult>,
  cb: RetryCallbacks,
  /** Injectable so the tests can run the loop without spending a minute. */
  opts: { everyMs?: number; now?: () => number } = {},
): void {
  cancelAutoMergeRetry(prNumber);
  const token = {};
  const isCurrent = () => pending.get(prNumber)?.token === token;
  const guarded: RetryCallbacks = {
    onArmed: () => {
      if (isCurrent()) cb.onArmed();
    },
    onFailed: (error) => {
      if (isCurrent()) cb.onFailed(error);
    },
    onGaveUp: () => {
      if (isCurrent()) cb.onGaveUp();
    },
  };
  const program = autoMergeRetryEffect(attempt, guarded, opts).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (isCurrent()) pending.delete(prNumber);
      }),
    ),
  );
  const entry: Pending = { fiber: null, token };
  pending.set(prNumber, entry);
  entry.fiber = Effect.runFork(program);
}
