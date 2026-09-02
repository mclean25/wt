import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { Worktree } from "../../core/types.ts";
import { StatusKind } from "../../core/types.ts";
import { parseWtState } from "../../core/wtstate.ts";
import { runWithDeps, type CleanDeps } from "./clean.ts";

const wt = (slug: string): Worktree => ({
  slug,
  branch: `feature/${slug}`,
  path: `/tmp/${slug}`,
  stage: `stage-${slug}`,
  isMain: false,
});

async function quiet<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
  const log = console.log;
  const error = console.error;
  console.log = (): void => {};
  console.error = (): void => {};
  try {
    return await Effect.runPromise(effect);
  } finally {
    console.log = log;
    console.error = error;
  }
}

function baseDeps(overrides: Partial<CleanDeps>): CleanDeps {
  return {
    fetchOrigin: async () => {},
    listWorktrees: async () => [],
    worktreeStatus: async () => ({ kind: StatusKind.Clean, label: "clean" }),
    fetchGithub: () =>
      Effect.succeed({ prs: new Map(), mergeQueue: new Map() }),
    worktreeIsDirty: async () => false,
    readWtState: () => parseWtState({}),
    removeWorktree: async () => ({
      ok: true,
      message: "removed",
      destroyedStage: false,
      deletedBranch: true,
    }),
    spawnBackgroundRemove: () => "/tmp/remove.log",
    isOurStageDeployed: () => false,
    killAllSessionsFor: async () => {},
    ...overrides,
  };
}

describe("wt clean failure handling", () => {
  test("fails closed when fetchOrigin fails", async () => {
    let classified = 0;
    let removed = 0;
    const code = await quiet(
      runWithDeps(
        ["--yes", "--foreground"],
        baseDeps({
          fetchOrigin: async () => {
            throw new Error("offline");
          },
          listWorktrees: async () => [wt("one")],
          worktreeStatus: async () => {
            classified++;
            return { kind: StatusKind.Merged, label: "merged" };
          },
          removeWorktree: async () => {
            removed++;
            return {
              ok: true,
              message: "removed",
              destroyedStage: false,
              deletedBranch: true,
            };
          },
        }),
      ),
    );

    expect(code).toBe(1);
    expect(classified).toBe(0);
    expect(removed).toBe(0);
  });

  test("keeps foreground successes and exits 1 when another removal fails", async () => {
    const removed: string[] = [];
    const cleanedSessions: string[] = [];
    const rows = [wt("one"), wt("two")];
    const code = await quiet(
      runWithDeps(
        ["--yes", "--foreground"],
        baseDeps({
          listWorktrees: async () => rows,
          worktreeStatus: async () => ({
            kind: StatusKind.Merged,
            label: "merged",
          }),
          removeWorktree: async (row) => {
            removed.push(row.slug);
            return {
              ok: row.slug === "one",
              message: row.slug === "one" ? "removed one" : "refused two",
              destroyedStage: false,
              deletedBranch: row.slug === "one",
            };
          },
          killAllSessionsFor: async (slug) => {
            cleanedSessions.push(slug);
          },
        }),
      ),
    );

    expect(code).toBe(1);
    expect(removed).toEqual(["one", "two"]);
    expect(cleanedSessions).toEqual(["one"]);
  });
});
