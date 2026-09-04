/**
 * Per-slug tail for Codex sessions, the non-Claude analogue of
 * `core/harness/claude/tail.ts`. Produces the same
 * `ActionLine[]` shape the claude tailer and action runner produce, so
 * the bottom pane renders Codex sessions with the same row components.
 *
 * Claude gets a purpose-built fs.watch tailer over its stream-json
 * jsonl. Codex persists rollout jsonl under `~/.codex/sessions/` and has
 * no per-line push signal, so this registry polls each live slot on a
 * shared interval, seeding history on first sight and appending deltas
 * after. Codex's filesystem walk + JSONL parse run in
 * `codex/tail-worker.ts`; the main thread only applies its ActionLine
 * batches. The event-pane poller (`codex/events.ts`) emits terse global
 * one-liners and skips history, which is a different job from this detailed,
 * history-seeded per-session trail.
 *
 * Codex has one tmux slot per slug (`<slug>-codex`), so the registry key
 * is `${slug}:codex` and there is at most one run per slug.
 */
import { statSync } from "node:fs";

import { Effect, Fiber } from "effect";

import {
  type ActionLine,
  type ActionLineKind,
  MAX_BUFFERED_LINES,
} from "./claude/events.ts";
import { createLogger } from "../logger.ts";
import { jsonlTimestamp, readFileSlice } from "../tail-util.ts";

import { latestRolloutForCwd } from "./codex/harness.ts";
import type {
  CodexTailSlot,
  CodexTailWorkerMessage,
  CodexTailWorkerResult,
} from "./codex/tail-protocol.ts";
import type { HarnessId } from "./types.ts";

const log = createLogger("[harness-tail]");

/** Harnesses this registry tails. Claude has its own (`claude/tail.ts`). */
export type TailHarnessId = Extract<HarnessId, "codex">;

export type HarnessRun = {
  slug: string;
  harnessId: TailHarnessId;
  startedAt: number;
  lines: readonly ActionLine[];
};

/** One live slot to keep tailed. */
export type LiveHarnessSlot = {
  slug: string;
  wtPath: string;
  harnessId: TailHarnessId;
};

/** Composite registry key. Mirrors the single-slot tmux name scheme. */
export function harnessTailKey(slug: string, harnessId: TailHarnessId): string {
  return `${slug}:${harnessId}`;
}

/** Poll cadence — matches the event-pane pollers. */
const POLL_INTERVAL_MS = 2_500;
/** Trailing bytes of a codex rollout to seed history from. */
const CODEX_SEED_BYTES = 48 * 1024;
/** Cap on parsed lines per single message/output so one giant blob can't
 *  swamp the buffer. */
const MAX_LINES_PER_BLOCK = 8;
/** Per-line character cap before ellipsis (the row truncates by width too,
 *  but bounding here keeps the buffer small). */
const MAX_LINE_CHARS = 240;

// ---------------------------------------------------------------------------
// Per-entry tail state
// ---------------------------------------------------------------------------

export type CodexCursor = {
  /** Rollout path currently tracked, or null until first found. */
  path: string | null;
  /** Byte offset already consumed. */
  offset: number;
  /** Trailing partial line carried to the next read (byte-accurate tail). */
  pending: string;
  /** Drop the first line of the seed window once (it's a partial). */
  seedDrop: boolean;
};

type Entry = {
  slug: string;
  wtPath: string;
  harnessId: TailHarnessId;
  startedAt: number;
};

/** Minimal mutable state owned by the Codex tail worker for one live slot. */
export type CodexTailPumpState = {
  wtPath: string;
  nextLineId: number;
  seeded: boolean;
  codex: CodexCursor;
};

export function createCodexTailPumpState(wtPath: string): CodexTailPumpState {
  return {
    wtPath,
    nextLineId: 1,
    seeded: false,
    codex: { path: null, offset: 0, pending: "", seedDrop: false },
  };
}

// ---------------------------------------------------------------------------
// Small line helpers
// ---------------------------------------------------------------------------

