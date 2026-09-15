import { Clock, Effect } from "effect";
import { listSessionsWithHarnessIds } from "../tmux/process.ts";
import { findCodexRolloutForSession } from "./codex/harness.ts";
import { operationErrors, type OperationError } from "../errors.ts";
import type { SessionMessagingError } from "./session-messaging.ts";
import { injectCodexFallback } from "../tmux/inject.ts";
import { probeCodexTerminalReadiness, waitForCodexTerminalReady } from "./codex/readiness.ts";
import {
  resolveAgentRoute,
  sendAgentMessageToRoute,
  type AgentRoute,
  type RoutedAgentMessageResult,
} from "./agent-routing.ts";

/** Codex Compact has no inline args. Preparation precedes native compaction. */
export function compactMessages(harnessId: string | null, prompt: string): readonly string[] {
  if (harnessId !== "codex" || !/^\/compact\s+\S/.test(prompt)) return [prompt];
  const focus = prompt.replace(/^\/compact\s+/, "").replaceAll("/manager", "$manager");
  return [
    `Prepare for the next native compaction. Do not compact yourself; wt will submit the command separately. ${focus} Acknowledge these instructions without taking other actions.`,
    "/compact",
  ];
}

export type CompactResult = RoutedAgentMessageResult & {
  /** Preparation receipt is distinct from native command execution. */
  preparation?: RoutedAgentMessageResult;
};

export function compactPreparationReceived(jsonl: string, text: string, sinceMs: number): boolean {
  return jsonl.split("\n").some((line) => {
    try {
      const entry = JSON.parse(line);
      if (!(Date.parse(entry.timestamp) >= sinceMs)) return false;
      const item = entry.payload;
      if (entry.type !== "response_item" || item?.type !== "message" || item.role !== "user") return false;
      const body = item.content?.map((part: { text?: string }) => part.text ?? "").join("");
      return typeof body === "string" && body.includes(text);
    } catch { return false; }
  });
}

// A queue acknowledgement is not receipt. Pin the live UUID, use the existing
// slot-aware rollout resolver, and refuse to compact if that slot changes.
const waitForPreparation = Effect.fn("waitForCompactPreparation")(function* (
  route: AgentRoute, text: string, sinceMs: number,
) {
  const deadline = (yield* Clock.currentTimeMillis) + 60_000;
  let sessionId: string | undefined;
  while ((yield* Clock.currentTimeMillis) < deadline) {
    const inventory = yield* listSessionsWithHarnessIds();
    if (!inventory.known) return null;
    const liveId = inventory.harnessSessionIds.get(`${route.target.slug}-codex`);
    if (sessionId && liveId !== sessionId) return null;
    sessionId ??= liveId;
    if (sessionId) {
      const rollout = yield* Effect.try({
        try: () => findCodexRolloutForSession(route.target.cwd, route.target.slug, sessionId!),
        catch: operationErrors("compact").wrap("find preparation rollout"),
      });
      if (rollout) {
        const tail = yield* Effect.tryPromise({
          try: () => Bun.file(rollout.path).slice(Math.max(0, rollout.size - 2 * 1024 * 1024)).text(),
          catch: operationErrors("compact").wrap("read preparation receipt"),
        });
        if (compactPreparationReceived(tail, text, sinceMs)) return sessionId;
      }
    }
    yield* Effect.sleep("250 millis");
  }
  return null;
});

export const submitPreparedCompact = Effect.fn("submitPreparedCompact")(function* (
  route: AgentRoute,
  sessionId: string,
  inspect: typeof listSessionsWithHarnessIds = listSessionsWithHarnessIds,
  inject: typeof injectCodexFallback = injectCodexFallback,
) {
  const target = { ...route.target, sessionId, text: "/compact" };
  const gate = Effect.gen(function* () {
    const inventory = yield* inspect();
    if (!inventory.known || inventory.harnessSessionIds.get(`${target.slug}-codex`) !== sessionId) {
      return { ready: false as const, reason: "prepared Codex thread no longer owns the slot" };
    }
    return yield* probeCodexTerminalReadiness(target);
  });
  // injectCodexFallback evaluates gate under the injection lock immediately
  // before pasting, rejecting a changed owner at that last safety check.
  const result = yield* inject(target, waitForCodexTerminalReady(target), gate);
  return result.ok ? {
    ...result, delivered: null, route, transport: "terminal" as const,
    fallback: { kind: "command" as const, harnessId: "codex" as const },
  } : { ...result, route };
});

export const sendCompactToRoute = Effect.fn("sendCompactToRoute")(function* (
  route: AgentRoute,
  prompt: string,
  send: typeof sendAgentMessageToRoute = sendAgentMessageToRoute,
  receipt: (route: AgentRoute, text: string, sinceMs: number) => Effect.Effect<string | null, OperationError> = waitForPreparation,
  submit: (route: AgentRoute, sessionId: string) => Effect.Effect<RoutedAgentMessageResult> = submitPreparedCompact,
): Effect.fn.Return<CompactResult, SessionMessagingError> {
  const [first, command] = compactMessages(route.choice.harnessId, prompt);
  const sinceMs = yield* Clock.currentTimeMillis;
  const preparation = yield* send(route, first!);
  if (!command || !preparation.ok || preparation.delivered === false) return preparation;
  const received = yield* receipt(route, first!, sinceMs).pipe(Effect.catch(() => Effect.succeed(null)));
  if (!received) return {
    ok: false, route, preparation,
    reason: "compaction NOT submitted: preparation receipt unconfirmed (it may remain queued); do not retry blindly",
  };
  // The ordinary command path waits until this same slot is idle, preserving
  // questions/approvals. Never append instructions to Codex's /compact.
  const result = yield* submit(route, received);
  return { ...result, preparation };
});

export const sendAgentCompact = Effect.fn("sendAgentCompact")(function* (
  requested: string,
  prompt: string,
) {
  const route = yield* resolveAgentRoute(requested);
  if (!route) return { ok: false as const, reason: `unknown agent target: ${requested}`, route: null };
  return yield* sendCompactToRoute(route, prompt);
});
