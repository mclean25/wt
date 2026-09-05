/**
 * The manager session's shared identity constants.
 *
 * The manager runs in the MAIN CLONE's directory (so `gh`, repo
 * context, and `wt status --all` work), which is the same cwd as the
 * `.` main-clone slot. Claude's primary-conversation UUID is derived
 * from the cwd alone, so two "primary" sessions in one directory are
 * literally ONE conversation — the manager therefore lives as a NAMED
 * claude session (`manager~manager` in tmux, its own deterministic
 * UUID from `wtSessionUuid(mainClone, "manager")`). Every path that
 * addresses the manager (the TUI `m` key, `wt manager [send]`,
 * `[[actions]]` with `target = "manager"`, automations briefings)
 * must pass `MANAGER_CLAUDE_NAME` as the managed name — import from
 * here, never restate the strings.
 *
 * Codex / OpenCode ignore managed names for tmux naming (single slot
 * per slug). Codex separately stamps the opening user message and filters
 * discovery by slot ownership; see harness/codex/slot.ts.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { config } from "./config.ts";
import { addClaudeName } from "./harness/claude/names.ts";
import { withFileLock } from "./locks.ts";
import { readFileSlice } from "./tail-util.ts";

export const MANAGER_SLUG = "manager";
export const MANAGER_CLAUDE_NAME = "manager";

/**
 * Persist the manager's claude name so session discovery
 * (`claudeStatus` → `listClaudeNames`) sees the named conversation —
 * the footer's `[m]` state and the resume-vs-create gate both depend
 * on it. Idempotent; call before any manager addressing.
 */
export function ensureManagerClaudeName(): void {
  addClaudeName(MANAGER_SLUG, MANAGER_CLAUDE_NAME);
}

// ---------------------------------------------------------------------------
// Manager reports — the outbound channel.
//
// `wt manager send` and the `M` palette push work INTO the manager; this
// spool is how results come back OUT without the human attaching. The
// manager (or any script) runs `wt manager report "..."` — the CLI appends
// a JSON line here, and a running TUI fs-watches the file and surfaces
// each new line on the attention feed (source `[manager]`, toast by
// default). Same push-based shape as the events daemon's marker file:
// cross-process by construction, no daemon required.
//
// The spool is a delivery channel, not a record — the daily app log keeps
// the durable copy the moment the TUI surfaces a report, and reports
// appended while no TUI is running are deliberately NOT replayed at the
// next boot (stale triage results interrupting a fresh scan would be
// noise). Rotation keeps the file bounded.
// ---------------------------------------------------------------------------

export type ManagerReportLevel = "info" | "ok" | "warn" | "err";

export type ManagerReport = {
  /** ISO-8601 write time. */
  at: string;
  level: ManagerReportLevel;
  text: string;
};

/**
 * Beside the query cache, like the events dir — follows a moved
 * `cache_db`. Its own subdirectory ON PURPOSE: the TUI fs-watches the
 * spool's parent dir (the file may not exist yet), and the cache root
 * churns constantly with sqlite WAL traffic.
 */
export const MANAGER_REPORTS_PATH = join(
  config.paths.cacheRoot,
  "manager",
  "reports.jsonl",
);

/** Rotate when the spool outgrows this; keep the newest tail. */
const REPORTS_MAX_BYTES = 64 * 1024;
const REPORTS_KEEP_LINES = 100;

/**
 * Append one report line. Rotation runs under the cross-process file
 * lock so two concurrent `wt manager report` calls can't interleave a
 * rewrite; the append itself is a single O_APPEND write.
 */
export function appendManagerReport(level: ManagerReportLevel, text: string): void {
  const report: ManagerReport = { at: new Date().toISOString(), level, text };
  const line = `${JSON.stringify(report)}\n`;
  withFileLock("manager-reports", () => {
    mkdirSync(dirname(MANAGER_REPORTS_PATH), { recursive: true });
    let size = 0;
    try {
      size = statSync(MANAGER_REPORTS_PATH).size;
    } catch {
      // missing file — first append creates it
    }
    if (size > REPORTS_MAX_BYTES) {
      try {
        const kept = readFileSync(MANAGER_REPORTS_PATH, "utf8")
          .split("\n")
          .filter((l) => l.length > 0)
          .slice(-REPORTS_KEEP_LINES);
        writeFileSync(MANAGER_REPORTS_PATH, kept.map((l) => `${l}\n`).join(""));
      } catch {
        // Rotation is best-effort; a failed trim must not drop the report.
      }
    }
    appendFileSync(MANAGER_REPORTS_PATH, line, "utf8");
  });
}

/**
 * Read whole report lines from `offset`. Returns the parsed reports and
 * the offset to resume from (end of the last COMPLETE line — a partial
 * trailing fragment stays unconsumed for the next read). A shrunken
 * file (rotation) resets to a full re-read from 0; the caller's
 * seen-set semantics come from offset tracking alone, so post-rotation
 * duplicates are bounded by `REPORTS_KEEP_LINES` and only occur in the
 * rare rotate-while-watching window.
 */
export function readManagerReportsFrom(offset: number): {
  reports: ManagerReport[];
  nextOffset: number;
} {
  let size = 0;
  try {
    size = statSync(MANAGER_REPORTS_PATH).size;
  } catch {
    return { reports: [], nextOffset: 0 };
  }
  const start = size < offset ? 0 : offset;
  if (size === start) return { reports: [], nextOffset: start };
  let body: string;
  try {
    body = readFileSlice(MANAGER_REPORTS_PATH, start, size - start);
  } catch {
    // Racing the writer's rotate (or a transient open failure) — skip
    // this tick, keep the offset; the next drain re-stats from scratch.
    // Callers run inside bare timer callbacks, so throwing here would
    // take down the whole TUI, not just the reports feature.
    return { reports: [], nextOffset: start };
  }
  const lastNewline = body.lastIndexOf("\n");
  if (lastNewline < 0) return { reports: [], nextOffset: start };
  const reports: ManagerReport[] = [];
  for (const line of body.slice(0, lastNewline).split("\n")) {
    if (!line) continue;
    const parsed = parseManagerReport(line);
    if (parsed) reports.push(parsed);
  }
  return { reports, nextOffset: start + Buffer.byteLength(body.slice(0, lastNewline + 1), "utf8") };
}

const REPORT_LEVELS: ReadonlySet<string> = new Set(["info", "ok", "warn", "err"]);

function parseManagerReport(line: string): ManagerReport | null {
  try {
    const raw = JSON.parse(line) as Partial<ManagerReport> | null;
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.text !== "string" || raw.text.length === 0) return null;
    const level =
      typeof raw.level === "string" && REPORT_LEVELS.has(raw.level)
        ? (raw.level as ManagerReportLevel)
        : "info";
    return { at: typeof raw.at === "string" ? raw.at : "", level, text: raw.text };
  } catch {
    return null;
  }
}
