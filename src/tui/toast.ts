/**
 * Toast store — the footer's transient one-liner. Single slot,
 * latest-wins (a toast is an acknowledgment, not a queue; anything
 * that must not be missed belongs in the pane feeds, which are the
 * record).
 *
 * Two producer classes, per the contract in AGENTS.md:
 *  - Keystroke feedback: flows call `ctx.toast(...)` (a thin wrapper
 *    over `showToast`). Ephemeral only, never logged — it's the
 *    response to something the user just did.
 *  - Background events: logger emits carrying `{ toast: true }` land
 *    here through the sink `attachLoggerToasts` registers. Those are
 *    always ALSO a pane line, so a missed toast is recoverable.
 */
import { useSyncExternalStore } from "react";
import { Duration, Effect, Fiber } from "effect";

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
  private expiryFiber: Fiber.RuntimeFiber<void, never> | null = null;
  private listeners = new Set<Listener>();
  private nextId = 1;
  private accepting = true;

  show(text: string, color: string, ms: number): void {
    if (!this.accepting) return;
    if (this.expiryFiber !== null) Effect.runSync(Fiber.interruptFork(this.expiryFiber));
    const toast = { id: this.nextId++, text, color };
    this.current = toast;
    this.expiryFiber = Effect.runFork(
      Effect.sleep(Duration.millis(ms)).pipe(
        Effect.andThen(Effect.sync(() => {
          if (this.current?.id !== toast.id) return;
          this.expiryFiber = null;
          this.current = null;
          this.notify();
        })),
      ),
    );
    this.notify();
  }

  clear(): void {
    if (this.expiryFiber !== null) Effect.runSync(Fiber.interruptFork(this.expiryFiber));
    this.expiryFiber = null;
    this.current = null;
    this.notify();
  }

  attach(): void {
    this.accepting = true;
  }

  detach(): void {
    this.accepting = false;
    this.clear();
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
 * Gated by `attachLoggerToasts`'s lifecycle after the first detach: a
 * promise resolving during teardown cannot re-arm an expiry fiber or
 * publish into a retired TUI. A later attach enables the store again.
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
  store.attach();
  setToastSink((t) => {
    store.show(t.text, toastColor(t.level), toastDuration(t.level));
  });
  return () => {
    setToastSink(null);
    store.detach();
  };
}
