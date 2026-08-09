/**
 * Shared keyboard core for every list-style picker modal — the single
 * implementation of the modal UX rules (docs/architecture.md#modal-ux-
 * rules): `j`/`k`/arrows move, digits `1`-`9` quick-pick, `Enter` (plus
 * the picker's own trigger key) confirms the highlight, per-item letter
 * chords fire directly, and `Esc`/`q`/`Ctrl+C` cancel.
 *
 * Handlers keep their picker-specific affordances (text-input modes,
 * preview-on-move, multi-select toggles) as pre-checks and delegate the
 * rest here, so the base behavior can't drift picker to picker. Always
 * returns true — an open modal swallows every key.
 */
import type { KeyEvent } from "@opentui/core";

import { isPlainLetter } from "../app-helpers.ts";

export type ListPickerSpec = {
  /** Number of navigable rows. */
  count: number;
  /** Current highlight index (clamped here against `count`). */
  index: number;
  onMove: (next: number) => void;
  /** Confirm the row at `index`. Callers guard missing items. */
  onCommit: (index: number) => void;
  onCancel: () => void;
  /**
   * Extra confirm triggers besides Enter — by convention the key that
   * opened the picker (`b`, `u`, `l`, …), or a non-letter sequence
   * (`;`, `'`). Letters are modifier-checked via `isPlainLetter`.
   */
  confirm?: readonly string[];
  /**
   * Per-item letter chords (`x` clear, `n` new-section, …). Checked
   * before the confirm keys; receive the current highlight index.
   */
  chords?: Readonly<Record<string, (index: number) => void>>;
  /**
   * Digit quick-pick. Default: `n` commits item `n-1` when present.
   * Pass a function to remap (e.g. count only selectable rows), or
   * `false` for pickers where digits don't apply.
   */
  digits?: false | ((n: number) => void);
};

function matchesTrigger(k: KeyEvent, trigger: string): boolean {
  if (/^[a-z]$/.test(trigger)) return isPlainLetter(k, trigger);
  return k.sequence === trigger && !k.ctrl && !k.meta;
}

export function handleListPickerKey(k: KeyEvent, spec: ListPickerSpec): boolean {
  const max = Math.max(0, spec.count - 1);
  const idx = Math.min(Math.max(0, spec.index), max);
  if (k.name === "j" || k.name === "down") {
    spec.onMove(Math.min(idx + 1, max));
    return true;
  }
  if (k.name === "k" || k.name === "up") {
    spec.onMove(Math.max(idx - 1, 0));
    return true;
  }
  if (spec.digits !== false && k.sequence && /^[1-9]$/.test(k.sequence)) {
    const n = parseInt(k.sequence, 10);
    if (typeof spec.digits === "function") spec.digits(n);
    else if (n - 1 < spec.count) spec.onCommit(n - 1);
    return true;
  }
  if (spec.chords) {
    for (const [letter, fire] of Object.entries(spec.chords)) {
      if (isPlainLetter(k, letter)) {
        fire(idx);
        return true;
      }
    }
  }
  if (k.name === "return" || (spec.confirm ?? []).some((t) => matchesTrigger(k, t))) {
    spec.onCommit(idx);
    return true;
  }
  if (k.name === "escape" || k.sequence === "q" || (k.ctrl && k.name === "c")) {
    spec.onCancel();
    return true;
  }
  return true;
}
