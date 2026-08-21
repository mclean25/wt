/**
 * Shared single-line text-editing helper for every footer/modal text
 * input (new-worktree prompt, section rename/create, status notes,
 * custom prompts, action args, session names, help search). State is
 * `{ value, cursor }`; the functions are pure so they unit-test without
 * a terminal.
 *
 * Division of labor with call sites: `applyEditKey` owns cursor
 * movement and deletion (arrows, home/end, ctrl+a/e, word jumps,
 * backspace/delete, ctrl+u/ctrl+k line kills); insertion goes through `insertText` AFTER the
 * site's own printable filter (`printableText`, `printableMultiline`,
 * or the session-name charset) — the filters differ per input, the
 * editing does not. Submit/cancel/empty-backspace semantics stay at
 * the sites: check those keys BEFORE `applyEditKey`, which treats a
 * backspace on a non-empty value as its own.
 *
 * Key encodings handled (verified against OpenTUI's `parseKeypress`):
 * plain arrows; alt/option+arrow (`CSI 1;3D` → `meta`+`option`) and
 * ctrl+arrow (`CSI 1;5D` → `ctrl`) as word jumps; ESC b / ESC f
 * (`meta` + name `b`/`f`, the readline forms macOS terminals send for
 * option+arrow); home/end in their CSI/SS3/`~` forms (all parse to
 * name `home`/`end`); ctrl+a/ctrl+e; ctrl+u/ctrl+k; backspace (0x7f
 * and 0x08);
 * alt+backspace as word-delete; forward delete (`CSI 3~`).
 */
import type { KeyEvent } from "@opentui/core";
import type { ReactNode } from "react";

import { theme } from "./theme.ts";

export type TextEdit = {
  readonly value: string;
  readonly cursor: number;
};

/** Fresh empty input, cursor at 0. */
export const emptyEdit: TextEdit = { value: "", cursor: 0 };

/** Wrap an existing string, cursor at the end (prefill flows). */
export function makeEdit(value: string): TextEdit {
  return { value, cursor: value.length };
}

/** Insert `text` at the cursor (typing and paste both land here). */
export function insertText(te: TextEdit, text: string): TextEdit {
  if (!text) return te;
  return {
    value: te.value.slice(0, te.cursor) + text + te.value.slice(te.cursor),
    cursor: te.cursor + text.length,
  };
}

/**
 * Word separators are slug-aware AND sentence-aware: `-`, `_`, and
 * whitespace all split words, so `foo-bar-123` and "Foo Bar 123" each
 * have three words. Everything else is a word char.
 */
function isSep(ch: string): boolean {
  return ch === "-" || ch === "_" || /\s/.test(ch);
}

/** Index of the start of the word left of `cursor` (readline `b`). */
export function wordLeft(value: string, cursor: number): number {
  let i = cursor;
  while (i > 0 && isSep(value[i - 1]!)) i--;
  while (i > 0 && !isSep(value[i - 1]!)) i--;
  return i;
}

/** Index of the end of the word right of `cursor` (readline `f`). */
export function wordRight(value: string, cursor: number): number {
  let i = cursor;
  const n = value.length;
  while (i < n && isSep(value[i]!)) i++;
  while (i < n && !isSep(value[i]!)) i++;
  return i;
}

/**
 * The subset of `KeyEvent` the editor reads — structural, so tests
 * (and any synthetic dispatch) can pass plain objects.
 */
export type EditKey = Pick<KeyEvent, "name" | "ctrl" | "meta" | "option">;

function withCursor(te: TextEdit, cursor: number): TextEdit {
  return cursor === te.cursor ? te : { value: te.value, cursor };
}

/**
 * Apply one editing keystroke. Returns the next state when the key is
 * an editing key (possibly unchanged — still swallow it), or `null`
 * when the key isn't the editor's to handle (submit/cancel/printable
 * text stay with the call site).
 */
export function applyEditKey(k: EditKey, te: TextEdit): TextEdit | null {
  const { value, cursor } = te;
  const word = k.ctrl || k.meta || k.option;
  if (k.name === "left") {
    return withCursor(te, word ? wordLeft(value, cursor) : Math.max(0, cursor - 1));
  }
  if (k.name === "right") {
    return withCursor(
      te,
      word ? wordRight(value, cursor) : Math.min(value.length, cursor + 1),
    );
  }
  // ESC b / ESC f — the readline word jumps (also what iTerm/Terminal
  // send for option+arrow in their default "Esc+" configurations).
  if ((k.meta || k.option) && !k.ctrl && (k.name === "b" || k.name === "f")) {
    return withCursor(
      te,
      k.name === "b" ? wordLeft(value, cursor) : wordRight(value, cursor),
    );
  }
  // Readline's line kills. `ctrl+u` is the one that matters here: the
  // status picker's verify row pre-fills its input with the steps the
  // row already owes, and clearing that box is how a human takes the
  // obligation back off a branch — reachable by backspace alone only if
  // you stop on exactly the right keystroke, since one more exits the
  // prompt entirely (the backspace-on-empty convention).
  if (k.ctrl && k.name === "u") return { value: value.slice(cursor), cursor: 0 };
  if (k.ctrl && k.name === "k") return { value: value.slice(0, cursor), cursor };
  if (k.name === "home" || (k.ctrl && k.name === "a")) return withCursor(te, 0);
  if (k.name === "end" || (k.ctrl && k.name === "e")) {
    return withCursor(te, value.length);
  }
  if (k.name === "backspace") {
    // alt/option+backspace deletes the word left of the cursor.
    const start = k.meta || k.option ? wordLeft(value, cursor) : cursor - 1;
    if (cursor === 0) return te;
    return {
      value: value.slice(0, Math.max(0, start)) + value.slice(cursor),
      cursor: Math.max(0, start),
    };
  }
  if (k.name === "delete") {
    if (cursor >= value.length) return te;
    return { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor };
  }
  return null;
}

/**
 * Render the value with the block cursor at its position: text before
 * + cursor + text after, as spans for an enclosing `<text>` node.
 * `cursorChar` lets a site keep its existing cursor glyph (`█` default,
 * the help search's `▌`, the section input's `▎`).
 */
export function editSpans(
  te: TextEdit,
  fg: string,
  cursorChar = "█",
): ReactNode {
  const before = te.value.slice(0, te.cursor);
  const after = te.value.slice(te.cursor);
  return (
    <>
      {before ? <span fg={fg}>{before}</span> : null}
      <span fg={theme.accent}>{cursorChar}</span>
      {after ? <span fg={fg}>{after}</span> : null}
    </>
  );
}
