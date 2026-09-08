import { Clock, Data, Duration, Effect } from "effect";

import {
  findCodexRolloutForSession,
  readCodexTail,
  type CodexRolloutFile,
} from "./harness.ts";

export type CodexTerminalReadiness =
  | { readonly ready: true; readonly rollout: CodexRolloutFile }
  | {
      readonly ready: false;
      readonly reason: "rollout-not-found" | "unknown" | "working" | "question" | "approval";
      readonly rollout: CodexRolloutFile | null;
    };

export type CodexTerminalReadinessOptions = {
  readonly cwd: string;
  readonly slug: string;
  readonly sessionId: string;
  readonly sessionsDir?: string;
};

export type WaitForCodexTerminalReadyOptions = CodexTerminalReadinessOptions & {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
};

export class CodexTerminalReadinessTimeout extends Data.TaggedError(
  "CodexTerminalReadinessTimeout",
)<{
  readonly message: string;
  readonly sessionId: string;
  readonly lastProbe: CodexTerminalReadiness;
}> {}

/**
 * One fail-closed readiness check for the exact mapped Codex thread.
 * Call this again while holding the injection lock immediately before paste.
 */
export const probeCodexTerminalReadiness = Effect.fn("probeCodexTerminalReadiness")(
  function* (opts: CodexTerminalReadinessOptions) {
    return yield* Effect.sync((): CodexTerminalReadiness => {
      const rollout = findCodexRolloutForSession(
        opts.cwd,
        opts.slug,
        opts.sessionId,
        opts.sessionsDir,
      );
      if (!rollout) return { ready: false, reason: "rollout-not-found", rollout: null };
      const tail = readCodexTail(rollout.path, rollout.mtimeMs, rollout.size);
      if (!tail || !tail.tailParseComplete || tail.lastTaskEventKind === null) {
        return { ready: false, reason: "unknown", rollout };
      }
      if (tail.lastTaskEventKind === "task_started") {
        return {
          ready: false,
          reason: tail.pendingInteraction ?? "working",
          rollout,
        };
      }
      return { ready: true, rollout };
    });
  },
);

/** Interruptible polling for a cleanly closed turn in the exact thread. */
export const waitForCodexTerminalReady = Effect.fn("waitForCodexTerminalReady")(
  function* (opts: WaitForCodexTerminalReadyOptions) {
    const timeoutMs = Math.max(0, opts.timeoutMs ?? 30_000);
    const pollIntervalMs = Math.max(1, opts.pollIntervalMs ?? 200);
    const startedAt = yield* Clock.currentTimeMillis;
    const deadline = startedAt + timeoutMs;
    let lastProbe = yield* probeCodexTerminalReadiness(opts);
    while (!lastProbe.ready) {
      const remainingMs = deadline - (yield* Clock.currentTimeMillis);
      if (remainingMs <= 0) {
        return yield* new CodexTerminalReadinessTimeout({
          message: `Codex thread ${opts.sessionId} did not become safe for terminal input within ${timeoutMs}ms (${lastProbe.reason})`,
          sessionId: opts.sessionId,
          lastProbe,
        });
      }
      yield* Effect.sleep(Duration.millis(Math.min(pollIntervalMs, remainingMs)));
      lastProbe = yield* probeCodexTerminalReadiness(opts);
    }
    return lastProbe;
  },
);
