/**
 * The `u` picker's one departure from "a pick replaces the whole
 * record". Everything else a record carries is a claim made BY that
 * assertion; a post-merge verification is a standing obligation about
 * the branch, and dropping it silently is what would release a merged
 * worktree back to the sweep with nothing printed anywhere.
 */
import { describe, expect, test } from "bun:test";

import type { WorkStatusRecord } from "../../core/work-status.ts";
import { carriedVerify, WORK_STATE_CHORDS } from "./work-status.ts";

const owed: WorkStatusRecord = {
  state: "ready",
  at: "2026-08-20T12:00:00Z",
  verifyAfterMerge: "connect gcal on staging",
};

describe("carriedVerify", () => {
  test("an ordinary pick keeps the obligation", () => {
    expect(carriedVerify(owed, "working")).toEqual({
      verifyAfterMerge: "connect gcal on staging",
    });
  });

  test("its two exits drop it", () => {
    expect(carriedVerify(owed, "verified")).toEqual({});
    expect(carriedVerify(owed, "dropped")).toEqual({});
  });

  test("nothing owed carries nothing", () => {
    expect(carriedVerify({ state: "ready", at: owed.at }, "working")).toEqual({});
    expect(carriedVerify(null, "working")).toEqual({});
    expect(carriedVerify(undefined, "working")).toEqual({});
  });
});

describe("picker chords", () => {
  // The picker reserves j/k/u/q/x and the digits; a chord colliding
  // with one of those is a key that silently does the wrong thing.
  test("every state has a distinct, non-reserved chord", () => {
    const chords = Object.values(WORK_STATE_CHORDS);
    expect(new Set(chords).size).toBe(chords.length);
    for (const c of chords) expect("jkuqx0123456789").not.toContain(c);
  });
});
