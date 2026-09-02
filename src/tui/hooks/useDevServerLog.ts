/**
 * Poll a worktree's supervised dev pane while its log viewer is mounted.
 * The viewer itself is the subscription boundary: closing it stops all
 * tmux work, while each refresh re-renders only that leaf rather than
 * the whole App tree.
 */
import { useState } from "react";
import { Effect } from "effect";

import type { WorktreeTarget } from "../../core/worktree-target.ts";
import { readWorktreeDevLogs } from "../../core/worktree-executor.ts";
import { useEffectFiber } from "./useEffectFiber.ts";

const POLL_MS = 1_000;


export function devServerLogPoll<E>(
  read: Effect.Effect<string | null, E>,
  onOutput: (output: string | null) => void,
  intervalMs = POLL_MS,
): Effect.Effect<never> {
  const poll = read.pipe(
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

  useEffectFiber(() => {
    setOutput(null);
    const read = target ? readWorktreeDevLogs(target) : Effect.succeed(null);
    return devServerLogPoll(read, (next) =>
      setOutput((previous) => (previous === next ? previous : next)),
    );
  }, [slug, target?.ref.kind, target?.ref.kind === "remote" ? target.ref.host : ""]);

  return output;
}
