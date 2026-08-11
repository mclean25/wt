import { describe, expect, test } from "bun:test";

import {
  currentSessionSummary,
  promptLandedIn,
  promptNeedle,
  type Entry,
} from "./jsonl.ts";

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

describe("promptLandedIn", () => {
  const T0 = Date.parse("2026-08-11T12:00:00.000Z");
  const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
  const userEntry = (text: string, offsetMs: number): Entry => ({
    type: "user",
    raw: { type: "user", timestamp: at(offsetMs), message: { role: "user", content: text } },
  });

  test("finds the prompt in a user entry written after the send", () => {
    const entries = [userEntry("go fix the flaky test please", 500)];
    expect(promptLandedIn(entries, promptNeedle("go fix the flaky test please"), T0)).toBe(true);
  });

  test("ignores an identical prompt from BEFORE the send", () => {
    // The manager fans the same text out repeatedly; matching an older
    // copy would confirm a delivery that never happened.
    const entries = [userEntry("status check", -60_000)];
    expect(promptLandedIn(entries, promptNeedle("status check"), T0)).toBe(false);
  });

  test("a queued prompt counts as delivered", () => {
    const entries: Entry[] = [
      {
        type: "queue-operation",
        raw: { type: "queue-operation", operation: "enqueue", timestamp: at(200), content: "run the suite" },
      },
    ];
    expect(promptLandedIn(entries, promptNeedle("run the suite"), T0)).toBe(true);
  });

  test("a dequeue carries no prompt", () => {
    const entries: Entry[] = [
      {
        type: "queue-operation",
        raw: { type: "queue-operation", operation: "dequeue", timestamp: at(200), content: "run the suite" },
      },
    ];
    expect(promptLandedIn(entries, promptNeedle("run the suite"), T0)).toBe(false);
  });

  test("matches through reflowed whitespace", () => {
    // What tmux pasted and what claude recorded differ in wrapping.
    const entries = [userEntry("please   read\nthe   docs first", 100)];
    expect(promptLandedIn(entries, promptNeedle("please read the docs first"), T0)).toBe(true);
  });

  test("reads text blocks out of array content", () => {
    const entries: Entry[] = [
      {
        type: "user",
        raw: {
          type: "user",
          timestamp: at(100),
          message: { role: "user", content: [{ type: "text", text: "ship it now" }] },
        },
      },
    ];
    expect(promptLandedIn(entries, promptNeedle("ship it now"), T0)).toBe(true);
  });

  test("a tool_result user entry is not a prompt", () => {
    const entries: Entry[] = [
      {
        type: "user",
        raw: {
          type: "user",
          timestamp: at(100),
          message: { content: [{ type: "tool_result", content: "ship it now" }] },
        },
      },
    ];
    expect(promptLandedIn(entries, promptNeedle("ship it now"), T0)).toBe(false);
  });

  test("a different prompt in the window does not count", () => {
    const entries = [userEntry("something else entirely", 100)];
    expect(promptLandedIn(entries, promptNeedle("go fix the flaky test please"), T0)).toBe(false);
  });

  test("empty text never matches", () => {
    expect(promptLandedIn([userEntry("anything", 100)], promptNeedle("   "), T0)).toBe(false);
  });
});
