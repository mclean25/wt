import { describe, expect, test } from "bun:test";

import { StatusKind } from "../core/types.ts";

import { destroyHazard, destroyHazardLabel, isCleanCandidate } from "./app-helpers.ts";
import type { FieldState, WorktreeRow } from "./hooks/useWorktreeRows.ts";

function field<T>(data: T | undefined): FieldState<T> {
  return { data, isStale: false, isFetching: false, isLoading: false, error: null };
}

type SyncData = NonNullable<WorktreeRow["fields"]["sync"]["data"]>;

/**
 * `"loading"` is the explicit spelling of "the query has no data yet" —
 * a bare `undefined` would be swallowed by the default parameter and
 * silently test the clean case instead.
 */
function makeRow(overrides: {
  dirty?: readonly string[] | "loading";
  ahead?: number | "loading";
  status?: WorktreeRow["status"];
  pr?: WorktreeRow["pr"];
  archived?: boolean;
}): WorktreeRow {
  const { dirty = [], ahead = 0, status, pr, archived = false } = overrides;
  return {
    wt: {
      slug: "s",
      path: "/tmp/s",
      branch: "michael/s",
      isMain: false,
      stage: "s",
    },
    fields: {
      dirty: field<readonly string[]>(dirty === "loading" ? undefined : dirty),
      lock: field(null),
      deploy: field(false),
      merged: field(false),
      gone: field(false),
      sync: field(
        ahead === "loading"
          ? undefined
          : ({ remote: { ahead, behind: 0 } } as unknown as SyncData),
      ),
      claude: field(undefined),
      gitActivity: field(undefined),
      conflict: field(undefined),
    },
    status: status ?? { kind: StatusKind.Clean, label: "clean" },
    stackedOn: null,
    stack: null,
    archived,
    title: "s",
    titleSource: "slug",
    brief: null,
    section: null,
    sectionIsStack: false,
    ...(pr ? { pr } : {}),
  } as unknown as WorktreeRow;
}

describe("destroyHazard", () => {
  test("a clean, fully-pushed worktree has no hazard", () => {
    expect(destroyHazard(makeRow({}))).toBeNull();
  });

  test("uncommitted changes are a hazard, counted", () => {
    const hazard = destroyHazard(makeRow({ dirty: ["a.ts", "b.ts", "c.ts"] }));
    expect(hazard).toEqual({ kind: "dirty", count: 3 });
    expect(destroyHazardLabel(hazard!)).toBe("3 uncommitted changes");
  });

  test("unpushed commits are a hazard", () => {
    const hazard = destroyHazard(makeRow({ ahead: 1 }));
    expect(hazard).toEqual({ kind: "unpushed", count: 1 });
    expect(destroyHazardLabel(hazard!)).toBe("1 unpushed commit");
  });

  test("still-loading state is a hazard, not an absence of one", () => {
    // Both fields read undefined while their queries load or after an
    // error. Collapsing that into "clean" is what let a merged worktree
    // with 16 uncommitted files get swept.
    expect(destroyHazard(makeRow({ dirty: "loading" }))).toEqual({ kind: "unknown" });
    expect(destroyHazard(makeRow({ ahead: "loading" }))).toEqual({ kind: "unknown" });
  });

  test("a merged branch with uncommitted work is a clean CANDIDATE but still hazardous", () => {
    // The regression this pins: `isCleanCandidate` is a claim about the
    // branch, `destroyHazard` a claim about the working tree. The clean
    // sweep once consulted only the first and destroyed rift checkouts —
    // independent clones, so branch and reflog went with the directory.
    const row = makeRow({
      dirty: ["src/x.ts"],
      status: { kind: StatusKind.Merged, label: "merged" },
    });
    expect(isCleanCandidate(row)).toBe(true);
    expect(destroyHazard(row)).toEqual({ kind: "dirty", count: 1 });
  });

  test("dirty outranks unpushed when both are present", () => {
    expect(destroyHazard(makeRow({ dirty: ["a.ts"], ahead: 4 }))).toEqual({
      kind: "dirty",
      count: 1,
    });
  });
});
