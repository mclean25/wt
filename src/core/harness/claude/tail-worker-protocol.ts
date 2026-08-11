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
      /**
       * Per-ensure generation, echoed on every result for this key.
       * A destroy+recreate cycle reuses the same key with a NEW path;
       * a delta the worker had in flight for the old path (its debounce
       * timer can fire before the stop/ensure pair is dequeued) must
       * not land on the new tail's freshly-reset buffer. The pre-worker
       * tailer got this for free from a synchronous clearTimeout; the
       * generation restores it across the thread boundary.
       */
      gen: number;
      slug: string;
      name: string | null;
      /** Resolved jsonl path — the main thread owns path derivation. */
      path: string;
      projectDir: string;
      jsonlName: string;
    }
  | { type: "stop"; key: string };

/**
 * `usage` uses an explicit `hasUsage` flag rather than field absence:
 * the parser's tri-state (absent = keep prior, null = compact reset,
 * object = fresh figure) must survive structured clone unambiguously.
 */
export type TailWorkerResult =
  | {
      type: "seed";
      key: string;
      gen: number;
      lines: ActionLine[];
      hasUsage: boolean;
      usage: SessionContextUsage | null;
    }
  | {
      type: "delta";
      key: string;
      gen: number;
      slug: string;
      emits: MessageEmit[];
      hasUsage: boolean;
      usage: SessionContextUsage | null;
      /** Live-tail-detected `gh pr …` / `git push` &c targets. */
      triggers: RefreshTarget[];
    }
  | { type: "warn"; message: string; key?: string };
