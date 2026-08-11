/**
 * Pure parse layer for the claude session-jsonl tail: raw jsonl line →
 * buffer delta (+ context-usage signal), and the delta-application
 * helper. No fs, no timers, no logger — imported by BOTH sides of the
 * tail worker seam (`tail-worker.ts` parses off-thread; `tail.ts`
 * applies deltas to the registry on the render thread), so keeping it
 * dependency-free is what keeps the worker from dragging main-thread
 * modules in with it.
 */
import {
  type ActionLine,
  type MessageEmit,
  type ToolStartMap,
  AWAY_RECAP_HINT_RE,
  asObj,
  compactMeta,
  formatTokens,
  messageToLines,
  splitMessage,
} from "./events.ts";
import { jsonlTimestamp } from "../../tail-util.ts";

/**
 * Context occupancy of the conversation, from the most recent assistant
 * entry's `message.usage`: prompt tokens actually in the window
 * (`input_tokens` + both cache buckets). Powers the footer's manager
 * context-% readout; updates push-based as the tail reads each turn,
 * and a `/compact` reflects on the first post-compaction turn.
 */
export type SessionContextUsage = {
  tokens: number;
  /** Model id from the same entry, for window-size resolution. */
  model: string | null;
};

/**
 * Context-window size for a claude model id. Deliberately NOT a
 * per-model registry (checked: the session jsonl carries no window
 * size, and scraping the pane is worse). The Claude 5 era made 1M the
 * standard window (Opus 5 included — a 200k default here read the
 * footer's manager context % ~5x too high), so 1M is the default;
 * haiku is the one current family still on 200k. If that breaks, this
 * one function is the place to teach — resist growing a model table.
 */
export function contextWindowTokens(model: string | null): number {
  if (!model) return 1_000_000;
  return /haiku/i.test(model) ? 200_000 : 1_000_000;
}

export const EMPTY_EMIT: MessageEmit = { append: [], patch: [] };

/**
 * Apply one parser delta to a snapshot of buffer lines, returning a
 * new array. Patches by id (no-op when the id has already been evicted
 * past `MAX_BUFFERED_LINES` — the user can't see the line anyway),
 * then appends. Single pass over the array per delta; cheap at our
 * buffer scale (1000 lines, a handful of patches per delta).
 */
export function applyEmit(prev: readonly ActionLine[], emit: MessageEmit): ActionLine[] {
  const { append, patch } = emit;
  if (append.length === 0 && patch.length === 0) return prev.slice();
  let next: ActionLine[] = prev.slice();
  if (patch.length > 0) {
    const byId = new Map<number, ActionLine>();
    for (const p of patch) byId.set(p.id, p.line);
    next = next.map((l) => byId.get(l.id) ?? l);
  }
  if (append.length > 0) next = [...next, ...append];
  return next;
}

/**
 * Context tokens occupied per an assistant entry's `message.usage`:
 * fresh input plus both cache buckets (cache reads ARE in the window;
 * only their price differs). Null for non-assistant entries or when
 * the envelope carries no numeric usage.
 */
function extractUsage(e: Record<string, unknown>): SessionContextUsage | null {
  if (e.type !== "assistant") return null;
  // Sidechain (subagent) turns carry the SUBAGENT's window, not the
  // conversation's — surfacing them would make the % sawtooth.
  if (e.isSidechain === true) return null;
  const m = asObj(e.message);
  if (!m) return null;
  const u = asObj(m.usage);
  if (!u) return null;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  if (typeof u.input_tokens !== "number") return null;
  const tokens =
    num(u.input_tokens) +
    num(u.cache_read_input_tokens) +
    num(u.cache_creation_input_tokens);
  return { tokens, model: typeof m.model === "string" ? m.model : null };
}

/**
 * Parses one raw jsonl line into a buffer delta plus an optional
 * context-usage signal (see the `usage` field: absent = no change,
 * `null` = explicit reset from a compact boundary, an object = fresh
 * figure). Unit-tested via the `tail.ts` re-export.
 */
