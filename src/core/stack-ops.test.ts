/**
 * resolveAnchor: the squash-safe replay cut point survives a
 * hand-rebase. Two stale-anchor shapes a bare `--is-ancestor` guard
 * couldn't tell apart, pinned against real git repos.
 */
import { expect, test } from "bun:test";

import { resolveAnchor } from "./stack-ops.ts";
import { git, trackedTmpDirs } from "./test-fixtures.ts";

const { tmp } = trackedTmpDirs();

test("resolveAnchor uses the live merge-base when a branch was rebased onto newer trunk", async () => {
  // eng-5244 reproduction: the branch was hand-rebased onto a newer parent
  // tip, so the OLD baseSha (p1) is STILL an ancestor of the branch — the
  // naive guard trusts it and replays already-present history. The real
  // fork point advanced to p2.
  const dir = tmp("wt-anchor-test-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "M0"]);
  git(dir, ["checkout", "-q", "-b", "p"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "P1"]);
  const p1 = git(dir, ["rev-parse", "HEAD"]).trim();
  git(dir, ["commit", "-q", "--allow-empty", "-m", "P2"]);
  const p2 = git(dir, ["rev-parse", "HEAD"]).trim();
  git(dir, ["checkout", "-q", "-b", "c"]); // c built on the advanced parent tip
  git(dir, ["commit", "-q", "--allow-empty", "-m", "C"]);

  const anchor = await resolveAnchor({ branch: "c", baseSha: p1 }, "p", dir);
  expect(anchor).toBe(p2); // the true fork point, so only C replays
  expect(anchor).not.toBe(p1); // not the stale stored anchor
});

test("resolveAnchor keeps baseSha when the live merge-base is older (squash-merged parent)", async () => {
  // The healthy squash case: the parent squash-merged into the integration
  // branch as one commit, so merge-base(child, parent) drops to M0 — BELOW
  // the recorded baseSha. baseSha must stand, or the squashed parent's
  // commits get re-applied.
  const dir = tmp("wt-anchor-test-");
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "M0"]);
  const m0 = git(dir, ["rev-parse", "HEAD"]).trim();
  git(dir, ["checkout", "-q", "-b", "p"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "P1"]);
  const p1 = git(dir, ["rev-parse", "HEAD"]).trim();
  git(dir, ["checkout", "-q", "-b", "c"]); // child built on the parent tip
  git(dir, ["commit", "-q", "--allow-empty", "-m", "C"]);
  git(dir, ["checkout", "-q", "-b", "released", "main"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", "squash of p"]);

  const anchor = await resolveAnchor({ branch: "c", baseSha: p1 }, "released", dir);
  expect(anchor).toBe(p1); // squash-safe anchor preserved
  expect(anchor).not.toBe(m0);
});
