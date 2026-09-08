import { Clock, Data, Duration, Effect } from "effect";

import { capturePane } from "../../tmux/process.ts";
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

export type CodexLivePaneReadiness =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: "pane-unavailable" | "not-idle" };

export type CodexLivePaneReadinessOptions = {
  readonly slug: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
};

export class CodexLivePaneReadinessTimeout extends Data.TaggedError(
  "CodexLivePaneReadinessTimeout",
)<{
  readonly message: string;
  readonly lastProbe: CodexLivePaneReadiness;
}> {}

/**
 * A UUID-less live slot has no transcript identity to inspect. Only the empty
 * ordinary composer is safe for terminal input: question/approval UIs replace
 * this placeholder, and a user draft replaces it too.
 */
export function codexPaneIsIdle(text: string): boolean {
  if (/esc to interrupt/i.test(text)) return false;
  const composers = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("› "));
  return composers.at(-1) === "› Ask Codex to do anything";
}

export const probeCodexLivePaneReadiness = Effect.fn("probeCodexLivePaneReadiness")(
  function* (opts: Pick<CodexLivePaneReadinessOptions, "slug">) {
    const pane = yield* capturePane(`${opts.slug}-codex`);
    if (pane === null) {
      return { ready: false, reason: "pane-unavailable" } as const;
    }
    return codexPaneIsIdle(pane)
      ? { ready: true } as const
      : { ready: false, reason: "not-idle" } as const;
  },
);

/** Wait for a live UUID-less slot to expose its empty ordinary composer. */
export const waitForCodexLivePaneReady = Effect.fn("waitForCodexLivePaneReady")(
  function* (opts: CodexLivePaneReadinessOptions) {
    const timeoutMs = Math.max(0, opts.timeoutMs ?? 30_000);
    const pollIntervalMs = Math.max(1, opts.pollIntervalMs ?? 200);
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    let lastProbe = yield* probeCodexLivePaneReadiness(opts);
    while (!lastProbe.ready) {
      const remainingMs = deadline - (yield* Clock.currentTimeMillis);
      if (remainingMs <= 0) {
        return yield* new CodexLivePaneReadinessTimeout({
          message: `Codex slot ${opts.slug} did not become safe for terminal input within ${timeoutMs}ms (${lastProbe.reason})`,
          lastProbe,
        });
      }
      yield* Effect.sleep(Duration.millis(Math.min(pollIntervalMs, remainingMs)));
      lastProbe = yield* probeCodexLivePaneReadiness(opts);
    }
    return lastProbe;
  },
);

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
