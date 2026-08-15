/**
 * Worker entry for the detailed Codex session tail. Each slot keeps its byte
 * cursor here so the main TUI thread never walks the rollout tree, reads the
 * JSONL, or parses a history seed during a periodic poll.
 */
import {
  createCodexTailPumpState,
  pumpCodexTail,
  type CodexTailPumpState,
} from "../tail.ts";
import type {
  CodexTailWorkerMessage,
  CodexTailWorkerResult,
} from "./tail-protocol.ts";

declare var self: Worker;

const states = new Map<string, CodexTailPumpState>();

function reply(message: CodexTailWorkerResult): void {
  postMessage(message);
}

self.onmessage = (event: MessageEvent<CodexTailWorkerMessage>) => {
  const message = event.data;
  if (message.type === "stop") {
    states.delete(message.key);
    return;
  }

  const liveKeys = new Set(message.slots.map((slot) => slot.key));
  for (const key of states.keys()) {
    if (!liveKeys.has(key)) states.delete(key);
  }

  const updates: CodexTailWorkerResult["updates"] = [];
  const errors: CodexTailWorkerResult["errors"] = [];
  for (const slot of message.slots) {
    let state = states.get(slot.key);
    if (!state || state.wtPath !== slot.wtPath) {
      state = createCodexTailPumpState(slot.wtPath);
      states.set(slot.key, state);
    }
    try {
      const lines = pumpCodexTail(state);
      state.seeded = true;
      if (lines.length > 0) updates.push({ key: slot.key, lines });
    } catch (err) {
      errors.push({
        key: slot.key,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  reply({ type: "result", id: message.id, updates, errors });
};
