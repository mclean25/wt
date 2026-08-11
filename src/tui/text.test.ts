import { describe, expect, test } from "bun:test";

import { wrapText } from "./text.ts";

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
