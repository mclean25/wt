import { describe, expect, test } from "bun:test";

import {
  applyEditKey,
  emptyEdit,
  insertText,
  makeEdit,
  wordLeft,
  wordRight,
  type EditKey,
  type TextEdit,
} from "./text-edit.tsx";

/** Build an EditKey with defaults-off modifiers. */
function key(name: string, mods: Partial<EditKey> = {}): EditKey {
  return { name, ctrl: false, meta: false, option: false, ...mods };
}

function te(value: string, cursor: number): TextEdit {
  return { value, cursor };
}

describe("wordLeft / wordRight", () => {
  test("slug words: foo-bar-123 has three words", () => {
    const v = "foo-bar-123";
    // Rightward from 0: foo | bar | 123
    expect(wordRight(v, 0)).toBe(3);
    expect(wordRight(v, 3)).toBe(7);
    expect(wordRight(v, 7)).toBe(11);
    expect(wordRight(v, 11)).toBe(11);
    // Leftward from the end: 123 | bar | foo
    expect(wordLeft(v, 11)).toBe(8);
    expect(wordLeft(v, 8)).toBe(4);
    expect(wordLeft(v, 4)).toBe(0);
    expect(wordLeft(v, 0)).toBe(0);
  });

  test("sentence words: 'Foo Bar 123' has three words", () => {
    const v = "Foo Bar 123";
    expect(wordRight(v, 0)).toBe(3);
    expect(wordRight(v, 3)).toBe(7);
    expect(wordRight(v, 7)).toBe(11);
    expect(wordLeft(v, 11)).toBe(8);
    expect(wordLeft(v, 8)).toBe(4);
    expect(wordLeft(v, 4)).toBe(0);
  });

  test("underscores separate like hyphens and spaces", () => {
    const v = "foo_bar baz-qux";
    expect(wordRight(v, 0)).toBe(3); // foo
    expect(wordRight(v, 3)).toBe(7); // bar
    expect(wordRight(v, 7)).toBe(11); // baz
    expect(wordRight(v, 11)).toBe(15); // qux
    expect(wordLeft(v, 15)).toBe(12);
    expect(wordLeft(v, 12)).toBe(8);
    expect(wordLeft(v, 8)).toBe(4);
    expect(wordLeft(v, 4)).toBe(0);
  });

  test("mid-word jumps go to the word's edge, not past it", () => {
    const v = "foo-bar";
    expect(wordLeft(v, 5)).toBe(4); // inside "bar" → start of bar
    expect(wordRight(v, 1)).toBe(3); // inside "foo" → end of foo
  });

  test("runs of separators are skipped in one jump", () => {
    const v = "a  --__  b";
    expect(wordRight(v, 1)).toBe(10);
    expect(wordLeft(v, 9)).toBe(0);
  });

  test("other punctuation stays part of a word", () => {
    // Dots and slashes are word chars (branch names, urls).
    const v = "feat/x.y z";
    expect(wordRight(v, 0)).toBe(8);
    expect(wordLeft(v, 8)).toBe(0);
  });

  test("empty and boundary cursors are safe", () => {
    expect(wordLeft("", 0)).toBe(0);
    expect(wordRight("", 0)).toBe(0);
    expect(wordLeft("   ", 3)).toBe(0);
    expect(wordRight("   ", 0)).toBe(3);
  });
});

describe("insertText", () => {
  test("inserts at the cursor and advances it", () => {
    expect(insertText(te("ac", 1), "b")).toEqual(te("abc", 2));
  });
  test("appends at the end", () => {
    expect(insertText(makeEdit("ab"), "c")).toEqual(te("abc", 3));
  });
  test("multi-char paste lands whole", () => {
    expect(insertText(te("ad", 1), "bc")).toEqual(te("abcd", 3));
  });
  test("empty insert is identity", () => {
    const s = te("ab", 1);
    expect(insertText(s, "")).toBe(s);
  });
});

