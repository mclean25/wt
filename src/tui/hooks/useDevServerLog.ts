/**
 * Poll a worktree's supervised dev pane while its log viewer is mounted.
 * The viewer itself is the subscription boundary: closing it stops all
 * tmux work, while each refresh re-renders only that leaf rather than
 * the whole App tree.
 */
import { useEffect, useState } from "react";
import { Data, Effect, Fiber } from "effect";

import type { WorktreeTarget } from "../../core/worktree-target.ts";
import { readWorktreeDevLogsPromise } from "../../core/worktree-executor.ts";

const POLL_MS = 1_000;

class DevLogReadError extends Data.TaggedError("DevLogReadError")<{
  readonly cause: unknown;
}> {}

export function devServerLogPoll(
  read: () => Promise<string | null>,
  onOutput: (output: string | null) => void,
  intervalMs = POLL_MS,
): Effect.Effect<never> {
  const poll = Effect.tryPromise({
    try: read,
    catch: (cause) => new DevLogReadError({ cause }),
  }).pipe(
    Effect.tap((next) => Effect.sync(() => onOutput(next))),
    Effect.catch(() => Effect.void),
  );
  return Effect.forever(
    poll.pipe(Effect.andThen(Effect.sleep(`${intervalMs} millis`))),
  );
}

export function useDevServerLog(
  slug: string,
  target?: WorktreeTarget,
): string | null {
  const [output, setOutput] = useState<string | null>(null);

  useEffect(() => {
    setOutput(null);
    const read = () =>
      target ? readWorktreeDevLogsPromise(target) : Promise.resolve(null);
    const fiber = Effect.runFork(
      devServerLogPoll(read, (next) =>
        setOutput((previous) => (previous === next ? previous : next)),
      ),
    );

    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [slug, target?.ref.kind, target?.ref.kind === "remote" ? target.ref.host : ""]);

  return output;
}
