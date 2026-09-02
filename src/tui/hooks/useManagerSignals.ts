/**
 * The manager's outbound signals, surfaced on the attention feed.
 *
 * Reports — `wt manager report` (the closing move of every `M` palette
 * command) appends to a small jsonl spool; this hook fs-watches the
 * spool's directory and narrates each NEW line via `log.attention.*`
 * (source `manager`, toast by default). Cross-process by construction:
 * the writer is the manager's own CLI call in another process, exactly
 * like `wt status` narration rides the wtstate watcher. History is
 * seeded silently (offset = current size) — reports written while no
 * TUI was running are stale triage, not news.
 *
 * Asking — a transition of the manager session's derived state into
 * `asking` gets one attention line. Unlike worktree rows (whose status
 * dots make an asking session visible), the manager's only steady
 * surface is the tiny footer `[m]`, and palette-dispatched work runs
 * detached — a permission prompt would otherwise stall silently.
 */
import { useEffect, useRef } from "react";
import { mkdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { Effect, Fiber } from "effect";

import type { DerivedState } from "../../core/harness/status.ts";
import { createLogger } from "../../core/logger.ts";
import {
  MANAGER_REPORTS_PATH,
  readManagerReportsFrom,
  type ManagerReport,
} from "../../core/manager.ts";
import { makeDebounced } from "../../core/repo-watch.ts";
import { closeSilent } from "../../core/tail-util.ts";

const log = createLogger("manager");

/** Backstop poll — Bun's fs.watch on macOS can miss append events. */
const REPORTS_POLL_MS = 10_000;

/**
 * Per-drain surfacing cap. Normal traffic is one line per palette
 * command, but the offset-reset path after a spool rotation can hand
 * back up to the whole kept tail (~100 lines) at once — replaying that
 * as attention lines would bury the feed in duplicates. Newest wins.
 */
const MAX_SURFACED_PER_DRAIN = 20;

function surfaceReport(r: ManagerReport): void {
  // Attention-channel emits toast by default — a report is precisely
  // "worth interrupting a scan". Multi-line text splits into one pane
  // line each inside the logger.
  if (r.level === "err") log.attention.err(r.text);
  else if (r.level === "warn") log.attention.warn(r.text);
  else if (r.level === "ok") log.attention.ok(r.text);
  else log.attention.info(r.text);
}

export function useManagerReports(): void {
  useEffect(() => {
    let offset = 0;
    try {
      offset = statSync(MANAGER_REPORTS_PATH).size;
    } catch {
      // spool doesn't exist yet — first report starts from 0
    }
    let stopped = false;
    const drain = (): void => {
      if (stopped) return;
      const { reports, nextOffset } = readManagerReportsFrom(offset);
      offset = nextOffset;
      for (const r of reports.slice(-MAX_SURFACED_PER_DRAIN)) surfaceReport(r);
    };
    const debounced = makeDebounced(drain, 150);
    // Watch the spool's parent dir: the file may not exist yet, and the
    // dir (a dedicated `manager/` subdir, not the busy cache root) only
    // sees report traffic. Filename can be null on some macOS event
    // shapes — treat that as "check".
    let watcher: FSWatcher | null = null;
    const reportsName = basename(MANAGER_REPORTS_PATH);
    try {
      // Pre-create the dir so the watcher attaches before the first
      // report ever lands (the CLI append also creates it).
      mkdirSync(dirname(MANAGER_REPORTS_PATH), { recursive: true });
      watcher = watch(
        dirname(MANAGER_REPORTS_PATH),
        { persistent: false },
        (_event, filename) => {
          if (filename == null || filename === reportsName) debounced.trigger();
        },
      );
      watcher.on("error", () => {
        // Poll backstop still runs; a dead watcher just means slower.
      });
    } catch {
      // Dir missing until the first report — the poll below promotes
      // delivery; recreating the watcher isn't worth the machinery.
    }
    const poll = Effect.runFork(
      Effect.forever(
        Effect.sleep(`${REPORTS_POLL_MS} millis`).pipe(
          Effect.andThen(Effect.sync(drain)),
        ),
      ),
    );
    return () => {
      stopped = true;
      debounced.cancel();
      closeSilent(watcher);
      Effect.runFork(Fiber.interrupt(poll));
    };
  }, []);
}

/**
 * One attention line when the manager session transitions into
 * `asking`. Seeds silently (a session already asking at TUI start is
 * steady state, and the footer `[m]` color carries it).
 */
export function useManagerAskingSignal(state: DerivedState | null): void {
  const prev = useRef<DerivedState | null | undefined>(undefined);
  useEffect(() => {
    const last = prev.current;
    prev.current = state;
    if (last === undefined) return; // seed
    if (state === "asking" && last !== "asking") {
      log.attention.warn("manager session is waiting on input (m to attach)");
    }
  }, [state]);
}
