import { describe, expect, test } from "bun:test";

import type { AutomationDef } from "../core/config.ts";
import { StatusKind, type PullRequest } from "../core/types.ts";

import {
  evaluateAutomations,
  fireIdentity,
  type AutomationEvalCtx,
} from "./automation-rules.ts";
import type {
  FieldState,
  StackRowInfo,
  WorktreeRow,
} from "./hooks/useWorktreeRows.ts";

function field<T>(data: T | undefined): FieldState<T> {
  return { data, isStale: false, isFetching: false, isLoading: false, error: null };
}

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 101,
    url: "https://github.com/o/r/pull/101",
    headRefName: "michael/eng-1-x",
    headRefOid: "abc123",
    baseRefName: "main",
    title: "t",
    isDraft: false,
    state: "OPEN",
    checks: "pass",
    failedChecks: [],
    review: "none",
    reviewRequests: 0,
    requestedReviewers: [],
    suggestedReviewers: [],
    reviewBot: { state: "none", unresolved: 0 },
    autoMerge: null,
    comments: [],
    unresolvedThreads: 0,
    mergedAt: null,
    closedAt: null,
    ...overrides,
  };
}

function makeRow(
  slug: string,
  overrides: Partial<WorktreeRow> = {},
): WorktreeRow {
  return {
    wt: { slug, path: `/tmp/${slug}`, branch: `michael/${slug}`, isMain: false, stage: slug },
    fields: {
      dirty: field<readonly string[]>([]),
      lock: field(null),
      deploy: field(false),
      merged: field(false),
      gone: field(false),
      sync: field(undefined),
      claude: field(undefined),
      gitActivity: field(undefined),
      conflict: field(undefined),
    },
    status: { kind: StatusKind.Clean, label: "clean" },
    stackedOn: null,
    stack: null,
    archived: false,
    title: slug,
    titleSource: "slug",
    brief: null,
    section: null,
    sectionIsStack: false,
    ...overrides,
  } as WorktreeRow;
}

function stackInfo(stackId: string, ordinal: number): StackRowInfo {
  return {
    stackId,
    ordinal,
    pos: "middle",
    lane: 0,
    depth: ordinal - 1,
    index: ordinal - 1,
  };
}

function rule(overrides: Partial<AutomationDef>): AutomationDef {
  return {
    id: "r",
    on: "pr.checks.failed",
    run: "fix-ci",
    busy: "queue",
    cooldownMinutes: null,
    settleSeconds: 0,
    ...overrides,
  };
}

const FRESH: AutomationEvalCtx = { githubFresh: true, isPausedSlug: () => false };

describe("pr.checks.failed", () => {
  const r = rule({ id: "fix-ci", on: "pr.checks.failed" });

  test("fires with a head-sha fire key and names the checks", () => {
    const row = makeRow("a", {
      pr: makePr({ checks: "fail", failedChecks: ["typecheck"] }),
    });
    const fires = evaluateAutomations([r], [row], FRESH);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.fireKeys).toEqual(["fix-ci:ci:a:abc123"]);
    expect(fires[0]!.slug).toBe("a");
    expect(fires[0]!.detail).toContain("typecheck");
    expect(fireIdentity(fires[0]!)).toBe("fix-ci|a");
  });

  test("stays silent on stale github data, missing oid, or passing checks", () => {
    const failing = makeRow("a", { pr: makePr({ checks: "fail" }) });
    expect(
      evaluateAutomations([r], [failing], { ...FRESH, githubFresh: false }),
    ).toHaveLength(0);
    const noOid = makeRow("a", {
      pr: makePr({ checks: "fail", headRefOid: undefined }),
    });
    expect(evaluateAutomations([r], [noOid], FRESH)).toHaveLength(0);
    const green = makeRow("a", { pr: makePr({ checks: "pass" }) });
    expect(evaluateAutomations([r], [green], FRESH)).toHaveLength(0);
  });

  test("skips archived, busy, and paused rows", () => {
    const row = makeRow("a", { pr: makePr({ checks: "fail" }) });
    expect(
      evaluateAutomations([r], [{ ...row, archived: true }], FRESH),
    ).toHaveLength(0);
    expect(
      evaluateAutomations(
        [r],
        [{ ...row, status: { kind: StatusKind.Busy, label: "destroying" } }],
        FRESH,
      ),
    ).toHaveLength(0);
    expect(
      evaluateAutomations([r], [row], { ...FRESH, isPausedSlug: (s) => s === "a" }),
    ).toHaveLength(0);
  });
});

