/**
 * Pre-TUI reconciliation for the installed events daemon.
 *
 * This runs from the freshly loaded wt process on every interactive startup,
 * not only from the process that happened to apply an update. That distinction
 * repairs daemons when the updating process predates this hook, or when the
 * source clone moved before the TUI was launched.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { sameBuild } from "../build-id.ts";
import { causeMessage } from "../errors.ts";
import { withAsyncFileLock } from "../locks.ts";
import { runInResult, WT_REPO_ROOT, type RunResult } from "../update.ts";
import { isProcessAlive, readState, type EventsState } from "./store.ts";

export type EventsDaemonReconcileResult =
  | { status: "not-installed" }
  | { status: "current" }
  | { status: "restarted" }
  | { status: "failed"; detail: string };

export const reconcileEventsDaemonAtStartup = Effect.fn("reconcileEventsDaemonAtStartup")(function* (
  deps: {
    plist?: string;
    state?: () => EventsState | null;
    alive?: (pid: number) => boolean;
    same?: (writerSha: string | null | undefined) => boolean;
    run?: (argv: string[], opts: { cwd: string; timeoutMs?: number }) => Effect.Effect<RunResult>;
  } = {},
): Effect.fn.Return<EventsDaemonReconcileResult> {
  const reconcile: Effect.Effect<EventsDaemonReconcileResult> = Effect.suspend(() => {
    const plist = deps.plist ?? join(homedir(), "Library", "LaunchAgents", "com.wt.events.plist");
    if (!existsSync(plist)) return Effect.succeed({ status: "not-installed" });

    const state = (deps.state ?? readState)();
    const alive = deps.alive ?? isProcessAlive;
    const same = deps.same ?? sameBuild;
    if (state && alive(state.pid) && same(state.writerSha)) {
      return Effect.succeed({ status: "current" });
    }

    return (deps.run ?? runInResult)(
      [join(WT_REPO_ROOT, "bin", "wt"), "events", "restart"],
      { cwd: WT_REPO_ROOT, timeoutMs: 30_000 },
    ).pipe(Effect.map((result): EventsDaemonReconcileResult => {
      if (result.exitCode === 0) return { status: "restarted" };
      const detail = result.stderr.trim().split("\n").at(-1) || `exit ${result.exitCode}`;
      return { status: "failed", detail };
    }));
  });
  // Several already-open wt instances can re-exec around the same source
  // update. Serialize and re-read state under the lock so only the first one
  // rotates launchd; the rest observe its freshly stamped daemon.
  return yield* withAsyncFileLock("events-daemon-startup", reconcile, {
    timeoutMs: 35_000,
  }).pipe(
    Effect.catch((error) => Effect.succeed({
      status: "failed" as const,
      detail: causeMessage(error),
    })),
  );
});
