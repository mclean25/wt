/** Wire types for off-main-thread Codex session discovery. */
import type { HarnessSession } from "../types.ts";

export type CodexDiscoveryRequest = {
  type: "discover";
  id: number;
  slug: string;
  wtPath: string;
};

export type CodexDiscoveryResult =
  | { type: "result"; id: number; sessions: HarnessSession[] }
  | { type: "error"; id: number; message: string };