describe("review_bot.unresolved", () => {
  test("fires only while bot findings are unresolved", () => {
    const r = rule({ id: "auto-rabbit", on: "review_bot.unresolved", run: "rabbit" });
    const unresolved = makeRow("a", {
      pr: makePr({ reviewBot: { state: "unresolved", unresolved: 3 } }),
    });
    const fires = evaluateAutomations([r], [unresolved], FRESH);
    expect(fires).toHaveLength(1);
    // ":rabbit:" is frozen for on-disk ledger continuity (see the
    // review_bot.unresolved case in automation-rules.ts).
    expect(fires[0]!.fireKeys).toEqual(["auto-rabbit:rabbit:a:abc123"]);
    const clean = makeRow("a", {
      pr: makePr({ reviewBot: { state: "clean", unresolved: 0 } }),
    });
    expect(evaluateAutomations([r], [clean], FRESH)).toHaveLength(0);
  });

  test("treats a cache-restored PR without the reviewBot field as none", () => {
    const r = rule({ id: "auto-rabbit", on: "review_bot.unresolved", run: "rabbit" });
    const pr = makePr({});
    // Entries persisted before the rabbit → reviewBot rename lack the
    // field entirely; the trigger must read that as "no bot state".
    delete (pr as { reviewBot?: unknown }).reviewBot;
    const row = makeRow("a", { pr });
    expect(evaluateAutomations([r], [row], FRESH)).toHaveLength(0);
  });
});

describe("wt.merged", () => {
  const r = rule({ id: "auto-clean", on: "wt.merged", run: "builtin:clean" });

  test("fires for a merged non-stack worktree", () => {
    const row = makeRow("a", { pr: makePr({ state: "MERGED" }) });
    const fires = evaluateAutomations([r], [row], FRESH);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.fireKeys).toEqual(["auto-clean:merged:a:101"]);
  });

  test("locally-merged branch fires without github freshness", () => {
    const row = makeRow("a", {
      fields: { ...makeRow("a").fields, merged: field(true) },
      status: { kind: StatusKind.Merged, label: "merged into origin/main" },
    });
    const fires = evaluateAutomations([r], [row], {
      ...FRESH,
      githubFresh: false,
    });
    expect(fires).toHaveLength(1);
    expect(fires[0]!.fireKeys).toEqual(["auto-clean:merged:a:local"]);
  });

  test("never fires for stack slices (restack owns their cleanup)", () => {
    const row = makeRow("a", {
      pr: makePr({ state: "MERGED" }),
      stack: stackInfo("eng-1", 1),
      status: { kind: StatusKind.Merged, label: "merged" },
    });
    expect(evaluateAutomations([r], [row], FRESH)).toHaveLength(0);
  });
});

describe("wt.merged → builtin:close-issue", () => {
  const r = rule({ id: "close-gh", on: "wt.merged", run: "builtin:close-issue" });

  test("fires only when an issue is attached, with an empty quiesce set", () => {
    const bare = makeRow("a", { pr: makePr({ state: "MERGED" }) });
    expect(evaluateAutomations([r], [bare], FRESH)).toHaveLength(0);
    const attached = makeRow("a", {
      pr: makePr({ state: "MERGED" }),
      githubIssue: 970,
    });
    const fires = evaluateAutomations([r], [attached], FRESH);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.fireKeys).toEqual(["close-gh:merged:a:101"]);
    // Empty on purpose: the close never touches the worktree, and the
    // empty set keeps it out of the dispatch loop's slug contention so
    // a racing clean/restack can't starve it into a superseded drop.
    expect(fires[0]!.quiesceSlugs).toEqual([]);
    // Frozen into the fire — delivery must not depend on the row (or
    // its wtstate entry) surviving until dispatch.
    expect(fires[0]!.closeIssue).toBe(970);
    expect(fires[0]!.detail).toContain("#970");
  });

  test("a GH-<n> primary slug id counts as the attached issue", () => {
    const row = makeRow("gh-88-fix-tabs", { pr: makePr({ state: "MERGED" }) });
    const fires = evaluateAutomations([r], [row], FRESH);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.closeIssue).toBe(88);
  });

  test("unlike other wt.merged rules, fires for stack members", () => {
    const row = makeRow("a", {
      pr: makePr({ state: "MERGED" }),
      githubIssue: 970,
      stack: stackInfo("eng-1", 1),
      status: { kind: StatusKind.Merged, label: "merged" },
    });
    expect(evaluateAutomations([r], [row], FRESH)).toHaveLength(1);
  });
});

