/**
 * Poll a worktree's supervised dev pane while its log viewer is mounted.
 * The viewer itself is the subscription boundary: closing it stops all
 * tmux work, while each refresh re-renders only that leaf rather than
 * the whole App tree.
 */
import { useEffect, useState } from "react";

import type { WorktreeTarget } from "../../core/worktree-target.ts";
import { readWorktreeDevLogs } from "../../core/worktree-executor.ts";

const POLL_MS = 1_000;

export function useDevServerLog(
  slug: string,
  target?: WorktreeTarget,
): string | null {
  const [output, setOutput] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setOutput(null);

    const poll = async () => {
      const next = target ? await readWorktreeDevLogs(target) : null;
      if (!active) return;
      setOutput((prev) => (prev === next ? prev : next));
      timer = setTimeout(poll, POLL_MS);
    };
    void poll();

    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [slug, target?.ref.kind, target?.ref.kind === "remote" ? target.ref.host : ""]);

  return output;
}
