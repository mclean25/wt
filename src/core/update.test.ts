import { describe, expect, test } from "bun:test";

import {
  classifyCheckRuns,
  emptyUpdateMemory,
  findNewestEligible,
  parseUpdateMemory,
  restartEventsDaemonAfterUpdate,
  selectOffer,
  startupCheckGate,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdateJournalEntry,
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
    // Exactly the interval is NOT rate-limited (strict <) — pins the boundary.
    expect(
      startupCheckGate(
        CLEAN,
        { ...emptyUpdateMemory(), lastCheckAt: NOW - UPDATE_CHECK_INTERVAL_MS },
        NOW,
      ),
    ).toBe("run");
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
    expect(selectOffer({ behind: 3, target: "aaa", declinedSha: "aaa" })).toEqual({
      action: "declined",
      target: "aaa",
    });
    const next = selectOffer({ behind: 4, target: "bbb", declinedSha: "aaa" });
    expect(next).toEqual({ action: "offer", target: "bbb" });
    expect(selectOffer({ behind: 3, target: "aaa", declinedSha: null })).toEqual({
      action: "offer",
      target: "aaa",
    });
  });
});

describe("restartEventsDaemonAfterUpdate", () => {
  test("skips cleanly when the launchd agent is not installed", async () => {
    expect(
      await restartEventsDaemonAfterUpdate({ plist: "/tmp/wt-test-events-agent-does-not-exist.plist" }),
    ).toEqual({ status: "not-installed" });
  });

  test("runs the newly checked-out events restart command", async () => {
    const calls: string[][] = [];
    const result = await restartEventsDaemonAfterUpdate({
      plist: "/dev/null",
      run: async (argv) => {
        calls.push(argv);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    expect(result).toEqual({ status: "restarted" });
    expect(calls).toEqual([[`${process.cwd()}/bin/wt`, "events", "restart"]]);
  });

  test("reports a restart failure without throwing", async () => {
    const result = await restartEventsDaemonAfterUpdate({
      plist: "/dev/null",
      run: async () => ({ stdout: "", stderr: "launchctl load failed\n", exitCode: 1 }),
    });
    expect(result).toEqual({ status: "failed", detail: "launchctl load failed" });
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
    // Neutral / skipped conclusions count as green, not red.
    expect(classifyCheckRuns({ check_runs: [run("ci", "completed", "neutral")] })).toBe("green");
    expect(classifyCheckRuns({ check_runs: [run("ci", "completed", "skipped")] })).toBe("green");
    // One gate run still running + one green → the commit is pending, not green.
    expect(
      classifyCheckRuns({
        check_runs: [run("typecheck", "completed", "success"), run("ci", "queued", null)],
      }),
    ).toBe("pending");
    // Same name across contexts (push + pull_request, re-runs): a
    // success in any context wins for that name.
    expect(
      classifyCheckRuns({
        check_runs: [run("ci", "completed", "failure"), run("ci", "completed", "success")],
      }),
    ).toBe("green");
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

describe("findNewestEligible", () => {
  // The wt checkout's own origin is a GitHub remote, so the gate is
  // active; the fake fetch controls each sha's verdict without network.
  const fakeFetch = (bySha: Record<string, { name: string; status: string; conclusion: string | null }[]>) =>
    (async (input: unknown) => {
      const url = String(input);
      const sha = Object.keys(bySha).find((s) => url.includes(s));
      return new Response(JSON.stringify({ check_runs: sha ? bySha[sha] : [] }));
    }) as typeof fetch;
  const green = [{ name: "ci", status: "completed", conclusion: "success" }];
  const red = [{ name: "ci", status: "completed", conclusion: "failure" }];
  const pending = [{ name: "ci", status: "in_progress", conclusion: null }];

  test("skips red and pending heads, lands on the newest green", async () => {
    const r = await findNewestEligible(
      ["aaa1111", "bbb2222", "ccc3333"],
      fakeFetch({ aaa1111: red, bbb2222: pending, ccc3333: green }),
    );
    expect(r.target).toBe("ccc3333");
    expect(r.gated).toBe(true);
    expect(r.checked.map((c) => c.status)).toEqual(["red", "pending", "green"]);
  });

  test("no matching runs = unknown = eligible (fail open), first hit wins", async () => {
    const r = await findNewestEligible(["aaa1111", "bbb2222"], fakeFetch({}));
    expect(r.target).toBe("aaa1111");
    expect(r.checked).toHaveLength(1);
  });

  test("every interrogated candidate red → no target, capped lookups", async () => {
    const shas = Array.from({ length: 12 }, (_, i) => `sha${i}xxxxxx`);
    const bySha = Object.fromEntries(shas.map((s) => [s, red]));
    const r = await findNewestEligible(shas, fakeFetch(bySha));
    expect(r.target).toBeNull();
    expect(r.checked).toHaveLength(10);
  });

  test("empty candidate list is a no-op", async () => {
    const r = await findNewestEligible([], fakeFetch({}));
    expect(r).toEqual({ target: null, checked: [], gated: false });
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
    const entry: UpdateJournalEntry = { at: NOW, kind: "update", fromSha: "aaa", toSha: "bbb" };
    const parsed = parseUpdateMemory({
      journal: [entry, { at: "x" }, null, { at: NOW, kind: "sideways", fromSha: "a", toSha: "b" }],
      booting: { sha: "ccc", at: NOW, root: "/some/clone" },
      applying: { fromSha: "aaa", toSha: "ddd", at: NOW },
      lastGoodSha: "aaa",
    });
    expect(parsed.journal).toEqual([entry]);
    expect(parsed.booting).toEqual({ sha: "ccc", at: NOW, root: "/some/clone" });
    expect(parsed.applying).toEqual({ fromSha: "aaa", toSha: "ddd", at: NOW });
    expect(parsed.lastGoodSha).toBe("aaa");
  });

  test("malformed booting/applying records drop cleanly", () => {
    const parsed = parseUpdateMemory({
      booting: { sha: 42, at: NOW },
      applying: { fromSha: "aaa", at: NOW },
    });
    expect(parsed.booting).toBeNull();
    expect(parsed.applying).toBeNull();
  });
});
