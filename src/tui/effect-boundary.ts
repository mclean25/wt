/**
 * The keystroke boundary. OpenTUI key handlers and flow callbacks are
 * plain functions, so an effect started there is forked once and its
 * failure is REPORTED (toast + pane line via the caller's reporter),
 * never thrown into React and never dropped as an unhandled rejection.
 *
 * Fire-and-forget on purpose: the action should finish even if the
 * modal that started it closes. Anything that must be cancelled with a
 * component's lifetime goes through `useEffectFiber` instead.
 */
import { Effect } from "effect";

export function forkReported<A, E>(
  effect: Effect.Effect<A, E>,
  report: (error: E) => void,
): void {
  Effect.runFork(effect.pipe(Effect.catch((error) => Effect.sync(() => report(error)))));
}
