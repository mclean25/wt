import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { runQuery } from "./boundary.ts";

/**
 * Pin for the contract every `queryFn` in this module relies on: a
 * TanStack observer that aborts its query's `AbortSignal` (a
 * superseded key, an unmounted observer) must actually interrupt the
 * Effect fiber `runQuery` started, not just abandon the Promise and
 * let the fiber run to completion against the shared `run()`
 * concurrency budget. See the docstring on `runQuery`.
 */
describe("runQuery", () => {
  test("aborting the signal interrupts the underlying Effect", async () => {
    let interrupted = false;
    const controller = new AbortController();
    const effect = Effect.sleep(1000).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupted = true;
        }),
      ),
    );

    const promise = runQuery(effect, controller.signal);
    // Let the fiber actually start running before pulling the signal.
    await Effect.runPromise(Effect.sleep(0));
    controller.abort();

    await expect(promise).rejects.toThrow();
    expect(interrupted).toBe(true);
  });

  test("a signal that's never aborted lets the Effect complete normally", async () => {
    const result = await runQuery(Effect.succeed(42), new AbortController().signal);
    expect(result).toBe(42);
  });
});
