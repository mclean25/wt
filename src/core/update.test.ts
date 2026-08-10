import { describe, expect, test } from "bun:test";

import {
  emptyUpdateMemory,
  parseUpdateMemory,
  postFetchAction,
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
      startupCheckGate({ ...CLEAN, dirty: true }, { lastCheckAt: NOW - 1000, declinedSha: null }, NOW),
    ).toBe("local-changes");
  });

  test("rate limit: one check per day, first-ever check runs", () => {
    expect(startupCheckGate(CLEAN, emptyUpdateMemory(), NOW)).toBe("run");
    expect(
      startupCheckGate(CLEAN, { lastCheckAt: NOW - 60_000, declinedSha: null }, NOW),
    ).toBe("rate-limited");
    expect(
      startupCheckGate(CLEAN, { lastCheckAt: NOW - UPDATE_CHECK_INTERVAL_MS - 1, declinedSha: null }, NOW),
    ).toBe("run");
  });

  test("a future lastCheckAt (clock rollback) can't wedge the check forever", () => {
    expect(
      startupCheckGate(CLEAN, { lastCheckAt: NOW + UPDATE_CHECK_INTERVAL_MS, declinedSha: null }, NOW),
    ).toBe("run");
  });
});

describe("postFetchAction", () => {
  test("nothing behind → up-to-date, regardless of decline memory", () => {
    expect(
      postFetchAction({ behind: 0, remoteSha: "abc1234" }, { lastCheckAt: null, declinedSha: "abc1234" }),
    ).toBe("up-to-date");
  });

  test("a decline silences exactly that remote head, not the next one", () => {
    const mem = { lastCheckAt: null, declinedSha: "abc1234" };
    expect(postFetchAction({ behind: 3, remoteSha: "abc1234" }, mem)).toBe("declined");
    expect(postFetchAction({ behind: 4, remoteSha: "def5678" }, mem)).toBe("offer");
    expect(postFetchAction({ behind: 3, remoteSha: "abc1234" }, emptyUpdateMemory())).toBe("offer");
  });
});

describe("parseUpdateMemory", () => {
  test("tolerates garbage and partial records", () => {
    expect(parseUpdateMemory(null)).toEqual(emptyUpdateMemory());
    expect(parseUpdateMemory({ lastCheckAt: "soon", declinedSha: 7 })).toEqual(emptyUpdateMemory());
    expect(parseUpdateMemory({ lastCheckAt: NOW })).toEqual({ lastCheckAt: NOW, declinedSha: null });
    expect(parseUpdateMemory({ declinedSha: "" })).toEqual(emptyUpdateMemory());
  });
});
