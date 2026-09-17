import { Effect, Result } from "effect";

import { primarySingleSlotSession } from "../session-selection.ts";
import { listSessionsWithHarnessIds, runTmux } from "../../tmux/process.ts";
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
import { recoverCodexLiveIdentity } from "./live-identity.ts";
import {
  probeCodexLivePaneReadiness,
  probeCodexTerminalReadiness,
  waitForCodexLivePaneReady,
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

/** Codex slash commands are TUI actions, not app-server user messages. */
export function isCodexSlashCommand(text: string): boolean {
  return /^\/[a-z][a-z0-9_-]*(\s|$)/.test(text.trimStart());
}

type Dependencies = {
  readonly discover: typeof discoverCodexSessions;
  readonly liveInventory: typeof listSessionsWithHarnessIds;
  readonly stampSession: (tmuxName: string, sessionId: string) => Effect.Effect<boolean>;
  readonly recoverLiveIdentity: typeof recoverCodexLiveIdentity;
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
  readonly liveTerminal: (target: CodexMessageTarget) => Effect.Effect<InjectResult>;
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
  recoverLiveIdentity: recoverCodexLiveIdentity,
  liveInventory: listSessionsWithHarnessIds,
  stampSession: (tmuxName, sessionId) => runTmux([
    "set-option",
    "-t",
    `=${tmuxName}`,
    "@wt-harness-session-id",
    sessionId,
  ]).pipe(Effect.map((result) => result.code === 0)),
  start: startHarnessSessionDetached,
  nativeQueue: queueCodexMessage,
  cliQueue,
  terminal: (target) => injectCodexFallback(
    target,
    waitForCodexTerminalReady(target),
    probeCodexTerminalReadiness(target),
  ),
  liveTerminal: (target) => injectCodexFallback(
    target,
    waitForCodexLivePaneReady(target),
    probeCodexLivePaneReadiness(target),
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
    const command = isCodexSlashCommand(target.text);
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
    // A live tmux stamp identifies which conversation currently
    // owns that pane, including a deliberately selected secondary. A stable
    // "primary" name map is useful for a cold start, but cannot establish
    // ownership of an already-live unstamped slot. Recover from the pane's
    // native writer lock before resorting to guarded terminal input.
    let sessionId = liveBefore
      ? stampedLiveId
      : primarySingleSlotSession(sessions)?.sessionId ?? null;
    if (liveBefore && sessionId === null) {
      sessionId = yield* deps.recoverLiveIdentity(tmuxName, sessions);
      if (sessionId !== null) {
        // Best-effort self-heal. Ownership was established by the live
        // process's writer lock, so this send may use the exact UUID even if tmux
        // refuses the metadata write; the next send will re-prove it.
        yield* deps.stampSession(tmuxName, sessionId);
      }
    }
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

    if (command) {
      // The app-server queue deliberately treats its payload as user text;
      // slash-command expansion belongs to the interactive TUI. Keep the
      // same exact-thread readiness gate as the legacy terminal fallback,
      // and use the UUID-less live-pane gate for a freshly bootstrapped slot.
      const terminal = sessionId === null
        ? yield* deps.liveTerminal(target)
        : yield* deps.terminal({ ...target, sessionId });
      return terminal.ok
        ? {
            ok: true,
            transport: "terminal",
            coldStarted: terminal.coldStarted || coldStarted,
            delivered: null,
            resent: false,
            fallbackReason: "Codex slash commands execute through the interactive terminal",
          }
        : terminal;
    }

    if (sessionId === null) {
      if (liveBefore) {
        // The live tmux session is still an exact delivery target even when
        // Codex changed its rollout metadata and wt cannot recover the UUID.
        // Keep native delivery preferred, but retain terminal input as the
        // compatibility floor instead of dropping the message entirely.
        const result = yield* deps.liveTerminal(target);
        return result.ok
          ? {
              ok: true,
              transport: "terminal",
              coldStarted: result.coldStarted,
              delivered: result.delivered,
              resent: false,
              fallbackReason: "the live Codex slot has no recoverable thread UUID",
            }
          : { ok: false, reason: `No message queued: the live Codex slot has no provable thread UUID; terminal fallback failed: ${result.reason}` };
      }
      if (!coldStarted) {
        return {
          ok: false,
          reason: "Codex did not start and wt could not resolve a thread UUID",
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
