/**
 * The vacuous-containment guard: a branch with no commits of its own is
 * "not started", never "merged". Pinned against real git repos, because
 * the bug it prevents closed two GitHub issues describing work nobody
 * had begun (see `branchIsMerged`).
 */
import { expect, test } from "bun:test";
import { Effect, Exit, Fiber } from "effect";

import { branchIsEmptySince, git as coreGit, gitRun, GitError } from "./git.ts";
import { git, trackedTmpDirs } from "./test-fixtures.ts";

const { tmp } = trackedTmpDirs();

function repo() {
  const dir = tmp("wt-empty-since-test-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "M0"]);
  git(dir, ["checkout", "-q", "-b", "parent"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "P1"]);
  return { dir, parentTip: git(dir, ["rev-parse", "HEAD"]).trim() };
}

test("a stacked child that never committed is empty against its fork base", async () => {
  const { dir, parentTip } = repo();
  // `wt new --base parent` with no work done yet: the child's tip IS the
  // parent's tip, which is the whole population this guard protects.
  git(dir, ["checkout", "-q", "-b", "child"]);
  const childTip = git(dir, ["rev-parse", "HEAD"]).trim();

  expect(childTip).toBe(parentTip);
  expect(await Effect.runPromise(branchIsEmptySince(parentTip, childTip, dir))).toBe(true);
});

test("one commit of its own is enough to stop being empty", async () => {
  const { dir, parentTip } = repo();
  git(dir, ["checkout", "-q", "-b", "child"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "C1"]);
  const childTip = git(dir, ["rev-parse", "HEAD"]).trim();

  expect(await Effect.runPromise(branchIsEmptySince(parentTip, childTip, dir))).toBe(false);
});

test("the parent advancing under an unstarted child keeps it empty", async () => {
  // The recorded baseSha is the fork point, not the parent's current
  // tip — an empty child left behind by a parent that kept committing
  // must still read as not-started, not as work.
  const { dir, parentTip } = repo();
  git(dir, ["checkout", "-q", "-b", "child"]);
  const childTip = git(dir, ["rev-parse", "HEAD"]).trim();
  git(dir, ["checkout", "-q", "parent"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "P2"]);

  expect(await Effect.runPromise(branchIsEmptySince(parentTip, childTip, dir))).toBe(true);
});

test("an UNSTACKED worktree forked at trunk is empty against its recorded base", async () => {
  // The population the guard silently missed: `wt new` used to record a
  // fork base only for non-trunk forks, so `forkBaseIsVacuous` found no
  // record for an ordinary worktree and answered "not vacuous" — fail
  // open, on the exact rows it exists to protect. With trunk forks
  // recorded too, an unstarted one measures empty like a stacked one.
  const { dir } = repo();
  git(dir, ["checkout", "-q", "main"]);
  const trunkTipAtFork = git(dir, ["rev-parse", "HEAD"]).trim();
  git(dir, ["checkout", "-q", "-b", "solo"]);
  const soloTip = git(dir, ["rev-parse", "HEAD"]).trim();

  // Trunk moves on via a merge commit, which is what puts the fork point
  // off trunk's first-parent chain in the real failure and makes the
  // recorded base the only remaining evidence.
  git(dir, ["checkout", "-q", "main"]);
  git(dir, ["merge", "-q", "--no-ff", "--no-edit", "parent", "-m", "Merge parent"]);

  expect(await Effect.runPromise(branchIsEmptySince(trunkTipAtFork, soloTip, dir))).toBe(true);
});

test("an unresolvable base answers empty, the safe direction", async () => {
  // Unable to prove work exists, the guard must not license closing an
  // issue. A row left on the board is visible and cheap; a closed issue
  // is off-machine and silent.
  const { dir } = repo();
  const tip = git(dir, ["rev-parse", "HEAD"]).trim();

  expect(await Effect.runPromise(branchIsEmptySince("0".repeat(40), tip, dir))).toBe(true);
});

test("interrupting an Effect git command kills it and releases its process permit", async () => {
  const { dir } = repo();
  const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fiber = yield* Effect.forkScoped(
      gitRun(["-c", "alias.wait=!sleep 30", "wait"], dir),
    );
    yield* Effect.sleep(50);
    yield* Fiber.interrupt(fiber);
    return yield* Fiber.await(fiber);
  })));
  expect(Exit.hasInterrupts(exit)).toBe(true);

  const tips = await Effect.runPromise(
    Effect.all(
      Array.from({ length: 8 }, () => coreGit(["rev-parse", "HEAD"], dir)),
      { concurrency: "unbounded" },
    ),
  );
  expect(new Set(tips).size).toBe(1);
});

test("git reports nonzero commands as tagged GitError", async () => {
  const { dir } = repo();
  const error = await Effect.runPromise(
    coreGit(["rev-parse", "missing-ref"], dir).pipe(Effect.flip),
  );
  expect(error).toBeInstanceOf(GitError);
  expect(error._tag).toBe("GitError");
});
