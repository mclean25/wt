import { describe, expect, test } from "bun:test";

import { currentSessionSummary, type Entry } from "./jsonl.ts";

const user: Entry = { type: "user", raw: { type: "user" } };
const assistant: Entry = { type: "assistant", raw: { type: "assistant" } };
const summary = (text: string): Entry => ({
  type: "summary",
  raw: { type: "summary", summary: text },
});

describe("currentSessionSummary", () => {
  test("summary at the tail end is current", () => {
    expect(currentSessionSummary([user, assistant, summary("wrapped up X")])).toBe(
      "wrapped up X",
    );
  });

  test("trailing non-message entries don't stale it", () => {
    const meta: Entry = { type: "queue-operation", raw: { type: "queue-operation" } };
    expect(currentSessionSummary([assistant, summary("done"), meta])).toBe("done");
  });

  test("a message after the summary makes it stale", () => {
    expect(currentSessionSummary([summary("old news"), user])).toBeNull();
    expect(currentSessionSummary([summary("old news"), assistant])).toBeNull();
  });

  test("no summary → null; malformed summary → null", () => {
    expect(currentSessionSummary([user, assistant])).toBeNull();
    expect(
      currentSessionSummary([{ type: "summary", raw: { type: "summary" } }]),
    ).toBeNull();
  });

  test("multi-line and ANSI-laced text collapses to one clean line", () => {
    expect(
      currentSessionSummary([summary("\n  [31mFixed the bug[0m  \nmore")]),
    ).toBe("Fixed the bug");
  });

  // The current wrap-up shape: system/away_summary (the "※ recap" line).
  const recap = (content: string): Entry => ({
    type: "system",
    raw: { type: "system", subtype: "away_summary", content },
  });

  test("an away_summary recap at the tail end is current, hint stripped", () => {
    expect(
      currentSessionSummary([
        user,
        assistant,
        recap("Goal was X; done. Next action is yours. (disable recaps in /config)"),
      ]),
    ).toBe("Goal was X; done. Next action is yours.");
  });

  test("other system subtypes neither surface nor stale a recap", () => {
    const turnDuration: Entry = {
      type: "system",
      raw: { type: "system", subtype: "turn_duration", durationMs: 5 },
    };
    expect(currentSessionSummary([assistant, recap("done"), turnDuration])).toBe("done");
    expect(currentSessionSummary([assistant, turnDuration])).toBeNull();
  });

  test("a message after the recap makes it stale", () => {
    expect(currentSessionSummary([recap("old news"), user])).toBeNull();
  });
});
