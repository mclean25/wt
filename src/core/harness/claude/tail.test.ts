import { describe, expect, test } from "bun:test";

import type { ToolStartMap } from "./events.ts";
import { parseEntry } from "./tail.ts";

const noStarts = (): ToolStartMap => new Map();
const ids = () => {
  let n = 1;
  return () => n++;
};

describe("parseEntry — context usage signal", () => {
  test("an assistant turn's usage surfaces tokens + model", () => {
    const line = JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-08T00:00:00.000Z",
      message: {
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "hi" }],
        usage: {
          input_tokens: 100,
          cache_read_input_tokens: 2_000,
          cache_creation_input_tokens: 50,
        },
      },
    });
    const out = parseEntry(line, noStarts(), ids());
    expect(out.usage).toEqual({ tokens: 2_150, model: "claude-sonnet-5" });
  });

  test("a sidechain (subagent) assistant turn carries no usage signal", () => {
    const line = JSON.stringify({
      type: "assistant",
      isSidechain: true,
      message: {
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 100 },
      },
    });
    const out = parseEntry(line, noStarts(), ids());
    expect(out.usage).toBeUndefined();
    expect("usage" in out).toBe(false);
  });

  test("compact_boundary explicitly resets usage to null (not merely absent)", () => {
    // Real shape observed in ~/.claude/projects/**/*.jsonl.
    const line = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      level: "info",
      compactMetadata: {
        trigger: "manual",
        preTokens: 156_499,
        postTokens: 10_129,
      },
      timestamp: "2026-08-06T17:02:01.078Z",
    });
    const out = parseEntry(line, noStarts(), ids());
    expect("usage" in out).toBe(true);
    expect(out.usage).toBeNull();
    // The info marker line still renders with the token delta.
    expect(out.append).toHaveLength(1);
    expect(out.append[0]?.text).toContain("compacted");
    expect(out.append[0]?.text).toContain("156.5k");
    expect(out.append[0]?.text).toContain("10.1k");
  });

  test("an auto compact_boundary annotates the trigger", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { trigger: "auto" },
    });
    const out = parseEntry(line, noStarts(), ids());
    expect(out.usage).toBeNull();
    expect(out.append[0]?.text).toContain("auto");
  });

  test("a line with no usage-affecting content carries no usage key", () => {
    const line = JSON.stringify({
      type: "user",
      message: { content: "just some text" },
    });
    const out = parseEntry(line, noStarts(), ids());
    expect("usage" in out).toBe(false);
  });

  test("the post-compaction summary blob is skipped, not surfaced as a reset", () => {
    const line = JSON.stringify({
      type: "user",
      isCompactSummary: true,
      message: { content: "This session is being continued from a previous conversation…" },
    });
    const out = parseEntry(line, noStarts(), ids());
    expect(out.append).toHaveLength(0);
    expect("usage" in out).toBe(false);
  });
});

describe("parseEntry — lenient parsing", () => {
  test("malformed JSON never throws", () => {
    expect(() => parseEntry("{not json", noStarts(), ids())).not.toThrow();
    const out = parseEntry("{not json", noStarts(), ids());
    expect(out.append).toHaveLength(0);
    expect(out.patch).toHaveLength(0);
    expect("usage" in out).toBe(false);
  });

  test("valid JSON that isn't an object never throws", () => {
    expect(() => parseEntry("42", noStarts(), ids())).not.toThrow();
    expect(() => parseEntry('"just a string"', noStarts(), ids())).not.toThrow();
    expect(() => parseEntry("null", noStarts(), ids())).not.toThrow();
  });

  test("an unrecognized record type is a silent no-op", () => {
    const line = JSON.stringify({ type: "queue-operation", foo: "bar" });
    const out = parseEntry(line, noStarts(), ids());
    expect(out.append).toHaveLength(0);
    expect(out.patch).toHaveLength(0);
    expect("usage" in out).toBe(false);
  });
});
