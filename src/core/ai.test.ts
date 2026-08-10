import { describe, expect, test } from "bun:test";

import { extractResponsesText, isStackTitleMetaOnly } from "./ai.ts";

describe("isStackTitleMetaOnly", () => {
  test("rejects a bare leaked meta word", () => {
    // The eng-5202 incident: the model handed back its own vocabulary.
    expect(isStackTitleMetaOnly("TUI")).toBe(true);
  });

  test("rejects a title built entirely from packaging words", () => {
    expect(isStackTitleMetaOnly("Header Stack Section")).toBe(true);
    expect(isStackTitleMetaOnly("Developer Tool Group")).toBe(true);
  });

  test("keeps a real title, even one that reuses a meta word as domain content", () => {
    // "header" is on the list, but "Stamp" anchors it — never strip to "Stamp".
    expect(isStackTitleMetaOnly("Header Stamp")).toBe(false);
    expect(isStackTitleMetaOnly("Atomic builder claim")).toBe(false);
    expect(isStackTitleMetaOnly("Orchestration Stack")).toBe(false);
  });

  test("empty input is not meta-only (nothing to reject)", () => {
    expect(isStackTitleMetaOnly("")).toBe(false);
    expect(isStackTitleMetaOnly("   ")).toBe(false);
  });

  test("is punctuation- and case-insensitive", () => {
    expect(isStackTitleMetaOnly("stack.")).toBe(true);
    expect(isStackTitleMetaOnly("BRANCHES")).toBe(true);
  });
});

describe("extractResponsesText", () => {
  test("concatenates output_text parts and skips reasoning items", () => {
    expect(
      extractResponsesText({
        output: [
          { type: "reasoning" },
          {
            type: "message",
            content: [
              { type: "output_text", text: "TITLE: Fix the thing\n" },
              { type: "output_text", text: "DESCRIPTION: Done." },
            ],
          },
        ],
      }),
    ).toBe("TITLE: Fix the thing\nDESCRIPTION: Done.");
  });

  test("surfaces the API error message", () => {
    expect(() =>
      extractResponsesText({ error: { message: "invalid model" } }),
    ).toThrow("AI endpoint: invalid model");
  });

  test("empty incomplete response points at the reasoning budget", () => {
    expect(() =>
      extractResponsesText({
        output: [{ type: "reasoning" }],
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      }),
    ).toThrow(/incomplete \(max_output_tokens\)/);
  });

  test("empty complete response is a plain no-content error", () => {
    expect(() => extractResponsesText({ output: [] })).toThrow(
      "AI endpoint returned no content",
    );
  });
});
