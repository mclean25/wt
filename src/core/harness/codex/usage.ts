/**
 * Reader for Codex's rate-limit usage. Codex writes a `token_count`
 * event into its rollout jsonl on each turn. Depending on the account,
 * that block may contain both a 5h and 7d window or only one of them.
 * Window identity comes from `window_minutes`, not the `primary` /
 * `secondary` slot: current Pro payloads put the 7d window in `primary`.
 * We read the most-recently-modified rollout's latest such event — no
 * HTTP call, no separate cache file.
 *
 * Account-global: any recent rollout reflects current limits, so the
 * newest one across the whole sessions tree is the freshest source
 * regardless of which worktree it belongs to.
 */
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { UsagePeriod } from "../claude/usage.ts";
import { createLogger } from "../../logger.ts";
import { readFileSlice } from "../../tail-util.ts";

const log = createLogger("[codex-usage]");

const SESSIONS_DIR = join(homedir(), ".codex", "sessions");
/** Trailing bytes to scan for the latest `token_count` event. */
const TAIL_BYTES = 96 * 1024;
export type CodexUsage = {
  fiveHour: UsagePeriod | null;
  sevenDay: UsagePeriod | null;
  /** Plan tier from the rate-limit payload (e.g. "plus"), or null. */
  planType: string | null;
  /** Newest rollout mtime, epoch ms — drives the staleness gate. */
  cachedAtMs: number;
};

/**
 * Walk the date-partitioned sessions tree and return the rollout with
 * the greatest mtime. Sessions retain their original date path when
 * resumed, so limiting this to the newest date directories misses the
 * exact rollout that is currently producing fresh usage data.
 */
function findLatestRollout(
  sessionsDir: string,
): { path: string; mtimeMs: number; size: number } | null {
  let best: { path: string; mtimeMs: number; size: number } | null = null;
  const dirs = [sessionsDir];
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(path);
        continue;
      }
      if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
      try {
        const st = statSync(path);
        if (!best || st.mtimeMs > best.mtimeMs) {
          best = { path, mtimeMs: st.mtimeMs, size: st.size };
        }
      } catch {
        // skip unreadable
      }
    }
  }
  return best;
}

function period(raw: unknown): UsagePeriod | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.used_percent !== "number") return null;
  // `resets_at` is epoch SECONDS here (Claude's is an ISO string); the
  // shared `UsagePeriod.resetsAt` is ISO, so normalize.
  const resetsAt =
    typeof r.resets_at === "number"
      ? new Date(r.resets_at * 1000).toISOString()
      : null;
  return { utilization: r.used_percent, resetsAt };
}

function windowMinutes(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const value = (raw as Record<string, unknown>).window_minutes;
  return typeof value === "number" ? value : null;
}

/**
 * Read the newest rollout's last `token_count.rate_limits`. Returns null
 * when no rollout exists or none carries a rate-limit block (e.g. a
 * fresh session before its first turn).
 */
export function readCodexUsage(sessionsDir = SESSIONS_DIR): CodexUsage | null {
  const latest = findLatestRollout(sessionsDir);
  if (!latest || latest.size === 0) return null;

  const start = Math.max(0, latest.size - TAIL_BYTES);
  let text: string;
  try {
    text = readFileSlice(latest.path, start, latest.size - start);
  } catch (err) {
    log.debug("rollout tail read failed", { err: String(err) });
    return null;
  }

  const lines = text.split("\n");
  // Scan backward for the most recent token_count carrying rate_limits.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || !line.includes("rate_limits")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type !== "event_msg") continue;
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (!payload || payload.type !== "token_count") continue;
    const rl = payload.rate_limits as Record<string, unknown> | undefined;
    if (!rl) continue;
    const primary = period(rl.primary);
    const secondary = period(rl.secondary);
    const primaryMinutes = windowMinutes(rl.primary);
    const secondaryMinutes = windowMinutes(rl.secondary);
    // Older payloads omitted `window_minutes` but consistently used the
    // original primary=5h / secondary=7d ordering. Prefer explicit window
    // lengths and retain that positional fallback only where identity is
    // absent.
    const five = primaryMinutes === 300
      ? primary
      : secondaryMinutes === 300
      ? secondary
      : primaryMinutes === null
      ? primary
      : null;
    const seven = primaryMinutes === 10_080
      ? primary
      : secondaryMinutes === 10_080
      ? secondary
      : secondaryMinutes === null
      ? secondary
      : null;
    if (!five && !seven) continue;
    return {
      fiveHour: five,
      sevenDay: seven,
      planType: typeof rl.plan_type === "string" ? rl.plan_type : null,
      cachedAtMs: latest.mtimeMs,
    };
  }
  return null;
}