describe("status.* (work-status triggers)", () => {
  const STALE: AutomationEvalCtx = { githubFresh: false, isPausedSlug: () => false };

  test("fires on the matching asserted state, keyed by assertion time", () => {
    const r = rule({ id: "ping", on: "status.needs_human" });
    const row = makeRow("a", {
      work: {
        state: "needs-human",
        note: "log me into the dev env",
        at: "2026-08-08T10:00:00Z",
      },
    });
    // Local state — must fire even before any github fetch.
    const fires = evaluateAutomations([r], [row], STALE);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.fireKeys).toEqual(["ping:work:a:2026-08-08T10:00:00Z"]);
    expect(fires[0]!.detail).toContain("log me into the dev env");
  });

  test("re-asserting produces a new fire key; other states don't fire", () => {
    const r = rule({ id: "ping", on: "status.ready" });
    const first = makeRow("a", {
      work: { state: "ready", risk: "medium", note: "resync", at: "t1" },
    });
    const second = makeRow("a", {
      work: { state: "ready", risk: "medium", note: "resync", at: "t2" },
    });
    const k1 = evaluateAutomations([r], [first], FRESH)[0]!.fireKeys[0];
    const k2 = evaluateAutomations([r], [second], FRESH)[0]!.fireKeys[0];
    expect(k1).not.toBe(k2);
    const wrongState = makeRow("a", { work: { state: "working", at: "t3" } });
    expect(evaluateAutomations([r], [wrongState], FRESH)).toHaveLength(0);
    expect(evaluateAutomations([r], [makeRow("a")], FRESH)).toHaveLength(0);
  });

  test("needs_testing fires on its own state only", () => {
    const r = rule({ id: "nudge", on: "status.needs_testing" });
    const row = makeRow("a", {
      work: { state: "needs-testing", note: "verify email copy", at: "t" },
    });
    const fires = evaluateAutomations([r], [row], STALE);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.detail).toBe("needs-testing — verify email copy");
    const other = makeRow("a", { work: { state: "needs-human", note: "x", at: "t" } });
    expect(evaluateAutomations([r], [other], STALE)).toHaveLength(0);
  });

  test("ready detail carries the risk", () => {
    const r = rule({ id: "ping", on: "status.ready" });
    const row = makeRow("a", {
      work: { state: "ready", risk: "high", note: "not reasonably testable", at: "t" },
    });
    expect(evaluateAutomations([r], [row], FRESH)[0]!.detail).toBe(
      "ready (risk: high) — not reasonably testable",
    );
  });
});