export function parseEntry(
  raw: string,
  toolStarts: ToolStartMap,
  nextId: () => number,
): MessageEmit & { usage?: SessionContextUsage | null } {
  let evt: unknown;
  try {
    evt = JSON.parse(raw);
  } catch {
    return EMPTY_EMIT;
  }
  const e = asObj(evt);
  if (!e) return EMPTY_EMIT;
  const t = e.type;
  const ts = jsonlTimestamp(e);
  if (t === "assistant" || t === "user") {
    // The auto-injected post-compaction summary blob ("This session is
    // being continued from a previous conversation…") arrives as a
    // user envelope flagged with `isCompactSummary`. Skip it — the
    // `compact_boundary` system event below carries the high-signal
    // marker (token deltas, trigger), and rendering the full summary
    // would dump several hundred lines of internal detail into the pane.
    if (t === "user" && e.isCompactSummary === true) return EMPTY_EMIT;
    const usage = extractUsage(e);
    const emit = messageToLines({
      role: t,
      message: e.message,
      ts,
      toolStarts,
      nextId,
    });
    return usage ? { ...emit, usage } : emit;
  }
  // system.compact_boundary — fired when the conversation is compacted
  // (manual `/compact` or auto when the context window fills). Surface
  // as a single dim marker line so the user can see where compactions
  // landed in the timeline. Token counts come from `compactMetadata`;
  // we annotate the trigger only when it's `auto` since manual is the
  // common case (the user just typed /compact).
  if (t === "system" && e.subtype === "compact_boundary") {
    const meta = asObj(e.compactMetadata);
    const pre =
      meta && typeof meta.preTokens === "number" ? meta.preTokens : null;
    const post =
      meta && typeof meta.postTokens === "number" ? meta.postTokens : null;
    const trigger =
      meta && typeof meta.trigger === "string" ? meta.trigger : null;
    const tokenPart =
      pre != null && post != null
        ? ` (${formatTokens(pre)} → ${formatTokens(post)})`
        : "";
    const triggerPart = trigger && trigger !== "manual" ? ` ${trigger}` : "";
    return {
      append: [
        {
          id: nextId(),
          ts,
          kind: "info",
          text: `↘ compacted${triggerPart}${tokenPart}`,
        },
      ],
      patch: [],
      // Explicit reset (not just "no info this line" — that's `usage`
      // absent). The pre-compact tokens/model no longer describe the
      // window; clearing to null makes the footer hide the % until the
      // next assistant turn lands with a fresh usage figure. Distinct
      // from the sidechain/non-numeric skip in `extractUsage`, which
      // omits the `usage` key entirely so callers keep the prior value.
      usage: null,
    };
  }
  // system.away_summary — claude's auto-generated context-recap when
  // the conversation is auto-compacted. High-signal: the user can
  // glance at the pane and see "this is what the previous turns were
  // about" without re-reading the whole tail. Multi-line: same
  // newline-split + per-line cap as assistant text, with the leading
  // `─` only on the first row so the block reads as one summary
  // group rather than a series of dash bullets.
  if (t === "system" && e.subtype === "away_summary") {
    const raw = typeof e.content === "string" ? e.content : "";
    const content = raw.replace(AWAY_RECAP_HINT_RE, "");
    const { pieces, truncated } = splitMessage(content);
    if (pieces.length === 0) return EMPTY_EMIT;
    const lines: ActionLine[] = pieces.map((piece, i) => ({
      id: nextId(),
      ts,
      kind: "info",
      text: `${i === 0 ? "─ " : "  "}${piece}`,
    }));
    if (truncated > 0) {
      lines.push({
        id: nextId(),
        ts,
        kind: "info",
        text: `  …${truncated} more line${truncated === 1 ? "" : "s"} truncated`,
      });
    }
    return { append: lines, patch: [] };
  }
  // attachment.queued_command — when the user types-ahead while
  // claude is still processing, the prompt sits queued. Surface the
  // user-typed ones (`commandMode === "prompt"`) so the pane shows
  // intent that would otherwise be invisible. `task-notification`
  // and other system-injected attachments stay dropped.
  if (t === "attachment") {
    const att = asObj(e.attachment);
    if (
      att &&
      att.type === "queued_command" &&
      att.commandMode === "prompt" &&
      typeof att.prompt === "string"
    ) {
      const compacted = compactMeta(att.prompt);
      if (compacted) {
        return {
          append: [
            {
              id: nextId(),
              ts,
              kind: "info",
              text: `⏎ queued: ${compacted}`,
            },
          ],
          patch: [],
        };
      }
    }
    return EMPTY_EMIT;
  }
  return EMPTY_EMIT;
}
