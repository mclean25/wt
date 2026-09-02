import { useSyncExternalStore } from "react";
import { Duration, Effect, Fiber } from "effect";

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
  private notifyFiber: Fiber.Fiber<void, never> | null = null;
  private accepting = true;
  /**
   * Attention "seen" watermark (epoch ms; 0 = never marked). Events at
   * or before it render dim below a `── seen` rule in the attention
   * feed — display state only, nothing is evicted. Seeded at boot from
   * wtstate (`runtime.tsx`), advanced by the `x` key; the persisted
   * copy is `WtState.attentionSeenTs`.
   */
  private seenTs = 0;

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

  /** Advance the seen watermark (never regresses — see setAttentionSeen). */
  markSeen(ts: number): void {
    if (ts <= this.seenTs) return;
    this.seenTs = ts;
    this.scheduleNotify();
  }

  // Arrow-bound so React's useSyncExternalStore gets stable refs.
  getSnapshot = (): readonly WtEvent[] => this.events;
  getAttentionSnapshot = (): readonly WtEvent[] => this.attention;
  getSeenTs = (): number => this.seenTs;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /**
   * Enable/disable pairing mirroring `ToastStore`'s: `runtime.tsx`
   * detaches at TUI shutdown so the debounce fiber below is
   * interrupted instead of left to run past a torn-down render tree,
   * and re-attaches (idempotently — the class already starts
   * accepting) on the next boot.
   */
  attach(): void {
    this.accepting = true;
  }

  detach(): void {
    this.accepting = false;
    if (this.notifyFiber !== null) {
      Effect.runSync(Fiber.interrupt(this.notifyFiber));
      this.notifyFiber = null;
    }
  }

  private scheduleNotify(): void {
    if (!this.accepting || this.notifyFiber !== null) return;
    this.notifyFiber = Effect.runFork(
      Effect.sleep(Duration.millis(16)).pipe(
        Effect.andThen(Effect.sync(() => {
          this.notifyFiber = null;
          this.notify();
        })),
      ),
    );
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

export function useAttentionSeenTs(): number {
  return useSyncExternalStore(events.subscribe, events.getSeenTs, events.getSeenTs);
}
