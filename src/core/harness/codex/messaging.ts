import { Effect, Result } from "effect";

import { primarySingleSlotSession } from "../session-selection.ts";
import { listSessionsWithHarnessIds } from "../../tmux/process.ts";
import { startHarnessSessionDetached } from "../../tmux/lifecycle.ts";
import {
  injectCodexFallback,
  injectIntoSession,
  type InjectResult,
} from "../../tmux/inject.ts";
import { run } from "../../proc.ts";
import { queueCodexMessage, type CodexAppServerError } from "./app-server.ts";
import { discoverCodexSessions } from "./discovery.ts";
import { codexHarness } from "./harness.ts";
import {
  probeCodexTerminalReadiness,
  waitForCodexTerminalReady,
} from "./readiness.ts";

export type CodexMessageResult =
  | {
      readonly ok: true;
      readonly transport: "codex-app-server" | "codex-queue";
      readonly coldStarted: boolean;
      readonly delivered: boolean | null;
      readonly resent: false;
      readonly queueState?: "started" | "queued" | "queued-or-started";
    }
  | {
      readonly ok: true;
      readonly transport: "terminal";
      readonly coldStarted: boolean;
      readonly delivered: boolean | null;
      readonly resent: false;
      readonly fallbackReason?: string;
    }
  | { readonly ok: false; readonly reason: string };

export type CodexMessageTarget = {
  readonly slug: string;
  readonly cwd: string;
  readonly managedName?: string | null;
  readonly text: string;
};

type Dependencies = {
  readonly discover: typeof discoverCodexSessions;
  readonly liveInventory: typeof listSessionsWithHarnessIds;
  readonly start: typeof startHarnessSessionDetached;
  readonly nativeQueue: typeof queueCodexMessage;
  readonly cliQueue: (threadId: string, text: string) => Effect.Effect<{
    readonly ok: boolean;
    readonly reason?: string;
    readonly unsupported?: boolean;
  }>;
  readonly terminal: (
    target: CodexMessageTarget & { readonly sessionId: string },
  ) => Effect.Effect<InjectResult>;
  readonly bootstrapTerminal: (target: CodexMessageTarget) => Effect.Effect<InjectResult>;
};

