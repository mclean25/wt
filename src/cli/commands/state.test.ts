import { describe, expect, test } from "bun:test";

import { parseWtState } from "../../core/wtstate/io.ts";
import { GROUP_ARCHIVED, GROUP_INBOX, stackSectionKey } from "../../core/wtstate/types.ts";
import {
  mergeAdoptedState,
  mergeMigratedState,
  mergeRegistries,
  selectLegacyState,
  selectStrandedRows,
} from "./state.ts";

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

describe("selectStrandedRows", () => {
  const opts = {
    repoId: "code-myrepo",
    repoPath: "/repo/myrepo",
    worktreeRoot: "/repo/myrepo-wt",
    currentDb: "/state/wt.sqlite",
  };
  const row = (
    over: Partial<{ repoId: string; repoPath: string; updatedAt: number; source: string }>,
  ) => ({
    repoId: "x",
    repoPath: "/repo/myrepo",
    data: "{}",
    updatedAt: 1,
    archived: new Set<string>(),
    source: "/state/wt.sqlite",
    ...over,
  });

  test("adopts this repository out of another database file", () => {
    const picked = selectStrandedRows(
      [row({ repoId: "code-myrepo", source: "/cache/wt.sqlite" })],
      opts,
    );
    expect(picked.map((r) => r.source)).toEqual(["/cache/wt.sqlite"]);
  });

  test("adopts a worktree that was mistaken for a repository", () => {
    const picked = selectStrandedRows(
      [row({ repoId: "code-myrepo-wt-feature", repoPath: "/repo/myrepo-wt/feature" })],
      opts,
    );
    expect(picked).toHaveLength(1);
  });

  test("never adopts its own current row, so re-running is a no-op", () => {
    expect(selectStrandedRows([row({ repoId: "code-myrepo" })], opts)).toEqual([]);
  });

  test("leaves an unrelated repository alone", () => {
    expect(
      selectStrandedRows(
        [row({ repoId: "code-other", repoPath: "/repo/other", source: "/cache/wt.sqlite" })],
        opts,
      ),
    ).toEqual([]);
  });

  test("orders oldest first so a newer stray wins over an older one", () => {
    const picked = selectStrandedRows(
      [
        row({ repoId: "b", repoPath: "/repo/myrepo-wt/b", updatedAt: 9 }),
        row({ repoId: "a", repoPath: "/repo/myrepo-wt/a", updatedAt: 2 }),
      ],
      opts,
    );
    expect(picked.map((r) => r.repoId)).toEqual(["a", "b"]);
  });
});

describe("mergeAdoptedState", () => {
  test("fills gaps in a slug record without overwriting what the current one has", () => {
    // The exact split that was reported: a tracker id set through the TUI in
    // one namespace, a work status asserted by the agent in the other. A
    // whole-record winner drops one of them and looks like it worked.
    const stray = parseWtState({
      slugs: { app: { issueId: "COZ-2339", section: "Old", order: 3 } },
    });
    const current = parseWtState({
      slugs: { app: { work: { state: "needs-testing", at: "now" }, order: 1 } },
    });
    const merged = mergeAdoptedState(stray, current);
    expect(merged.slugs.app?.issueId).toBe("COZ-2339");
    expect(merged.slugs.app?.work?.state).toBe("needs-testing");
    expect(merged.slugs.app?.order).toBe(1);
    expect(merged.slugs.app?.section).toBe("Old");
  });

  test("an asserted empty tracker id is a value, not a gap", () => {
    const stray = parseWtState({ slugs: { app: { issueId: "COZ-1" } } });
    const current = parseWtState({ slugs: { app: { issueId: "" } } });
    expect(mergeAdoptedState(stray, current).slugs.app?.issueId).toBe("");
  });

  test("brings across a slug the current namespace never saw", () => {
    const stray = parseWtState({ slugs: { only: { section: "Now", order: 1 } } });
    const merged = mergeAdoptedState(stray, parseWtState({}));
    expect(merged.slugs.only?.section).toBe("Now");
  });

  test("unions edges and keeps the current one when both describe a pair", () => {
    const edge = (over: Record<string, unknown>) => ({
      from: "a",
      to: "b",
      kind: "before",
      strength: "prefer",
      by: "old",
      fromSha: "1",
      toSha: "2",
      at: "then",
      ...over,
    });
    const stray = parseWtState({ edges: [edge({}), edge({ from: "c", to: "d" })] });
    const current = parseWtState({ edges: [edge({ by: "new" })] });
    const merged = mergeAdoptedState(stray, current);
    expect(merged.edges).toHaveLength(2);
    expect(merged.edges.find((e) => e.from === "a")?.by).toBe("new");
  });
});

describe("mergeRegistries", () => {
  test("unions Claude's per-slug name arrays", () => {
    expect(
      mergeRegistries({ manager: ["manager"], app: ["primary"] }, { app: ["2"] }),
    ).toEqual({ manager: ["manager"], app: ["2", "primary"] });
  });

  test("merges Codex's nested uuid maps with the destination winning", () => {
    expect(
      mergeRegistries(
        { app: { "uuid-a": "primary", "uuid-b": "2" } },
        { app: { "uuid-a": "3" } },
      ),
    ).toEqual({ app: { "uuid-a": "3", "uuid-b": "2" } });
  });

  test("keeps a slug only the legacy namespace ever recorded", () => {
    expect(mergeRegistries({ old: ["primary"] }, {})).toEqual({ old: ["primary"] });
  });
});
