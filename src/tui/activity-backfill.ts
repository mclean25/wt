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
import type { EventChannel, EventKind } from "../core/logger.ts";
import { events, isAttentionWorthy, type WtEvent } from "./activity-log.ts";

const KINDS = new Set<EventKind>(["info", "ok", "warn", "err", "dim"]);
/** Match the two buffer caps in activity-log.ts. */
const SEED_FIREHOSE = 500;
const SEED_ATTENTION = 200;

/**
 * Parse one daily-log line into an event, or null for non-event lines
 * (DEBUG/INFO/… records, malformed rows). Format written by
 * core/logger.ts `emit()` — fixed columns after the 24-char ISO stamp:
 * `<iso> <TAG:5> <kind:4> <source:16-padded> <text>`.
 */
export function parseEventLine(line: string): Omit<WtEvent, "id"> | null {
  if (line.length < 37) return null;
  const ts = Date.parse(line.slice(0, 24));
  if (Number.isNaN(ts)) return null;
  const tag = line.slice(25, 30);
  const channel: EventChannel | null =
    tag === "EVENT" ? "firehose" : tag === "ATTN " ? "attention" : null;
  if (channel === null) return null;
  const kind = line.slice(31, 35).trim() as EventKind;
  if (!KINDS.has(kind)) return null;
  const rest = line.slice(36);
  const firstSpace = rest.indexOf(" ");
  const source = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
  if (source === "") return null;
  // Source is padEnd(16)+" " when short; longer sources shift the text.
  // Leading whitespace beyond the pad is real (indented multi-line
  // events) and must survive.
  const text = rest.slice(Math.max(17, source.length + 1));
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