const cliQueue = Effect.fnUntraced(function* (threadId: string, text: string) {
  const outcome = yield* Effect.result(run(
    ["codex", "queue", "--thread", threadId, "--message", text],
    { timeoutMs: 15_000 },
  ));
  if (Result.isFailure(outcome)) {
    const reason = outcome.failure.message;
    return {
      ok: false,
      reason,
      unsupported: /unrecognized subcommand|unknown command|unexpected argument ['\"]queue/i.test(reason),
    };
  }
  const result = outcome.success;
  if (result.exitCode !== 0) {
    const reason = result.stderr.trim() || result.stdout.trim() || `codex queue exited ${result.exitCode}`;
    return {
      ok: false,
      reason,
      unsupported: /unrecognized subcommand|unknown command|unexpected argument ['\"]queue/i.test(reason),
    };
  }
  if (!/Queued message\s+\S+\s+for thread\s+/i.test(result.stdout)) {
    return { ok: false, reason: "codex queue exited successfully without a queue receipt" };
  }
  return { ok: true };
});

const defaults: Dependencies = {
  discover: discoverCodexSessions,
  liveInventory: listSessionsWithHarnessIds,
  start: startHarnessSessionDetached,
  nativeQueue: queueCodexMessage,
  cliQueue,
  terminal: (target) => injectCodexFallback(
    target,
    waitForCodexTerminalReady(target),
    probeCodexTerminalReadiness(target),
  ),
  // The first prompt is what causes a brand-new Codex conversation to gain
  // a UUID/rollout. There is no exact thread to queue to before that write.
  bootstrapTerminal: (target) => injectIntoSession({ ...target, harnessId: "codex" }),
};

function errorText(error: CodexAppServerError): string {
  if (error.kind === "ambiguous") {
    return `${error.message}; delivery is ambiguous, so wt did not retry it`;
  }
  return error.message;
}

export function createCodexMessenger(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    ...defaults,
    ...overrides,
  };

  return Effect.fn("sendCodexMessage")(function* (
    target: CodexMessageTarget,
  ): Effect.fn.Return<CodexMessageResult> {
    const tmuxName = codexHarness.tmuxSessionName(target.slug, null);
    const liveInventory = yield* deps.liveInventory();
    if (!liveInventory.known) {
      return {
        ok: false,
        reason: "could not determine whether the Codex tmux slot is live; no session was started and no message was sent",
      };
    }
    const liveBefore = liveInventory.all.has(tmuxName);
    const stampedLiveId = liveInventory.harnessSessionIds.get(tmuxName) ?? null;
    const discovered = yield* Effect.result(deps.discover(target.slug, target.cwd));
    if (Result.isFailure(discovered)) {
      return {
        ok: false,
        reason: `could not resolve the exact Codex thread: ${String(discovered.failure.cause)}`,
      };
    }
    let sessions = discovered.success;
    // A live tmux stamp is the exact conversation currently acting as this
    // worktree's agent, including a deliberately selected secondary. Old
    // unstamped slots and cold starts use wt's stable primary mapping. Never
    // infer either identity from rollout recency.
    let sessionId = liveBefore && stampedLiveId !== null
      ? stampedLiveId
      : primarySingleSlotSession(sessions)?.sessionId ?? null;
    let coldStarted = false;

    if (!liveBefore) {
      const started = yield* deps.start(target.slug, target.cwd, "codex", null);
      if (!started.ok) return { ok: false, reason: started.reason };
      coldStarted = !started.adopted;
      // A main/manager opening prompt can create the UUID during startup.
      if (sessionId === null) {
        const afterStart = yield* Effect.result(deps.discover(target.slug, target.cwd));
        if (Result.isFailure(afterStart)) {
          return {
            ok: false,
            reason: `Codex started, but wt could not resolve its exact thread: ${String(afterStart.failure.cause)}`,
          };
        }
        sessions = afterStart.success;
        sessionId = primarySingleSlotSession(sessions)?.sessionId ?? null;
      }
    }

    if (sessionId === null) {
      if (liveBefore || !coldStarted) {
        return {
          ok: false,
          reason: "Codex is live, but wt cannot prove which thread owns the slot; no message was typed",
        };
      }
      // No UUID exists yet. Only this bootstrap uses terminal input; every
      // later send has a durable native identity and takes the queue path.
      const result = yield* deps.bootstrapTerminal(target);
      return result.ok
        ? {
            ok: true,
            transport: "terminal",
            coldStarted: result.coldStarted || coldStarted,
            delivered: result.delivered,
            resent: false,
            fallbackReason: "new Codex thread has no UUID until its first prompt",
          }
        : result;
    }

    const native = yield* Effect.result(deps.nativeQueue({
      threadId: sessionId,
      text: target.text,
    }));
    if (Result.isSuccess(native)) {
      return {
        ok: true,
        transport: "codex-app-server",
        coldStarted,
        delivered: true,
        resent: false,
        queueState: native.success.state,
      };
    }

    const nativeError = native.failure;

    if (nativeError.kind === "absent" || nativeError.kind === "unavailable") {
      const queued = yield* deps.cliQueue(sessionId, target.text);
      if (queued.ok) {
        return {
          ok: true,
          transport: "codex-queue",
          coldStarted,
          delivered: true,
          resent: false,
          queueState: "queued-or-started",
        };
      }
      if (!queued.unsupported) {
        return {
          ok: false,
          reason: `${queued.reason ?? "codex queue failed"}; delivery may be ambiguous, so wt did not type the message`,
        };
      }
    } else if (nativeError.kind !== "unsupported") {
      return { ok: false, reason: errorText(nativeError) };
    }

    const terminal = yield* deps.terminal({ ...target, sessionId });
    return terminal.ok
      ? {
          ok: true,
          transport: "terminal",
          coldStarted: terminal.coldStarted || coldStarted,
          delivered: terminal.delivered,
          resent: false,
          fallbackReason: "this Codex version does not expose the durable queue API",
        }
      : terminal;
  });
}

export const sendCodexMessage = createCodexMessenger();
