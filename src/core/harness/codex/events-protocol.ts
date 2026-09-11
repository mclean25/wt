import type { EventKind } from "../../logger.ts";

/** One active codex tmux slot: the wt slug and its cwd. */
export type ActiveCodexSlug = {
  slug: string;
  wtPath: string;
  /** Exact live UUID, avoiding the bounded historical picker scan. */
  sessionId?: string | null;
};

export type CodexEventsWorkerMessage =
  | { type: "poll"; active: readonly ActiveCodexSlug[] }
  | { type: "stop" };

export type CodexEventsWorkerEvent = {
  level: EventKind;
  text: string;
};

export type CodexEventsWorkerResult =
  | {
      type: "events";
      events: CodexEventsWorkerEvent[];
      /** Slots whose rollout changed, including changes with no loggable event. */
      changedSlugs: string[];
    }
  | { type: "warn"; message: string };
