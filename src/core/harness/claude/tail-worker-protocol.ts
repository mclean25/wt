/**
 * Message protocol for the session-tail worker (`tail-worker.ts`).
 * The worker owns everything file-side per tail — watchers, debounce,
 * the polling backstop, byte-offset reads, and jsonl parsing — and
 * posts parsed deltas back; the main thread (`tail.ts`) only applies
 * them to the registry map and fires the query-refresh sinks.
 */
import type { ActionLine, MessageEmit } from "./events.ts";
import type { RefreshTarget } from "./refresh-triggers.ts";
import type { SessionContextUsage } from "./tail-parse.ts";

export type TailWorkerMessage =
  | {
      type: "ensure";
      key: string;
      slug: string;
      name: string | null;
      /** Resolved jsonl path — the main thread owns path derivation. */
      path: string;
      projectDir: string;
      jsonlName: string;
    }
  | { type: "stop"; key: string }
  | { type: "stop-all" };

/**
 * `usage` uses an explicit `hasUsage` flag rather than field absence:
 * the parser's tri-state (absent = keep prior, null = compact reset,
 * object = fresh figure) must survive structured clone unambiguously.
 */
export type TailWorkerResult =
  | {
      type: "seed";
      key: string;
      lines: ActionLine[];
      hasUsage: boolean;
      usage: SessionContextUsage | null;
    }
  | {
      type: "delta";
      key: string;
      slug: string;
      emits: MessageEmit[];
      hasUsage: boolean;
      usage: SessionContextUsage | null;
      /** Live-tail-detected `gh pr …` / `git push` &c targets. */
      triggers: RefreshTarget[];
    }
  | { type: "warn"; message: string; key?: string };
