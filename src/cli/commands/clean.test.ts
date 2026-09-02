import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { WorktreeError } from "../../core/worktree.ts";
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

async function quiet<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
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
    fetchOrigin: () => Effect.void,
    listWorktrees: () => Effect.succeed([]),
    worktreeStatus: () => Effect.succeed({ kind: StatusKind.Clean, label: "clean" }),
    fetchGithub: () =>
      Effect.succeed({ prs: new Map(), mergeQueue: new Map() }),
    worktreeIsDirty: () => Effect.succeed(false),
    readWtState: () => parseWtState({}),
    removeWorktree: () =>
      Effect.succeed({
        ok: true,
        message: "removed",
        destroyedStage: false,
        deletedBranch: true,
      }),
    spawnBackgroundRemove: () => Effect.succeed("/tmp/remove.log"),
    isOurStageDeployed: () => false,
    killAllSessionsFor: () => Effect.void,
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
          fetchOrigin: () =>
            Effect.fail(
              new WorktreeError({ operation: "fetch-origin", cause: new Error("offline") }),
            ),
          listWorktrees: () => Effect.succeed([wt("one")]),
          worktreeStatus: () => {
            classified++;
            return Effect.succeed({ kind: StatusKind.Merged, label: "merged" });
          },
          removeWorktree: () => {
            removed++;
            return Effect.succeed({
              ok: true,
              message: "removed",
              destroyedStage: false,
              deletedBranch: true,
            });
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
          listWorktrees: () => Effect.succeed(rows),
          worktreeStatus: () =>
            Effect.succeed({
              kind: StatusKind.Merged,
              label: "merged",
            }),
          removeWorktree: (row) => {
            removed.push(row.slug);
            return Effect.succeed({
              ok: row.slug === "one",
              message: row.slug === "one" ? "removed one" : "refused two",
              destroyedStage: false,
              deletedBranch: row.slug === "one",
            });
          },
          killAllSessionsFor: (slug) => {
            cleanedSessions.push(slug);
            return Effect.void;
          },
        }),
      ),
    );

    expect(code).toBe(1);
    expect(removed).toEqual(["one", "two"]);
    expect(cleanedSessions).toEqual(["one"]);
  });
});
