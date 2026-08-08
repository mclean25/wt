/**
 * Reader for the Claude Code statusline's usage cache. The statusline
 * script (`~/.claude/statusline.sh`) hits Anthropic's
 * `/api/oauth/usage` endpoint at most once every 5 minutes and writes
 * the response to a JSON file. We piggyback on that cache so the TUI
 * can show the same `5h X% / 7d Y%` rollup without making its own
 * authenticated HTTP call.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type UsagePeriod = {
  /** Percentage utilization of the window. */
  utilization: number;
  /** ISO8601 timestamp when this window resets, or null when unknown. */
  resetsAt: string | null;
  /**
   * Model this window is scoped to (e.g. "Fable") when the API reports a
   * per-model limit rather than an account-wide one; null when it covers
   * the whole account. Optional because codex's reader has no equivalent.
   */
  label?: string | null;
};

export type ClaudeUsage = {
  /**
   * Either window is null when the account's plan doesn't report one —
   * a plan without an account-wide weekly limit still has a valid 5h
   * reading, and dropping both because one is missing is how this went
   * blank in the first place.
   */
  fiveHour: UsagePeriod | null;
  sevenDay: UsagePeriod | null;
  /**
   * Cache-file mtime in epoch ms. Lets the consumer decide whether the
   * cache is too stale to render — the statusline considers anything
   * older than 30 minutes "TBD" and we mirror that policy in the UI.
   */
  cachedAtMs: number;
};

const CACHE_PATH = join(homedir(), ".cache", "claude-statusline-usage.json");

/**
 * Load and parse the cache. Returns null when the file is missing or
 * malformed. Cheap fs read + JSON parse; safe to call on every render.
 */
export function readClaudeUsage(): ClaudeUsage | null {
  let stat;
  try {
    stat = statSync(CACHE_PATH);
  } catch {
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(CACHE_PATH, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const windows = parseClaudeUsage(parsed);
  if (!windows) return null;
  return { ...windows, cachedAtMs: stat.mtimeMs };
}

type LimitGroup = "session" | "weekly";

/**
 * Anthropic serves two response shapes, and which one an account gets
 * depends on its plan — so this flips over on a subscription change with
 * no client update, and both shapes stay in the wild at once:
 *
 *   newer  `limits: [{ group: "session" | "weekly", percent, resets_at,
 *          scope: { model: { display_name } } }]`, weekly optionally
 *          scoped per-model, `percent` an integer
 *   older  flat `five_hour` / `seven_day` / `seven_day_opus` /
 *          `seven_day_sonnet` objects, `utilization` a float
 *
 * Read `limits[]` first and fall back to the flat fields.
 */
export function parseClaudeUsage(
  parsed: unknown,
): Pick<ClaudeUsage, "fiveHour" | "sevenDay"> | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const fiveHour = pickWindow(obj, "session");
  const sevenDay = pickWindow(obj, "weekly");
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}

function pickWindow(
  obj: Record<string, unknown>,
  group: LimitGroup,
): UsagePeriod | null {
  const fromLimits = limitsCandidates(obj, group);
  const list = fromLimits.length > 0 ? fromLimits : flatCandidates(obj, group);
  if (list.length === 0) return null;
  // A group can hold several scoped windows (one per model). The highest
  // is the one that will actually bite, so that's the one worth showing.
  return list.reduce((a, b) => (b.utilization > a.utilization ? b : a));
}

function limitsCandidates(
  obj: Record<string, unknown>,
  group: LimitGroup,
): UsagePeriod[] {
  if (!Array.isArray(obj.limits)) return [];
  const out: UsagePeriod[] = [];
  for (const entry of obj.limits) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.group !== group) continue;
    if (typeof e.percent !== "number") continue;
    out.push({
      utilization: e.percent,
      resetsAt: typeof e.resets_at === "string" ? e.resets_at : null,
      label: scopeLabel(e.scope),
    });
  }
  return out;
}

/** `scope.model.display_name` when present, else null (account-wide). */
function scopeLabel(scope: unknown): string | null {
  if (!scope || typeof scope !== "object") return null;
  const model = (scope as Record<string, unknown>).model;
  if (!model || typeof model !== "object") return null;
  const name = (model as Record<string, unknown>).display_name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

/** Flat-shape keys per group, with the scope label they stand for. */
const FLAT_KEYS: Record<LimitGroup, ReadonlyArray<[string, string | null]>> = {
  session: [["five_hour", null]],
  weekly: [
    ["seven_day", null],
    ["seven_day_opus", "Opus"],
    ["seven_day_sonnet", "Sonnet"],
  ],
};

function flatCandidates(
  obj: Record<string, unknown>,
  group: LimitGroup,
): UsagePeriod[] {
  const out: UsagePeriod[] = [];
  for (const [key, label] of FLAT_KEYS[group]) {
    const p = period(obj[key]);
    if (p) out.push({ ...p, label });
  }
  return out;
}

function period(raw: unknown): UsagePeriod | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.utilization !== "number") return null;
  return {
    utilization: r.utilization,
    resetsAt: typeof r.resets_at === "string" ? r.resets_at : null,
    label: null,
  };
}
