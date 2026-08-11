/**
 * Turns observed wtstate changes into feed lines: asserted work
 * statuses, and section moves.
 *
 * Both fields are written by other processes (`wt status` / `wt
 * section` in an agent's shell) as often as by this one (the `u` and
 * `l` pickers), so the TUI can't emit at the call site — instead it
 * diffs the wtstate slugs map each time the query data changes (the
 * state-file watcher makes that push-based) and narrates what moved.
 * First observation seeds silently: replaying every persisted value as
 * "news" on startup would be noise, and the dots and grouping already
 * carry the steady state.
 *
 * Loudness follows what the change asks of the human. For statuses:
 * `needs-human` and `ready` are the two that mean "look at me" (err /
 * ok), `needs-testing` is a soft heads-up (warn), everything else is
 * one info line. For sections: a move made HERE is the human's own
 * keystroke and stays on the firehose, while a move observed from
 * another process is someone else rearranging the human's own
 * batching — that earns the attention feed, because a grouping change
 * they didn't make is exactly the kind of thing that must not be
 * discovered later.
 */
import { useEffect, useRef } from "react";

import { createLogger } from "../../core/logger.ts";
import { workStatusSuffix, type WorkStatusRecord } from "../../core/work-status.ts";
import type { WtState } from "../../core/wtstate.ts";
import {
  consumeSelfSectionWrite,
  consumeSelfStatusWrite,
} from "../../state/self-writes.ts";

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

export function useWtStateEvents(wtState: WtState | undefined): void {
  // slug → last-seen assertion timestamp (the identity of one
  // assertion). `null` = seen with no status. Undefined map = not yet
  // seeded.
  const seenRef = useRef<Map<string, string | null> | null>(null);
  // slug → last-seen section. Seeded and compared on the same pass;
  // kept in its own map so a status assertion and a section move on
  // the same slug each narrate independently.
  const seenSectionsRef = useRef<Map<string, string | null> | null>(null);
  useEffect(() => {
    if (!wtState) return;
    const next = new Map<string, string | null>();
    const nextSections = new Map<string, string | null>();
    for (const [slug, entry] of Object.entries(wtState.slugs)) {
      next.set(slug, entry.work?.at ?? null);
      nextSections.set(slug, entry.section);
    }
    const prev = seenRef.current;
    const prevSections = seenSectionsRef.current;
    seenRef.current = next;
    seenSectionsRef.current = nextSections;
    if (prevSections !== null) {
      for (const [slug, section] of nextSections) {
        // Same first-sighting rule as statuses: a slug that appears
        // after the seed (a worktree created since) arrives with its
        // grouping already set, which is placement, not a move.
        if (!prevSections.has(slug)) continue;
        if (prevSections.get(slug) === section) continue;
        const log = createLogger(slug);
        const text = section ? `moved to ${section}` : "moved to the inbox";
        // Ours (the `l` picker / Shift+J-K across a boundary): routine,
        // firehose only — the keystroke already acked. Anyone else's:
        // the human's board changed without them, so interrupt.
        if (consumeSelfSectionWrite(slug, section)) log.event.info(text);
        else log.attention.info(text);
      }
    }
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
      const opts = consumeSelfStatusWrite(slug, record.at) ? { toast: false } : undefined;
      if (record.state === "needs-human") log.attention.err(text, opts);
      else if (record.state === "ready") log.attention.ok(text, opts);
      else if (record.state === "needs-testing") log.attention.warn(text, opts);
      else log.attention.info(text, opts);
    }
  }, [wtState]);
}