function clip(s: string): string {
  const t = s.replace(/\s+$/u, "");
  return t.length > MAX_LINE_CHARS ? `${t.slice(0, MAX_LINE_CHARS - 1)}…` : t;
}

/** Split a (possibly multi-line) blob into capped ActionLines. */
function textLines(
  text: string,
  kind: ActionLineKind,
  ts: number,
  nextId: () => number,
  prefix = "",
): ActionLine[] {
  const pieces = text
    .split("\n")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (pieces.length === 0) return [];
  const out: ActionLine[] = [];
  const shown = pieces.slice(0, MAX_LINES_PER_BLOCK);
  shown.forEach((piece, i) => {
    const lead = i === 0 ? prefix : prefix ? "  " : "";
    out.push({ id: nextId(), ts, kind, text: clip(`${lead}${piece}`) });
  });
  const hidden = pieces.length - shown.length;
  if (hidden > 0) {
    out.push({
      id: nextId(),
      ts,
      kind: "info",
      text: `  …${hidden} more line${hidden === 1 ? "" : "s"}`,
    });
  }
  return out;
}

function oneLine(
  text: string,
  kind: ActionLineKind,
  ts: number,
  nextId: () => number,
): ActionLine {
  return { id: nextId(), ts, kind, text: clip(text) };
}

// ---------------------------------------------------------------------------
// Codex rollout parsing
// ---------------------------------------------------------------------------

/** Map one parsed codex rollout event to zero or more ActionLines. */
function codexEventLines(
  obj: Record<string, unknown>,
  nextId: () => number,
): ActionLine[] {
  const ts = jsonlTimestamp(obj);
  const type = obj.type;

  if (type === "event_msg") {
    const p = obj.payload;
    if (typeof p !== "object" || p === null) return [];
    const pl = p as Record<string, unknown>;
    switch (pl.type) {
      case "user_message": {
        const m = pl.message;
        return typeof m === "string"
          ? textLines(m, "user", ts, nextId, "› ")
          : [];
      }
      case "agent_message": {
        const m = pl.message;
        return typeof m === "string" ? textLines(m, "assistant", ts, nextId) : [];
      }
      case "web_search_end": {
        const q = pl.query;
        return typeof q === "string"
          ? [oneLine(`⚒ web: ${q}`, "tool", ts, nextId)]
          : [];
      }
      case "turn_aborted":
        return [oneLine("⊘ turn interrupted", "info", ts, nextId)];
      default:
        return [];
    }
  }

  if (type === "response_item") {
    const p = obj.payload;
    if (typeof p !== "object" || p === null) return [];
    const pl = p as Record<string, unknown>;
    if (pl.type === "function_call") {
      const name = typeof pl.name === "string" ? pl.name : "tool";
      if (name === "exec_command" || name === "shell") {
        const cmd = extractCodexCmd(pl.arguments);
        return [oneLine(`⚒ ${cmd}`, "tool", ts, nextId)];
      }
      if (name === "apply_patch") {
        return [oneLine("⚒ apply_patch", "tool", ts, nextId)];
      }
      return [oneLine(`⚒ ${name}`, "tool", ts, nextId)];
    }
    if (pl.type === "reasoning") {
      // Codex reasoning summaries land in `summary[].text`. Surface the
      // first as a dim thinking line; full chain-of-thought is noise.
      const summary = pl.summary;
      if (Array.isArray(summary) && summary.length > 0) {
        const first = summary[0] as Record<string, unknown> | undefined;
        const txt = first && typeof first.text === "string" ? first.text : null;
        if (txt) return textLines(txt, "thinking", ts, nextId, "… ").slice(0, 1);
      }
      return [];
    }
  }
  return [];
}

function extractCodexCmd(args: unknown): string {
  if (typeof args !== "string") return "<command>";
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const raw = parsed.cmd ?? parsed.command;
    if (Array.isArray(raw)) return raw.join(" ");
    if (typeof raw === "string") return raw;
  } catch {
    // fall through
  }
  return args;
}

/**
 * Pull new ActionLines for a codex slot, advancing the byte cursor.
 * First sight seeds from a trailing window; later calls read the delta.
 * Partial trailing lines are held in `cur.pending` across ticks so the
 * offset always advances to EOF without ever re-reading or losing bytes.
 */
