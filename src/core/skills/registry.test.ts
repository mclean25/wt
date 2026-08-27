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

/**
 * `gh pr merge --auto` implements only ONE of the two GitHub features
 * that wear the "merge when ready" label, so on a repo whose base
 * branch has a merge queue it fails with `Auto merge is not allowed for
 * this repository` — naming a repo setting that is not the reason. An
 * agent reads that as a permission it needs a human for and hands back
 * a branch whose only remaining step was a button. The advice is easy
 * to re-add because it looks equivalent and works on unqueued repos,
 * which is why this is a test rather than a note.
 */
test("no bundled skill recommends `gh pr merge --auto`", () => {
  // Fenced blocks only. Prose that warns AGAINST the command has to
  // quote it to be worth anything, so a whole-file match flags the
  // documentation of this very trap; what matters is whether a skill
  // hands an agent the command to run.
  const offenders = UNITS.flatMap((unit) => {
    const src = unitSource(unit);
    if (!src) return [];
    const fenced = src.match(/```[\s\S]*?```/g) ?? [];
    return fenced.some((b) => /gh\s+pr\s+merge[^\n]*--auto/.test(b))
      ? [unit.name]
      : [];
  });
  expect(offenders).toEqual([]);
});