describe("applyEditKey — cursor movement", () => {
  test("plain left/right move one char, clamped", () => {
    expect(applyEditKey(key("left"), te("ab", 1))).toEqual(te("ab", 0));
    expect(applyEditKey(key("left"), te("ab", 0))).toEqual(te("ab", 0));
    expect(applyEditKey(key("right"), te("ab", 1))).toEqual(te("ab", 2));
    expect(applyEditKey(key("right"), te("ab", 2))).toEqual(te("ab", 2));
  });

  test("alt/option/ctrl + arrows word-jump", () => {
    const v = "foo-bar baz";
    expect(applyEditKey(key("left", { meta: true, option: true }), te(v, 11))).toEqual(
      te(v, 8),
    );
    expect(applyEditKey(key("left", { ctrl: true }), te(v, 8))).toEqual(te(v, 4));
    expect(applyEditKey(key("right", { option: true }), te(v, 0))).toEqual(te(v, 3));
    expect(applyEditKey(key("right", { ctrl: true }), te(v, 3))).toEqual(te(v, 7));
  });

  test("ESC-b / ESC-f (meta+b / meta+f) word-jump", () => {
    const v = "foo bar";
    expect(applyEditKey(key("b", { meta: true }), te(v, 7))).toEqual(te(v, 4));
    expect(applyEditKey(key("f", { meta: true }), te(v, 0))).toEqual(te(v, 3));
  });

  test("plain b/f are NOT movement (they're typing)", () => {
    expect(applyEditKey(key("b"), te("xy", 1))).toBeNull();
    expect(applyEditKey(key("f"), te("xy", 1))).toBeNull();
  });

  test("home/end and ctrl+a/ctrl+e", () => {
    expect(applyEditKey(key("home"), te("abc", 2))).toEqual(te("abc", 0));
    expect(applyEditKey(key("end"), te("abc", 1))).toEqual(te("abc", 3));
    expect(applyEditKey(key("a", { ctrl: true }), te("abc", 2))).toEqual(te("abc", 0));
    expect(applyEditKey(key("e", { ctrl: true }), te("abc", 1))).toEqual(te("abc", 3));
  });

  test("plain a/e are NOT movement", () => {
    expect(applyEditKey(key("a"), te("xy", 1))).toBeNull();
    expect(applyEditKey(key("e"), te("xy", 1))).toBeNull();
  });
});

describe("applyEditKey — deletion", () => {
  test("backspace deletes before the cursor", () => {
    expect(applyEditKey(key("backspace"), te("abc", 2))).toEqual(te("ac", 1));
  });
  test("backspace at 0 is a swallowed no-op", () => {
    const s = te("abc", 0);
    expect(applyEditKey(key("backspace"), s)).toBe(s);
  });
  test("alt+backspace deletes the word left of the cursor", () => {
    expect(applyEditKey(key("backspace", { meta: true }), te("foo-bar", 7))).toEqual(
      te("foo-", 4),
    );
    expect(
      applyEditKey(key("backspace", { option: true }), te("foo bar baz", 8)),
    ).toEqual(te("foo baz", 4));
  });
  test("delete removes the char at the cursor", () => {
    expect(applyEditKey(key("delete"), te("abc", 1))).toEqual(te("ac", 1));
  });
  test("delete at the end is a swallowed no-op", () => {
    const s = te("abc", 3);
    expect(applyEditKey(key("delete"), s)).toBe(s);
  });
  // The status picker's verify row pre-fills its prompt, and emptying
  // it is a meaningful assertion — backspacing there stops one key
  // short of exiting the prompt entirely.
  test("ctrl+u kills to the start of the line", () => {
    expect(applyEditKey(key("u", { ctrl: true }), te("foo bar", 4))).toEqual(
      te("bar", 0),
    );
    expect(applyEditKey(key("u", { ctrl: true }), te("foo bar", 7))).toEqual(te("", 0));
  });
  test("ctrl+k kills to the end of the line", () => {
    expect(applyEditKey(key("k", { ctrl: true }), te("foo bar", 4))).toEqual(
      te("foo ", 4),
    );
    expect(applyEditKey(key("k", { ctrl: true }), te("foo bar", 0))).toEqual(te("", 0));
  });
});

describe("applyEditKey — unhandled keys pass through", () => {
  test("return / escape / printable chars return null", () => {
    for (const k of [key("return"), key("escape"), key("x"), key("tab")]) {
      expect(applyEditKey(k, te("abc", 1))).toBeNull();
    }
  });
  test("ctrl+c is not the editor's", () => {
    expect(applyEditKey(key("c", { ctrl: true }), te("abc", 1))).toBeNull();
  });
});

describe("edit round trip", () => {
  test("move into the middle, insert, delete", () => {
    let s: TextEdit = emptyEdit;
    s = insertText(s, "foo-baz");
    s = applyEditKey(key("left", { meta: true }), s)!; // start of baz
    expect(s.cursor).toBe(4);
    s = insertText(s, "bar-");
    expect(s).toEqual(te("foo-bar-baz", 8));
    s = applyEditKey(key("backspace"), s)!;
    expect(s).toEqual(te("foo-barbaz", 7));
    s = applyEditKey(key("end"), s)!;
    expect(s.cursor).toBe(10);
  });
});
