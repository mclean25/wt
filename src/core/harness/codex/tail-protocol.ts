/** Wire types for the detailed live-Codex tail worker. */
import type { ActionLine } from "../claude/events.ts";

export type CodexTailSlot = {
  key: string;
  slug: string;
  wtPath: string;
};

export type CodexTailWorkerMessage =
  | { type: "pump"; id: number; slots: CodexTailSlot[] }
  | { type: "stop"; key: string };

export type CodexTailWorkerResult = {
  type: "result";
  id: number;
  updates: Array<{ key: string; lines: ActionLine[] }>;
  errors: Array<{ key: string; message: string }>;
};
