/**
 * The vacuous-containment guard: a branch with no commits of its own is
 * "not started", never "merged". Pinned against real git repos, because
 * the bug it prevents closed two GitHub issues describing work nobody
 * had begun (see `branchIsMerged`).
 */
import { expect, test } from "bun:test";

import { branchIsEmptySince } from "./git.ts";
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
  expect(await branchIsEmptySince(parentTip, childTip, dir)).toBe(true);
});

test("one commit of its own is enough to stop being empty", async () => {
  const { dir, parentTip } = repo();
  git(dir, ["checkout", "-q", "-b", "child"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "C1"]);
  const childTip = git(dir, ["rev-parse", "HEAD"]).trim();

  expect(await branchIsEmptySince(parentTip, childTip, dir)).toBe(false);
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

  expect(await branchIsEmptySince(parentTip, childTip, dir)).toBe(true);
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

  expect(await branchIsEmptySince(trunkTipAtFork, soloTip, dir)).toBe(true);
});

test("an unresolvable base answers empty, the safe direction", async () => {
  // Unable to prove work exists, the guard must not license closing an
  // issue. A row left on the board is visible and cheap; a closed issue
  // is off-machine and silent.
  const { dir } = repo();
  const tip = git(dir, ["rev-parse", "HEAD"]).trim();

  expect(await branchIsEmptySince("0".repeat(40), tip, dir)).toBe(true);
});
