/**
 * Worker entry for Codex session discovery. The rollout tree walk, metadata
 * reads, tail reads, and JSON parsing are intentionally synchronous here:
 * isolating them from the TUI thread is the performance boundary.
 */
import { discoverCodexSessionsSync } from "./harness.ts";
import type {
  CodexDiscoveryRequest,
  CodexDiscoveryResult,
} from "./discovery-protocol.ts";

declare var self: Worker;

function reply(message: CodexDiscoveryResult): void {
  postMessage(message);
}

self.onmessage = (event: MessageEvent<CodexDiscoveryRequest>) => {
  const { id, slug, wtPath } = event.data;
  try {
    reply({
      type: "result",
      id,
      sessions: discoverCodexSessionsSync(slug, wtPath),
    });
  } catch (err) {
    reply({
      type: "error",
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
