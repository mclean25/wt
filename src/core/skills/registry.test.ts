import { describe, expect, test } from "bun:test";

import { findUnit, UNITS, unitSource } from "./registry.ts";

describe("bundled skills registry", () => {
  test("every declared unit has a readable bundled source", () => {
    for (const unit of UNITS) {
      expect(unitSource(unit), unit.name).not.toBeNull();
    }
  });

  test("handoff is a distributed skill", () => {
    expect(findUnit("handoff")).toMatchObject({
      kind: "skill",
      name: "handoff",
    });
  });

  /**
   * The instructions block is spliced into the reader's own global
   * CLAUDE.md/AGENTS.md, so it is loaded on every turn of every agent on
   * the machine and is edited by REPLACEMENT, not accretion — rules, not
   * the incidents behind them (docs/skills.md#what-belongs-in-the-block).
   * The budget is the enforceable half of that rule: the block reached
   * 2.5x this one reasonable-looking addition at a time, and no single
   * addition ever looked like the problem, which is exactly why a review
   * habit can't hold the line and a number can. Raising it is a decision
   * to make deliberately, not a formality on the way to landing a bullet.
   */
  test("the always-on instructions block stays within its line budget", () => {
    const src = unitSource(findUnit("instructions")!)!;
    expect(src.trimEnd().split("\n").length).toBeLessThanOrEqual(140);
  });
});
