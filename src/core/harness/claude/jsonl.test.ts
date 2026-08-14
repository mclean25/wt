import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  currentSessionSummary,
  promptLandedIn,
  promptNeedle,
  __testing,
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

  test("matches the exact body of a native cross-session message", () => {
    const entries: Entry[] = [
      {
        type: "user",
        raw: {
          type: "user",
          timestamp: at(200),
          message: { role: "user", content: "Another Claude session sent a message: wrapped" },
          origin: { kind: "peer", from: "external", body: "rebase onto main" },
        },
      },
    ];

    expect(promptLandedIn(entries, promptNeedle("rebase onto main"), T0)).toBe(true);
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
    // The submitted and recorded forms can differ in wrapping.
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

describe("the delivery-confirmation read window", () => {
  const { readTailCovering, TAIL_BYTES } = __testing;
  const T0 = Date.parse("2026-08-11T12:00:00.000Z");
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A transcript with the landed prompt buried under `filler` bytes of later output. */
  function transcript(fillerBytes: number): string {
    const dir = mkdtempSync(join(tmpdir(), "wt-jsonl-tail-"));
    dirs.push(dir);
    const path = join(dir, "session.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        timestamp: new Date(T0 + 500).toISOString(),
        message: { role: "user", content: "the landed prompt" },
      }),
    ];
    // Large tool results are what actually push it out on a real session.
    let written = 0;
    while (written < fillerBytes) {
      const line = JSON.stringify({
        type: "assistant",
        timestamp: new Date(T0 + 1_000).toISOString(),
        message: { role: "assistant", content: "y".repeat(4_000) },
      });
      lines.push(line);
      written += line.length + 1;
    }
    writeFileSync(path, `${lines.join("\n")}\n`);
    return path;
  }

  test("finds a prompt buried far deeper than the summary tail", () => {
    // The regression: on a live transcript the landed record fell out of
    // a 64 KiB tail 124ms after being written, so confirmation reported
    // "not in its transcript" and the sender resent a message that had
    // in fact arrived. 40x the old window, to be nowhere near the edge.
    const path = transcript(TAIL_BYTES * 40);
    const size = statSync(path).size;
    const entries = readTailCovering(path, size, T0);
    expect(promptLandedIn(entries, promptNeedle("the landed prompt"), T0)).toBe(true);
  });

  test("still finds it when nothing followed", () => {
    const path = transcript(0);
    const size = statSync(path).size;
    const entries = readTailCovering(path, size, T0);
    expect(promptLandedIn(entries, promptNeedle("the landed prompt"), T0)).toBe(true);
  });

  test("stops reading once the transcript predates the send", () => {
    // Bounded by TIME, not by reading the whole file: a send whose
    // window is already covered must not drag megabytes off disk.
    const path = transcript(TAIL_BYTES * 40);
    const size = statSync(path).size;
    const entries = readTailCovering(path, size, T0 + 900);
    expect(entries.length * 4_000).toBeLessThan(size);
  });
});
