import { useEffect, type DependencyList } from "react";
import { Effect, Fiber } from "effect";

/**
 * Own one fiber per mount: fork on mount / dependency change, interrupt
 * on cleanup. The effect must not fail — surface failures inside it
 * (log, toast) so nothing escapes as an unhandled defect. Return `null`
 * from `make` to run nothing for this render.
 */
export function useEffectFiber(
  make: () => Effect.Effect<unknown, never> | null,
  deps: DependencyList,
): void {
  useEffect(() => {
    const effect = make();
    if (!effect) return;
    const fiber = Effect.runFork(effect);
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, deps);
}
