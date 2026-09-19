/**
 * Pre-TUI reconciliation for the installed events daemon.
 *
 * This runs from the freshly loaded wt process on every interactive startup,
 * not only from the process that happened to apply an update. That distinction
 * repairs daemons when the updating process predates this hook, or when the
 * source clone moved before the TUI was launched.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";

import { sameBuild } from "../build-id.ts";
import { config } from "../config.ts";
import { causeMessage } from "../errors.ts";
import { withAsyncFileLock } from "../locks.ts";
import { run, type RunOptions, type RunResult } from "../proc.ts";
import { WT_REPO_ROOT } from "../update.ts";
import { eventsConfigEnvironment, EVENTS_AGENT_PATH, ownsEventsAgent, readEventsAgent } from "./agent.ts";
import { EVENTS_DIR, isProcessAlive, readState, type EventsState } from "./store.ts";

export type EventsDaemonReconcileResult =
  | { status: "disabled" }
  | { status: "not-installed" }
  | { status: "not-owned" }
  | { status: "current" }
  | { status: "restarted" }
  | { status: "failed"; detail: string };

export const reconcileEventsDaemonAtStartup = Effect.fn("reconcileEventsDaemonAtStartup")(function* (
  deps: {
    enabled?: boolean;
    plist?: string;
    agent?: () => Effect.Effect<unknown>;
    environment?: Record<string, string>;
    state?: () => EventsState | null;
    alive?: (pid: number) => boolean;
    same?: (writerSha: string | null | undefined) => boolean;
    run?: (argv: string[], opts: RunOptions) => Effect.Effect<RunResult>;
  } = {},
): Effect.fn.Return<EventsDaemonReconcileResult> {
  // The launchd agent is machine-wide; its presence does not enable events
  // for this repository or authorize restarting another repository's daemon.
  if (!(deps.enabled ?? Boolean(config.github.events))) return { status: "disabled" };

  const reconcile = Effect.gen(function* (): Effect.fn.Return<EventsDaemonReconcileResult, Error> {
    const plist = deps.plist ?? EVENTS_AGENT_PATH;
    if (!existsSync(plist)) return { status: "not-installed" };
    const environment = deps.environment ?? eventsConfigEnvironment();
    const agent = yield* (deps.agent ? deps.agent() : readEventsAgent(plist));
    if (!ownsEventsAgent(agent, environment, EVENTS_DIR)) return { status: "not-owned" };

    const state = (deps.state ?? readState)();
    const alive = deps.alive ?? isProcessAlive;
    const same = deps.same ?? sameBuild;
    if (state && alive(state.pid) && same(state.writerSha)) return { status: "current" };

    const result = yield* (deps.run ?? run)(
      [join(WT_REPO_ROOT, "bin", "wt"), "events", "restart"],
      { cwd: process.cwd(), env: environment, timeoutMs: 30_000 },
    );
    if (result.exitCode === 0) return { status: "restarted" };
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    return { status: "failed", detail };
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
