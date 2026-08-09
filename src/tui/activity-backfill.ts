/**
 * Boot-time restore for the bottom pane: the in-memory event buffers
 * die with the process, but every pane line is also a tagged line in
 * the daily app log (`EVENT` / `ATTN` — see core/logger.ts). Parsing
 * those back at startup means a restart doesn't wipe the feeds — the
 * attention trail (status transitions, manager briefings, needs-you
 * signals) survives, which is exactly the feed you consult AFTER
 * something restarted.
 *
 * Reads yesterday's + today's files (bounded: two smallish text files,
 * once, at boot) and seeds at most the buffers' own caps.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "../core/config.ts";
import {
  KIND_PAD,
  SRC_PAD,
  TAG_PAD,
  TS_LEN,
  type EventChannel,
  type EventKind,
} from "../core/logger.ts";
import { events, isAttentionWorthy, type WtEvent } from "./activity-log.ts";

const KINDS = new Set<EventKind>(["info", "ok", "warn", "err", "dim"]);
/** Match the two buffer caps in activity-log.ts. */
const SEED_FIREHOSE = 500;
const SEED_ATTENTION = 200;

// Column offsets, derived from the same constants `core/logger.ts`
// `emit()` writes with — one space separates each fixed-width field:
// `<ts:TS_LEN> <tag:TAG_PAD> <kind:KIND_PAD> <source:SRC_PAD+> <text>`.
const TAG_START = TS_LEN + 1;
const TAG_END = TAG_START + TAG_PAD;
const KIND_START = TAG_END + 1;
const KIND_END = KIND_START + KIND_PAD;
const SRC_START = KIND_END + 1;
/** Shortest possible valid line: the fixed header, a full source pad, and one text char. */
const MIN_LINE_LEN = SRC_START + SRC_PAD + 1 + 1;

/**
 * Parse one daily-log line into an event, or null for non-event lines
 * (DEBUG/INFO/… records, malformed rows). Format written by
 * core/logger.ts `emit()` — fixed columns after the ISO stamp:
 * `<iso> <TAG:TAG_PAD> <kind:KIND_PAD> <source:SRC_PAD-padded> <text>`.
 */
export function parseEventLine(line: string): Omit<WtEvent, "id"> | null {
  if (line.length < MIN_LINE_LEN) return null;
  const ts = Date.parse(line.slice(0, TS_LEN));
  if (Number.isNaN(ts)) return null;
  const tag = line.slice(TAG_START, TAG_END);
  const channel: EventChannel | null =
    tag === "EVENT" ? "firehose" : tag === "ATTN " ? "attention" : null;
  if (channel === null) return null;
  const kind = line.slice(KIND_START, KIND_END).trim() as EventKind;
  if (!KINDS.has(kind)) return null;
  const rest = line.slice(SRC_START);
  // Source is padEnd(SRC_PAD)+" " when it fits the pad — the separator
  // then always lands exactly at index SRC_PAD, whatever spaces the
  // source itself contains before that point. A source longer than
  // SRC_PAD isn't truncated (padEnd is a no-op past its target width),
  // so the real separator can land past the pad boundary too; searching
  // from SRC_PAD onward (never from 0) finds it either way instead of
  // mistaking an internal space for the delimiter.
  const sepIdx = rest.indexOf(" ", SRC_PAD);
  if (sepIdx === -1) return null;
  const source = rest.slice(0, sepIdx).trimEnd();
  if (source === "") return null;
  // Leading whitespace beyond the separator is real (indented
  // multi-line events) and must survive.
  const text = rest.slice(sepIdx + 1);
  return { ts, level: kind, channel, source, text };
}

function localDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Seed the activity store from the daily logs. Call ONCE at TUI boot,
 * before `setEventSink` — lines written by this very process before
 * the sink existed are in the file and get restored like any others,
 * so nothing is double-counted. Never throws: a corrupt or unreadable
 * log yields an empty (or partial) backfill, not a failed boot.
 */
export function backfillActivityLog(): void {
  try {
    const parsed: Array<Omit<WtEvent, "id">> = [];
    for (const day of [localDay(-1), localDay(0)]) {
      const path = join(config.paths.appLogDir, `wt-${day}.log`);
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const e = parseEventLine(line);
        if (e) parsed.push(e);
      }
    }
    if (parsed.length === 0) return;
    // Select per feed, then union: attention lines are RARE relative
    // to firehose chatter, so slicing one recent window would evict
    // exactly the needs-you trail this backfill exists to preserve.
    // Set dedupes by object identity (both slices share elements).
    const recent = parsed.slice(-SEED_FIREHOSE);
    const attention = parsed.filter(isAttentionWorthy).slice(-SEED_ATTENTION);
    const chosen = [...new Set([...attention, ...recent])].sort((a, b) => a.ts - b.ts);
    events.seed(chosen);
  } catch {
    // Backfill is best-effort by design.
  }
}
