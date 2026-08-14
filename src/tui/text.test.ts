import { describe, expect, test } from "bun:test";

import { clipLines, wrapText } from "./text.ts";

describe("wrapText", () => {
  test("wraps on word boundaries within the budget", () => {
    expect(wrapText("the quick brown fox jumps", 10)).toEqual([
      "the quick",
      "brown fox",
      "jumps",
    ]);
  });

  test("keeps the last character instead of spending a blank line on it", () => {
    // The native wrapper dropped a tail that landed exactly at the edge
    // and emitted an empty line in its place — the phantom row under
    // every long status note.
    const lines = wrapText("aaaa bbbb.", 9);
    expect(lines).toEqual(["aaaa", "bbbb."]);
    expect(lines.some((l) => l === "")).toBe(false);
  });

  test("collapses whitespace runs so continuation lines never start indented", () => {
    const lines = wrapText("alpha  beta\tgamma   delta", 11);
    expect(lines).toEqual(["alpha beta", "gamma delta"]);
    for (const l of lines) expect(l).toBe(l.trim());
  });

  test("a narrower first line leaves room for a fixed prefix", () => {
    expect(wrapText("alpha beta gamma", 11, 5)).toEqual(["alpha", "beta gamma"]);
  });

  test("hard-breaks a word wider than the budget", () => {
    expect(wrapText("https://example.com/very/long/path", 12)).toEqual([
      "https://exam",
      "ple.com/very",
      "/long/path",
    ]);
  });

  test("an over-long word on a partly filled line moves down first", () => {
    expect(wrapText("hi supercalifragilistic", 10)).toEqual([
      "hi",
      "supercalif",
      "ragilistic",
    ]);
  });

  test("explicit newlines are hard breaks and blank lines survive", () => {
    expect(wrapText("one\n\ntwo three", 9)).toEqual(["one", "", "two three"]);
  });

  test("counts terminal cells, not code units", () => {
    // Each CJK glyph is 2 cells, so 4 fill an 8-cell line.
    expect(wrapText("日本語文字体系", 8)).toEqual(["日本語文", "字体系"]);
  });

  test("degenerate widths return nothing rather than looping", () => {
    expect(wrapText("anything", 0)).toEqual([]);
    expect(wrapText("anything", 10, 0)).toEqual([]);
  });
});

describe("clipLines", () => {
  test("a note that fits is returned whole and unmarked", () => {
    // The mark has to mean something, so it can't appear when nothing
    // was dropped.
    expect(clipLines("the quick brown fox", 10, 3)).toEqual(["the quick", "brown fox"]);
  });

  test("a clipped note says so on its last line", () => {
    // Without this the note reads as complete — the one misreading the
    // block must not cause, since it is what the human is being asked.
    const lines = clipLines("the quick brown fox jumps over the lazy dog", 10, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]?.endsWith("...")).toBe(true);
  });

  test("the mark never pushes a line past its width", () => {
    // A last line already filling the budget gives up its tail rather
    // than overflowing the pane it was measured for.
    const lines = clipLines("aaaaaaaaaa bbbbbbbbbb cccccccccc", 10, 2);
    for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(10);
    expect(lines[1]?.endsWith("...")).toBe(true);
  });

  test("an exact fit is not marked off-by-one", () => {
    expect(clipLines("the quick brown fox", 10, 2)).toEqual(["the quick", "brown fox"]);
  });
});
