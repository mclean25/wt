/**
 * Toast store — the footer's transient one-liner. Single slot,
 * latest-wins (a toast is an acknowledgment, not a queue; anything
 * that must not be missed belongs in the pane feeds, which are the
 * record).
 *
 * Two producer classes, per the contract in CLAUDE.md:
 *  - Keystroke feedback: flows call `ctx.toast(...)` (a thin wrapper
 *    over `showToast`). Ephemeral only, never logged — it's the
 *    response to something the user just did.
 *  - Background events: logger emits carrying `{ toast: true }` land
 *    here through the sink `attachLoggerToasts` registers. Those are
 *    always ALSO a pane line, so a missed toast is recoverable.
 */
import { useSyncExternalStore } from "react";

import { setToastSink, type EventKind } from "../core/logger.ts";

import { theme } from "./theme.ts";

export type Toast = {
  id: number;
  text: string;
  color: string;
};

type Listener = () => void;

class ToastStore {
  private current: Toast | null = null;
  private timer: Timer | null = null;
  private listeners = new Set<Listener>();
  private nextId = 1;

  show(text: string, color: string, ms: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.current = { id: this.nextId++, text, color };
    this.timer = setTimeout(() => {
      this.timer = null;
      this.current = null;
      this.notify();
    }, ms);
    this.notify();
  }

  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.current = null;
    this.notify();
  }

  getSnapshot = (): Toast | null => this.current;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private notify(): void {
    for (const l of this.listeners) l();
  }
}

const store = new ToastStore();

/**
 * Flash a toast in the footer. Latest call wins; `ms` bounds its life.
 *
 * Not gated by `attachLoggerToasts`'s lifecycle: a late promise
 * resolving after teardown can still arm one timer here. Inert today —
 * main.ts hits `process.exit` right after the TUI resolves — but if
 * shutdown ever becomes graceful/multi-phase, this needs a disposed
 * guard to avoid keeping the process alive.
 */
export function showToast(text: string, color: string = theme.ok, ms = 2500): void {
  store.show(text, color, ms);
}

/** Snapshot/subscribe pair — exported for tests; UI code uses `useToast`. */
export const getToast = store.getSnapshot;
export const subscribeToast = store.subscribe;

export function useToast(): Toast | null {
  return useSyncExternalStore(subscribeToast, getToast, getToast);
}

/** Level → footer color for logger-driven toasts. */
export function toastColor(level: EventKind): string {
  switch (level) {
    case "ok":
      return theme.ok;
    case "warn":
      return theme.warn;
    case "err":
      return theme.err;
    case "dim":
      return theme.fgDim;
    case "info":
      return theme.info;
  }
}

/** Level → display time. Errors linger; acks flash. */
export function toastDuration(level: EventKind): number {
  switch (level) {
    case "err":
      return 5000;
    case "warn":
      return 3500;
    default:
      return 2500;
  }
}

/**
 * Register the logger→toast bridge. Call once at TUI boot (next to
 * `setEventSink`); returns the detach for shutdown. CLI runs never
 * call this, so `{ toast: true }` emits there are file/pane-only.
 */
export function attachLoggerToasts(): () => void {
  setToastSink((t) => {
    store.show(t.text, toastColor(t.level), toastDuration(t.level));
  });
  return () => {
    setToastSink(null);
    store.clear();
  };
}