export function pumpCodexTail(entry: CodexTailPumpState): ActionLine[] {
  const rollout = latestRolloutForCwd(entry.wtPath);
  if (!rollout) return [];
  const cur = entry.codex;
  const nextId = () => entry.nextLineId++;

  // First sight, or codex rotated to a new rollout: baseline the cursor.
  // On the first seed we start a trailing window back (and drop its
  // leading partial line); on a mid-run rotation we start at byte 0 of
  // the small fresh file so its opening turn isn't missed.
  if (cur.path !== rollout.path) {
    cur.path = rollout.path;
    cur.pending = "";
    cur.offset = entry.seeded ? 0 : Math.max(0, rollout.size - CODEX_SEED_BYTES);
    cur.seedDrop = cur.offset > 0;
  }

  let size: number;
  try {
    size = statSync(rollout.path).size;
  } catch {
    return [];
  }
  if (size < cur.offset) {
    // Truncated/rotated under us — resync.
    cur.offset = size;
    cur.pending = "";
    return [];
  }
  if (size === cur.offset) return [];

  let body: string;
  try {
    body = readFileSlice(rollout.path, cur.offset, size - cur.offset);
  } catch {
    return [];
  }
  cur.offset = size;

  const combined = cur.pending + body;
  const lines = combined.split("\n");
  cur.pending = lines.pop() ?? ""; // trailing partial → next tick
  const out: ActionLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === 0 && cur.seedDrop) {
      cur.seedDrop = false; // the seed window's leading partial line
      continue;
    }
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    out.push(...codexEventLines(obj, nextId));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

type Listener = () => void;

/** Structural worker boundary for deterministic registry lifecycle tests. */
export type CodexTailWorker = {
  postMessage(message: CodexTailWorkerMessage): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(type: "close", listener: (event: Event) => void): void;
  terminate(): unknown;
  unref?(): void;
};

export type CodexTailWorkerFactory = () => CodexTailWorker;

export class HarnessTailRegistry {
  private runs: ReadonlyMap<string, HarnessRun> = new Map();
  private state = new Map<string, Entry>();
  private listeners = new Set<Listener>();
  private poller: Fiber.Fiber<never, never> | null = null;
  private codexWorker: CodexTailWorker | null = null;
  private codexInFlight: number | null = null;
  private codexPumpAgain = false;
  private nextCodexPumpId = 1;

  constructor(
    private readonly codexWorkerFactory: CodexTailWorkerFactory = () =>
      new Worker(new URL("./codex/tail-worker.ts", import.meta.url).href),
  ) {}

  ensure(slug: string, wtPath: string, harnessId: TailHarnessId): void {
    const key = harnessTailKey(slug, harnessId);
    const existing = this.state.get(key);
    if (existing) {
      // Re-point if the worktree path changed under the same slug.
      if (existing.wtPath === wtPath) return;
      this.stopByKey(key);
    }
    const entry: Entry = {
      slug,
      wtPath,
      harnessId,
      startedAt: Date.now(),
    };
    this.state.set(key, entry);
    this.commit((m) =>
      m.set(key, { slug, harnessId, startedAt: entry.startedAt, lines: [] }),
    );
    this.requestCodexPump();
    this.ensurePoller();
  }

  stop(slug: string, harnessId: TailHarnessId): void {
    this.stopByKey(harnessTailKey(slug, harnessId));
  }

  private stopByKey(key: string): void {
    const entry = this.state.get(key);
    if (!entry || !this.state.delete(key)) return;
    if (this.codexWorker) {
      this.postCodex(this.codexWorker, { type: "stop", key });
    }
    this.commit((m) => {
      m.delete(key);
    });
    if (this.state.size === 0) this.stopPoller();
  }

  /** Spin tailers for the live set; drop tailers no longer live. */
  reconcile(live: readonly LiveHarnessSlot[]): void {
    const liveKeys = new Set<string>();
    for (const slot of live) {
      liveKeys.add(harnessTailKey(slot.slug, slot.harnessId));
      this.ensure(slot.slug, slot.wtPath, slot.harnessId);
    }
    for (const key of [...this.state.keys()]) {
      if (!liveKeys.has(key)) this.stopByKey(key);
    }
  }

