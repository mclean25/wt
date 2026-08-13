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
export async function pollUntil(opts: {
  /** Cheap, synchronous, side-effect-free. Called immediately, then per tick. */
  check(): boolean;
  budgetMs: number;
  intervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((d) => setTimeout(d, ms)));
  const deadline = now() + opts.budgetMs;
  for (;;) {
    if (opts.check()) return true;
    if (now() >= deadline) return false;
    await sleep(opts.intervalMs);
  }
}