describe("stack.parent_merged", () => {
  const r = rule({
    id: "auto-restack",
    on: "stack.parent_merged",
    run: "builtin:restack",
  });

  test("fires once per stack with per-parent keys and whole-stack quiesce", () => {
    const merged = makeRow("s1", {
      pr: makePr({ number: 1, state: "MERGED" }),
      stack: stackInfo("eng-9", 1),
      status: { kind: StatusKind.Merged, label: "merged" },
    });
    const open1 = makeRow("s2", {
      pr: makePr({ number: 2 }),
      stack: stackInfo("eng-9", 2),
    });
    const open2 = makeRow("s3", {
      pr: makePr({ number: 3 }),
      stack: stackInfo("eng-9", 3),
    });
    const fires = evaluateAutomations([r], [merged, open1, open2], FRESH);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.stackId).toBe("eng-9");
    expect(fires[0]!.slug).toBe("s2");
    expect(fires[0]!.fireKeys).toEqual(["auto-restack:restack:eng-9:1"]);
    expect(fires[0]!.quiesceSlugs).toEqual(["s1", "s2", "s3"]);
    expect(fireIdentity(fires[0]!)).toBe("auto-restack|eng-9");
  });

  test("a single paused member protects the whole stack from restacks", () => {
    const merged = makeRow("s1", {
      pr: makePr({ number: 1, state: "MERGED" }),
      stack: stackInfo("eng-9", 1),
      status: { kind: StatusKind.Merged, label: "merged" },
    });
    const open = makeRow("s2", {
      pr: makePr({ number: 2 }),
      stack: stackInfo("eng-9", 2),
    });
    const fires = evaluateAutomations([r], [merged, open], {
      ...FRESH,
      isPausedSlug: (s) => s === "s2",
    });
    expect(fires).toHaveLength(0);
  });

  test("silent when nothing merged or nothing open", () => {
    const open = makeRow("s2", { pr: makePr({ number: 2 }), stack: stackInfo("eng-9", 2) });
    expect(evaluateAutomations([r], [open], FRESH)).toHaveLength(0);
    const merged = makeRow("s1", {
      pr: makePr({ number: 1, state: "MERGED" }),
      stack: stackInfo("eng-9", 1),
      status: { kind: StatusKind.Merged, label: "merged" },
    });
    expect(evaluateAutomations([r], [merged], FRESH)).toHaveLength(0);
  });

  test("stack-on-stack: fires when the external parent's PR merged", () => {
    // Stack A's only slice merged — A itself has nothing open, so A
    // must NOT fire. Stack B's root is based on A's branch and must.
    const aTip = makeRow("a-tip", {
      pr: makePr({ number: 10, state: "MERGED" }),
      stack: stackInfo("eng-a", 1),
      status: { kind: StatusKind.Merged, label: "merged" },
    });
    const bRoot = makeRow("b-root", {
      pr: makePr({ number: 20 }),
      stack: stackInfo("eng-b", 1),
      stackedOn: {
        slug: "a-tip",
        branch: aTip.wt.branch,
        diffBase: aTip.wt.branch,
      },
    });
    const fires = evaluateAutomations([r], [aTip, bRoot], FRESH);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.stackId).toBe("eng-b");
    expect(fires[0]!.fireKeys).toEqual(["auto-restack:restack:eng-b:ext:10"]);
    expect(fires[0]!.quiesceSlugs).toEqual(["b-root", "a-tip"]);
  });

  test("stack-on-stack: silent while the external parent is still open", () => {
    const aTip = makeRow("a-tip", {
      pr: makePr({ number: 10 }),
      stack: stackInfo("eng-a", 1),
    });
    const bRoot = makeRow("b-root", {
      pr: makePr({ number: 20 }),
      stack: stackInfo("eng-b", 1),
      stackedOn: {
        slug: "a-tip",
        branch: aTip.wt.branch,
        diffBase: aTip.wt.branch,
      },
    });
    expect(evaluateAutomations([r], [aTip, bRoot], FRESH)).toHaveLength(0);
  });

  test("stack-on-stack: fires once when the external parent has no worktree left", () => {
    const bRoot = makeRow("b-root", {
      pr: makePr({ number: 20 }),
      stack: stackInfo("eng-b", 1),
      stackedOn: {
        slug: null,
        branch: "michael/a-tip",
        diffBase: "michael/a-tip",
      },
    });
    const fires = evaluateAutomations([r], [bRoot], FRESH);
    expect(fires).toHaveLength(1);
    expect(fires[0]!.fireKeys).toEqual([
      "auto-restack:restack:eng-b:extgone:michael/a-tip",
    ]);
    expect(fires[0]!.quiesceSlugs).toEqual(["b-root"]);
  });

  test("stack-on-stack: a paused external parent blocks the boundary fire", () => {
    const aTip = makeRow("a-tip", {
      pr: makePr({ number: 10, state: "MERGED" }),
      stack: stackInfo("eng-a", 1),
      status: { kind: StatusKind.Merged, label: "merged" },
    });
    const bRoot = makeRow("b-root", {
      pr: makePr({ number: 20 }),
      stack: stackInfo("eng-b", 1),
      stackedOn: {
        slug: "a-tip",
        branch: aTip.wt.branch,
        diffBase: aTip.wt.branch,
      },
    });
    const fires = evaluateAutomations([r], [aTip, bRoot], {
      ...FRESH,
      isPausedSlug: (s) => s === "a-tip",
    });
    expect(fires).toHaveLength(0);
  });
});
