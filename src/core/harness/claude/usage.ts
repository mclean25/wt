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
   * Model this window is scoped to (e.g. "Fable") when it caps one model
   * rather than the whole account; null for account-wide windows.
   * Optional because codex's reader has no equivalent.
   */
  label?: string | null;
};

export type ClaudeUsage = {
  /** Rolling 5-hour session window. */
  fiveHour: UsagePeriod | null;
  /** Account-wide weekly window (`weekly_all` / legacy `seven_day`). */
  sevenDay: UsagePeriod | null;
  /**
   * Per-model weekly windows (`weekly_scoped` / legacy `seven_day_<model>`),
   * highest utilization first. Separate from `sevenDay` because they cap
   * different things: a plan can report a Fable weekly at 20% while the
   * account-wide weekly sits at 3%, and collapsing them to one number hides
   * whichever is about to bite.
   */
  sevenDayScoped: UsagePeriod[];
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

type ParsedWindows = Pick<
  ClaudeUsage,
  "fiveHour" | "sevenDay" | "sevenDayScoped"
>;

/**
 * Anthropic serves two response shapes, and which one an account gets
 * depends on its plan — so this flips over on a subscription change with
 * no client update:
 *
 *   newer  `limits: [{ kind, group, percent, resets_at, scope }]`, where
 *          kind is "session" | "weekly_all" | "weekly_scoped" and a scoped
 *          row names its model in `scope.model.display_name`
 *   older  flat `five_hour` / `seven_day` / `seven_day_<model>` objects
 *
 * The two mix in the wild — an account can report its account-wide weekly
 * in flat `seven_day` while the per-model weeklies arrive as `limits[]`
 * rows — so each of the three categories resolves independently, reading
 * `limits[]` first and falling back to the flat field for that category
 * alone. Resolving them together would let a populated `limits[]` hide a
 * flat window that has no `limits[]` equivalent.
 */
export function parseClaudeUsage(parsed: unknown): ParsedWindows | null {
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const fiveHour = highest(
    orElse(limitRows(obj, "session", false), () => flatRows(obj, SESSION_FLAT)),
  );
  const sevenDay = highest(
    orElse(limitRows(obj, "weekly", false), () =>
      flatRows(obj, WEEKLY_ALL_FLAT),
    ),
  );
  const sevenDayScoped = orElse(limitRows(obj, "weekly", true), () =>
    flatRows(obj, WEEKLY_SCOPED_FLAT),
  ).sort((a, b) => b.utilization - a.utilization);

  if (!fiveHour && !sevenDay && sevenDayScoped.length === 0) return null;
  return { fiveHour, sevenDay, sevenDayScoped };
}

function orElse(
  rows: UsagePeriod[],
  fallback: () => UsagePeriod[],
): UsagePeriod[] {
  return rows.length > 0 ? rows : fallback();
}

/**
 * A category should hold one window, but the API is free to send several
 * (and does, for scoped weeklies). The highest is the one that will
 * actually bite, so that's the one worth surfacing.
 */
function highest(rows: UsagePeriod[]): UsagePeriod | null {
  if (rows.length === 0) return null;
  return rows.reduce((a, b) => (b.utilization > a.utilization ? b : a));
}

/**
 * Rows from `limits[]` for one group, split on whether they name a model.
 * Keyed on `group` + `scope` rather than `kind` so a new kind string
 * (Anthropic renames these freely) doesn't silently drop a window.
 */
function limitRows(
  obj: Record<string, unknown>,
  group: "session" | "weekly",
  scoped: boolean,
): UsagePeriod[] {
  if (!Array.isArray(obj.limits)) return [];
  const out: UsagePeriod[] = [];
  for (const entry of obj.limits) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.group !== group) continue;
    if (typeof e.percent !== "number") continue;
    const label = scopeLabel(e.scope);
    if (scoped !== (label !== null)) continue;
    out.push({
      utilization: e.percent,
      resetsAt: typeof e.resets_at === "string" ? e.resets_at : null,
      label,
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
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Flat-shape keys per category, with the scope label each stands for. */
const SESSION_FLAT: ReadonlyArray<[string, string | null]> = [
  ["five_hour", null],
];
const WEEKLY_ALL_FLAT: ReadonlyArray<[string, string | null]> = [
  ["seven_day", null],
];
const WEEKLY_SCOPED_FLAT: ReadonlyArray<[string, string | null]> = [
  ["seven_day_opus", "Opus"],
  ["seven_day_sonnet", "Sonnet"],
  ["seven_day_fable", "Fable"],
];

function flatRows(
  obj: Record<string, unknown>,
  keys: ReadonlyArray<[string, string | null]>,
): UsagePeriod[] {
  const out: UsagePeriod[] = [];
  for (const [key, label] of keys) {
    const raw = obj[key];
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.utilization !== "number") continue;
    out.push({
      utilization: r.utilization,
      resetsAt: typeof r.resets_at === "string" ? r.resets_at : null,
      label,
    });
  }
  return out;
}

/**
 * Two-character cluster key for a window: "5h", "7d", or "7" plus the
 * initial of the scoped model ("Fable" → "7f"). `display_name` sometimes
 * carries a family prefix ("Claude 3.5 Fable"), so the initial comes from
 * the last word.
 */
export function windowKey(period: UsagePeriod, weekly: boolean): string {
  if (!weekly) return "5h";
  const label = period.label?.trim();
  if (!label) return "7d";
  const word = label.split(/\s+/).at(-1) ?? label;
  return `7${word.slice(0, 1).toLowerCase()}`;
}
