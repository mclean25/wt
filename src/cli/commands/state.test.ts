import { describe, expect, test } from "bun:test";

import { parseWtState } from "../../core/wtstate/io.ts";
import { GROUP_ARCHIVED, GROUP_INBOX, stackSectionKey } from "../../core/wtstate/types.ts";
import { mergeMigratedState, selectLegacyState } from "./state.ts";

describe("selectLegacyState", () => {
  test("keeps only records and section metadata attributable to live worktrees", () => {
    const legacy = parseWtState({
      slugs: {
        ours: { section: "Now", order: 1 },
        ours2: { section: "Now", order: 2 },
        other: { section: "Elsewhere", order: 2 },
      },
      sectionsOrder: [GROUP_INBOX, "Now", "Elsewhere", stackSectionKey("ours-branch")],
      foldedSections: ["Now", "Elsewhere", GROUP_ARCHIVED],
      pausedStacks: ["ours-branch", "other-branch"],
      edges: [
        { from: "ours", to: "ours2", kind: "before", strength: "prefer", by: "fleet", fromSha: "a", toSha: "b", at: "now" },
        { from: "ours", to: "other", kind: "before", strength: "prefer", by: "fleet", fromSha: "a", toSha: "b", at: "now" },
      ],
      removed: [{ slug: "gone", branch: "gone", removedAt: "now" }],
      branchTips: { main: "abc" },
    });
    const selected = selectLegacyState(legacy, new Map([
      ["ours", "ours-branch"],
      ["ours2", "ours2-branch"],
    ]));

    expect(Object.keys(selected.state.slugs)).toEqual(["ours", "ours2"]);
    expect(selected.state.sectionsOrder).toEqual([
      GROUP_INBOX,
      "Now",
      stackSectionKey("ours-branch"),
    ]);
    expect(selected.state.foldedSections).toEqual(["Now", GROUP_ARCHIVED]);
    expect(selected.state.pausedStacks).toEqual(["ours-branch"]);
    expect(selected.state.edges).toHaveLength(1);
    expect(selected.state.removed).toEqual([]);
    expect(selected.state.branchTips).toEqual({});
  });
});

describe("mergeMigratedState", () => {
  test("preserves current values while filling missing legacy state", () => {
    const legacy = parseWtState({
      slugs: {
        one: { section: "Legacy", order: 1 },
        two: { section: "Legacy", order: 2 },
      },
      sectionsOrder: [GROUP_INBOX, "Legacy"],
      foldedSections: ["Legacy"],
      attentionSeenTs: 10,
    });
    const current = parseWtState({
      slugs: { one: { section: "Current", order: 9 } },
      sectionsOrder: [GROUP_INBOX, "Current"],
      attentionSeenTs: 20,
    });

    const merged = mergeMigratedState(legacy, current, true);
    expect(merged.slugs.one).toMatchObject({ section: "Current", order: 9 });
    expect(merged.slugs.two).toMatchObject({ section: "Legacy", order: 2 });
    expect(merged.sectionsOrder).toEqual([GROUP_INBOX, "Current", "Legacy"]);
    expect(merged.attentionSeenTs).toBe(20);
  });
});
