/**
 * Turns observed work-status changes into attention-feed lines.
 *
 * The status writers are other processes (`wt status` in an agent's
 * shell) as often as this one (`u` picker), so the TUI can't emit at
 * the call site — instead it diffs the wtstate slugs map each time the
 * query data changes (the state-file watcher makes that push-based)
 * and narrates the transitions. First observation seeds silently:
 * replaying every persisted status as "news" on startup would be
 * noise, and the dots already carry the steady state.
 *
 * Loudness follows what the transition asks of the human:
 * `needs-human` and `ready` are the two that mean "look at me" (err /
 * ok), `needs-testing` is a soft heads-up (warn), everything else is
 * one info line.
 */
import { useEffect, useRef } from "react";

import { createLogger } from "../../core/logger.ts";
import { workStatusSuffix, type WorkStatusRecord } from "../../core/work-status.ts";
import type { WtState } from "../../core/wtstate.ts";

/**
 * Slugs whose next observed status change was written by THIS process
 * (the `u` picker) — the picker already toasted its own keystroke ack,
 * so the narration below logs the attention line with the toast
 * suppressed instead of double-flashing the same change. Marks expire
 * quickly: a stale one must never mute a real external transition.
 */
const selfWrites = new Map<string, number>();
const SELF_WRITE_TTL_MS = 5000;

export function markSelfStatusWrite(slug: string): void {
  selfWrites.set(slug, Date.now());
}

function consumeSelfWrite(slug: string): boolean {
  const at = selfWrites.get(slug);
  if (at === undefined) return false;
  selfWrites.delete(slug);
  return Date.now() - at < SELF_WRITE_TTL_MS;
}

function describe(record: WorkStatusRecord): string {
  const suffix = workStatusSuffix(record);
  switch (record.state) {
    case "needs-human":
      return `needs you${suffix}`;
    case "ready":
      return `ready to merge${suffix}`;
    case "needs-testing":
      return `needs testing${suffix}`;
    default:
      return `→ ${record.state}${suffix}`;
  }
}

export function useWorkStatusEvents(wtState: WtState | undefined): void {
  // slug → last-seen assertion timestamp (the identity of one
  // assertion). `null` = seen with no status. Undefined map = not yet
  // seeded.
  const seenRef = useRef<Map<string, string | null> | null>(null);
  useEffect(() => {
    if (!wtState) return;
    const next = new Map<string, string | null>();
    for (const [slug, entry] of Object.entries(wtState.slugs)) {
      next.set(slug, entry.work?.at ?? null);
    }
    const prev = seenRef.current;
    seenRef.current = next;
    if (prev === null) return; // seed silently
    for (const [slug, entry] of Object.entries(wtState.slugs)) {
      const record = entry.work;
      if (!record) continue;
      if (prev.get(slug) === record.at) continue;
      // A slug appearing for the FIRST time after the initial seed —
      // e.g. a fresh worktree whose creator already asserted (/triage
      // seeding `todo`), or a slug-state record rebuilt after destroy —
      // is persisted history, not a transition; seed it silently like
      // the startup pass does.
      if (!prev.has(slug)) continue;
      const log = createLogger(slug);
      const text = describe(record);
      const opts = consumeSelfWrite(slug) ? { toast: false } : undefined;
      if (record.state === "needs-human") log.attention.err(text, opts);
      else if (record.state === "ready") log.attention.ok(text, opts);
      else if (record.state === "needs-testing") log.attention.warn(text, opts);
      else log.attention.info(text, opts);
    }
  }, [wtState]);
}
