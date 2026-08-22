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

type Pending = { timer: ReturnType<typeof setTimeout>; startedAt: number };

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
  const p = pending.get(prNumber);
  if (!p) return false;
  clearTimeout(p.timer);
  pending.delete(prNumber);
  return true;
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
  const everyMs = opts.everyMs ?? RETRY_EVERY_MS;
  const now = opts.now ?? Date.now;
  cancelAutoMergeRetry(prNumber);
  const startedAt = now();
  const schedule = () => {
    const timer = setTimeout(() => {
      void attempt().then(
        (r) => {
          // Cancelled while the request was in flight: the user changed
          // their mind, and honouring that beats honouring the result.
          if (!pending.has(prNumber)) return;
          if (r.ok) {
            pending.delete(prNumber);
            cb.onArmed();
            return;
          }
          if (!r.retryable) {
            pending.delete(prNumber);
            cb.onFailed(r.error);
            return;
          }
          if (now() - startedAt >= RETRY_LIMIT_MS) {
            pending.delete(prNumber);
            cb.onGaveUp();
            return;
          }
          schedule();
        },
        (err) => {
          if (!pending.has(prNumber)) return;
          pending.delete(prNumber);
          cb.onFailed(err instanceof Error ? err.message : String(err));
        },
      );
    }, everyMs);
    // `unref` where the runtime has it: a pending retry must never be
    // the reason a CLI process refuses to exit.
    (timer as { unref?: () => void }).unref?.();
    pending.set(prNumber, { timer, startedAt });
  };
  schedule();
}
