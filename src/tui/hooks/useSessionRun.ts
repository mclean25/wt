/**
 * Observer hooks for the session-tail registries (claude jsonl + shell
 * pipe-pane + Codex). Each hook subscribes with a PER-KEY
 * selector snapshot: the registries replace only the touched entry on
 * an append (per-entry identity is their update discipline), so a
 * component tailing session A doesn't re-render when session B
 * streams — with several agents running at once, whole-map snapshots
 * multiplied every append into a re-render of every subscriber.
 */
import { useCallback, useSyncExternalStore } from "react";

import {
  type HarnessRun,
  type TailHarnessId,
  harnessTailKey,
  harnessTailRegistry,
} from "../../core/harness/tail.ts";
import {
  type SessionRun,
  sessionTailRegistry,
  tailKey,
} from "../../core/harness/claude/tail.ts";
import {
  type ShellRun,
  shellTailRegistry,
} from "../../core/shell-tail.ts";

/**
 * Live session tail for a (slug, name) pair. `name` defaults to null
 * (primary) so existing callers reading the primary's tail don't
 * change.
 */
export function useSessionRun(
  slug: string | undefined,
  name: string | null = null,
): SessionRun | null {
  const key = slug ? tailKey(slug, name) : null;
  const get = useCallback(
    () => (key ? sessionTailRegistry.getSnapshot().get(key) ?? null : null),
    [key],
  );
  return useSyncExternalStore(sessionTailRegistry.subscribe, get, get);
}

export function useShellRun(slug: string | undefined): ShellRun | null {
  const get = useCallback(
    () => (slug ? shellTailRegistry.getSnapshot().get(slug) ?? null : null),
    [slug],
  );
  return useSyncExternalStore(shellTailRegistry.subscribe, get, get);
}

/**
 * Live tail for a Codex slot (single slot per slug per
 * harness). Backed by `harnessTailRegistry`, which polls the rollout
 * jsonl / SQLite and produces the same `ActionLine[]` shape as claude.
 */
export function useHarnessRun(
  slug: string | undefined,
  harnessId: TailHarnessId,
): HarnessRun | null {
  const key = slug ? harnessTailKey(slug, harnessId) : null;
  const get = useCallback(
    () => (key ? harnessTailRegistry.getSnapshot().get(key) ?? null : null),
    [key],
  );
  return useSyncExternalStore(harnessTailRegistry.subscribe, get, get);
}