  stopAll(): void {
    for (const key of [...this.state.keys()]) this.stopByKey(key);
    this.stopPoller();
    this.disposeCodexWorker();
  }

  getSnapshot = (): ReadonlyMap<string, HarnessRun> => this.runs;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  // ---------- internals ----------

  private ensurePoller(): void {
    if (this.poller) return;
    const tick = Effect.sync(() => this.requestCodexPump());
    this.poller = Effect.runFork(
      Effect.sleep(POLL_INTERVAL_MS).pipe(Effect.andThen(tick), Effect.forever),
    );
  }

  private stopPoller(): void {
    if (!this.poller) return;
    Effect.runFork(Fiber.interrupt(this.poller));
    this.poller = null;
  }

  private append(key: string, appended: readonly ActionLine[]): void {
    if (appended.length === 0) return;
    const cur = this.runs.get(key);
    if (!cur) return;
    const next = [...cur.lines, ...appended];
    const trimmed =
      next.length > MAX_BUFFERED_LINES ? next.slice(-MAX_BUFFERED_LINES) : next;
    this.commit((m) => m.set(key, { ...cur, lines: trimmed }));
  }

  private postCodex(
    worker: CodexTailWorker,
    message: CodexTailWorkerMessage,
  ): void {
    worker.postMessage(message);
  }

  private ensureCodexWorker(): CodexTailWorker {
    if (this.codexWorker) return this.codexWorker;
    const worker = this.codexWorkerFactory();
    worker.addEventListener("message", (event: MessageEvent) => {
      if (worker !== this.codexWorker) return;
      const result = event.data as CodexTailWorkerResult;
      if (result.id !== this.codexInFlight) return;
      this.codexInFlight = null;
      for (const update of result.updates) this.append(update.key, update.lines);
      for (const error of result.errors) {
        const entry = this.state.get(error.key);
        log.warn("codex tail worker pump failed", {
          slug: entry?.slug ?? error.key,
          err: error.message,
        });
      }
      if (this.codexPumpAgain) {
        this.codexPumpAgain = false;
        this.requestCodexPump();
      }
    });
    const failed = (reason: string) => {
      if (worker !== this.codexWorker) return;
      this.codexWorker = null;
      this.codexInFlight = null;
      this.codexPumpAgain = false;
      log.warn("codex tail worker died", { err: reason });
      try {
        worker.terminate();
      } catch {
        // already gone
      }
    };
    worker.addEventListener("error", (event) => failed(event.message || "error"));
    worker.addEventListener("close", () => failed("exited"));
    worker.unref?.();
    this.codexWorker = worker;
    return worker;
  }

  private requestCodexPump(): void {
    const slots: CodexTailSlot[] = [];
    for (const [key, entry] of this.state) {
      if (entry.harnessId === "codex") {
        slots.push({ key, slug: entry.slug, wtPath: entry.wtPath });
      }
    }
    if (slots.length === 0) return;
    if (this.codexInFlight !== null) {
      this.codexPumpAgain = true;
      return;
    }
    const id = this.nextCodexPumpId++;
    this.codexInFlight = id;
    try {
      this.postCodex(this.ensureCodexWorker(), { type: "pump", id, slots });
    } catch (err) {
      this.codexInFlight = null;
      log.warn("codex tail worker dispatch failed", { err: String(err) });
      this.disposeCodexWorker();
    }
  }

  private disposeCodexWorker(): void {
    const worker = this.codexWorker;
    this.codexWorker = null;
    this.codexInFlight = null;
    this.codexPumpAgain = false;
    if (!worker) return;
    try {
      worker.terminate();
    } catch {
      // already gone
    }
  }

  private commit(mut: (m: Map<string, HarnessRun>) => void): void {
    const next = new Map(this.runs);
    mut(next);
    this.runs = next;
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // sink errors must not break dispatch
      }
    }
  }
}

export const harnessTailRegistry = new HarnessTailRegistry();
