import { describe, expect, test } from "bun:test";

import { evaluateActionRequirements } from "./requirements.ts";
import type { ActionRowState } from "./types.ts";

const rowState = (over: Partial<ActionRowState> = {}): ActionRowState => ({
  slug: "coz-2176-active-louse",
  pr: undefined,
  deployed: false,
  ...over,
});

describe("issue.tracker", () => {
  test("a slug carrying a tracker id satisfies it", () => {
    expect(evaluateActionRequirements(["issue.tracker"], rowState())).toEqual({ ok: true });
  });

  test("a slug with no tracker id blocks with a reason the picker can print", () => {
    // The live shape that produced this: every worktree on the fleet is
    // keyed to a GitHub issue rather than a tracker task, so `{{issue_id}}`
    // renders empty and the shell action runs with a hole in its argv.
    expect(
      evaluateActionRequirements(["issue.tracker"], rowState({ slug: "codex-delta-reviews" })),
    ).toEqual({ ok: false, reason: "no tracker id in slug" });
  });

  test("an id embedded mid-slug still counts", () => {
    expect(
      evaluateActionRequirements(["issue.tracker"], rowState({ slug: "fix-coz-2176-later" })),
    ).toEqual({ ok: true });
  });

  test("the empty slug the row-less manager palette passes is not a tracker id", () => {
    expect(evaluateActionRequirements(["issue.tracker"], rowState({ slug: "" })).ok).toBe(false);
  });

  test("an action that does not ask for it is unaffected", () => {
    expect(
      evaluateActionRequirements([], rowState({ slug: "codex-delta-reviews" })),
    ).toEqual({ ok: true });
  });
});
