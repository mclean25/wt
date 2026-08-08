import { useSyncExternalStore } from "react";

import type { EventChannel, EventKind } from "../core/logger.ts";

export type WtEvent = {
  id: number;
  ts: number;
  level: EventKind;
  channel: EventChannel;
  source: string; // "app" | slug | arbitrary
  text: string;
};

type Listener = () => void;

const MAX_EVENTS = 500;
// Attention-worthy events keep their own (smaller) reserved buffer:
// they'd otherwise share the 500-slot ring with the firehose, where a
// chatty stretch (destroy logs, refresh churn) could silently evict a
// needs-you line before the user ever presses `"`.
const MAX_ATTENTION = 200;

/** What the attention FEED shows: the curated channel plus any error. */
export function isAttentionWorthy(e: Pick<WtEvent, "channel" | "level">): boolean {
  return e.channel === "attention" || e.level === "err";
}

class EventLog {
  private events: readonly WtEvent[] = [];
  private attention: readonly WtEvent[] = [];
  private listeners = new Set<Listener>();
  private nextId = 1;
  private notifyTimer: Timer | null = null;

  append(partial: Omit<WtEvent, "id" | "ts">): WtEvent {
    const full: WtEvent = { id: this.nextId++, ts: Date.now(), ...partial };
    const next = [...this.events, full];
    this.events = next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
    if (isAttentionWorthy(full)) {
      const att = [...this.attention, full];
      this.attention = att.length > MAX_ATTENTION ? att.slice(-MAX_ATTENTION) : att;
    }
    this.scheduleNotify();
    return full;
  }

  /**
   * Boot-time backfill from the daily log files — restores what the
   * pane showed before the last restart (see `activity-backfill.ts`).
   * Records carry their ORIGINAL timestamps and are placed before any
   * live events. Call once, before the logger sink starts appending.
   */
  seed(records: ReadonlyArray<Omit<WtEvent, "id">>): void {
    if (records.length === 0) return;
    const stamped = records.map((r) => ({ ...r, id: this.nextId++ }));
    this.events = [...stamped, ...this.events].slice(-MAX_EVENTS);
    const att = stamped.filter(isAttentionWorthy);
    this.attention = [...att, ...this.attention].slice(-MAX_ATTENTION);
    this.scheduleNotify();
  }

  // Arrow-bound so React's useSyncExternalStore gets stable refs.
  getSnapshot = (): readonly WtEvent[] => this.events;
  getAttentionSnapshot = (): readonly WtEvent[] => this.attention;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private scheduleNotify(): void {
    if (this.notifyTimer !== null) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.notify();
    }, 16);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

export const events = new EventLog();

export function useEvents(): readonly WtEvent[] {
  return useSyncExternalStore(events.subscribe, events.getSnapshot, events.getSnapshot);
}

export function useAttentionEvents(): readonly WtEvent[] {
  return useSyncExternalStore(
    events.subscribe,
    events.getAttentionSnapshot,
    events.getAttentionSnapshot,
  );
}
