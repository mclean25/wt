import { describe, expect, test } from "bun:test";

import {
  classifyCheckRuns,
  emptyUpdateMemory,
  parseUpdateMemory,
  selectOffer,
  startupCheckGate,
  UPDATE_CHECK_INTERVAL_MS,
} from "./update.ts";

const NOW = 1_800_000_000_000;
const CLEAN = { dirty: false, ahead: 0, upstream: "origin/main" };

describe("startupCheckGate", () => {
  test("local divergence always wins — the human is driving this clone", () => {
    expect(startupCheckGate({ ...CLEAN, dirty: true }, emptyUpdateMemory(), NOW)).toBe("local-changes");
    expect(startupCheckGate({ ...CLEAN, ahead: 2 }, emptyUpdateMemory(), NOW)).toBe("local-changes");
    expect(startupCheckGate({ ...CLEAN, upstream: null }, emptyUpdateMemory(), NOW)).toBe("local-changes");
    // …even when the rate limit would also apply.
    expect(
      startupCheckGate({ ...CLEAN, dirty: true }, { ...emptyUpdateMemory(), lastCheckAt: NOW - 1000 }, NOW),
    ).toBe("local-changes");
  });

  test("rate limit: one check per day, first-ever check runs", () => {
    expect(startupCheckGate(CLEAN, emptyUpdateMemory(), NOW)).toBe("run");
    expect(
      startupCheckGate(CLEAN, { ...emptyUpdateMemory(), lastCheckAt: NOW - 60_000 }, NOW),
    ).toBe("rate-limited");
    expect(
      startupCheckGate(
        CLEAN,
        { ...emptyUpdateMemory(), lastCheckAt: NOW - UPDATE_CHECK_INTERVAL_MS - 1 },
        NOW,
      ),
    ).toBe("run");
  });

  test("a future lastCheckAt (clock rollback) can't wedge the check forever", () => {
    expect(
      startupCheckGate(CLEAN, { ...emptyUpdateMemory(), lastCheckAt: NOW + UPDATE_CHECK_INTERVAL_MS }, NOW),
    ).toBe("run");
  });
});

describe("selectOffer", () => {
  test("nothing behind → up-to-date, regardless of gate or declines", () => {
    expect(selectOffer({ behind: 0, target: "aaa", declinedSha: "aaa" }).action).toBe("up-to-date");
  });

  test("behind but no eligible target → none-eligible (gate held everything back)", () => {
    expect(selectOffer({ behind: 3, target: null, declinedSha: null }).action).toBe("none-eligible");
  });

  test("a decline silences exactly that target, not the next one", () => {
    expect(selectOffer({ behind: 3, target: "aaa", declinedSha: "aaa" }).action).toBe("declined");
    const next = selectOffer({ behind: 4, target: "bbb", declinedSha: "aaa" });
    expect(next).toEqual({ action: "offer", target: "bbb" });
    expect(selectOffer({ behind: 3, target: "aaa", declinedSha: null }).action).toBe("offer");
  });
});

describe("classifyCheckRuns", () => {
  const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });

  test("only gate-named runs are consulted; missing runs fall open as unknown", () => {
    expect(classifyCheckRuns({ check_runs: [] })).toBe("unknown");
    expect(classifyCheckRuns({ check_runs: [run("discord-digest", "completed", "failure")] })).toBe("unknown");
    expect(classifyCheckRuns(null)).toBe("unknown");
    expect(classifyCheckRuns({ nope: 1 })).toBe("unknown");
  });

  test("gate runs decide: green / red / pending", () => {
    expect(classifyCheckRuns({ check_runs: [run("ci", "completed", "success")] })).toBe("green");
    expect(classifyCheckRuns({ check_runs: [run("typecheck", "completed", "success")] })).toBe("green");
    expect(classifyCheckRuns({ check_runs: [run("ci", "completed", "failure")] })).toBe("red");
    expect(classifyCheckRuns({ check_runs: [run("ci", "in_progress", null)] })).toBe("pending");
    // A failing unrelated run can't veto a green gate run.
    expect(
      classifyCheckRuns({
        check_runs: [run("ci", "completed", "success"), run("discord-digest", "completed", "failure")],
      }),
    ).toBe("green");
    // But any failing gate run reds the commit even if another is green.
    expect(
      classifyCheckRuns({
        check_runs: [run("typecheck", "completed", "success"), run("ci", "completed", "timed_out")],
      }),
    ).toBe("red");
  });
});

describe("parseUpdateMemory", () => {
  test("tolerates garbage and partial records", () => {
    expect(parseUpdateMemory(null)).toEqual(emptyUpdateMemory());
    expect(parseUpdateMemory({ lastCheckAt: "soon", declinedSha: 7 })).toEqual(emptyUpdateMemory());
    expect(parseUpdateMemory({ lastCheckAt: NOW })).toEqual({ ...emptyUpdateMemory(), lastCheckAt: NOW });
    expect(parseUpdateMemory({ declinedSha: "" })).toEqual(emptyUpdateMemory());
  });

  test("journal entries survive round-trips; malformed ones drop", () => {
    const entry = { at: NOW, kind: "update", fromSha: "aaa", toSha: "bbb" };
    const parsed = parseUpdateMemory({
      journal: [entry, { at: "x" }, null, { at: NOW, kind: "sideways", fromSha: "a", toSha: "b" }],
      booting: { sha: "ccc", at: NOW },
      lastGoodSha: "aaa",
    });
    expect(parsed.journal).toEqual([entry as never]);
    expect(parsed.booting).toEqual({ sha: "ccc", at: NOW });
    expect(parsed.lastGoodSha).toBe("aaa");
  });
});
