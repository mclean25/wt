import { Effect } from "effect";
import {
  resolveAgentRoute,
  sendAgentMessageToRoute,
  type AgentRoute,
} from "./agent-routing.ts";

/** Codex accepts only bare /compact; inline text becomes an ordinary turn. */
export function compactCommand(harnessId: string | null, prompt: string): string {
  return harnessId === "codex" && /^\/compact(?:\s|$)/.test(prompt.trimStart())
    ? "/compact"
    : prompt;
}

/** One command through the normal routed, locked terminal delivery path. */
export const sendCompactToRoute = Effect.fn("sendCompactToRoute")(function* (
  route: AgentRoute,
  prompt: string,
  send: typeof sendAgentMessageToRoute = sendAgentMessageToRoute,
) {
  return yield* send(route, compactCommand(route.choice.harnessId, prompt));
});

export const sendAgentCompact = Effect.fn("sendAgentCompact")(function* (
  requested: string,
  prompt: string,
) {
  const route = yield* resolveAgentRoute(requested);
  if (!route) return { ok: false as const, reason: `unknown agent target: ${requested}`, route: null };
  return yield* sendCompactToRoute(route, prompt);
});
