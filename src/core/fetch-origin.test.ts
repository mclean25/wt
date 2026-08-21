/**
 * Two things `fetchOrigin` and the sync counts must get right about
 * INDEPENDENT CLONES (the `rift` backend), pinned against real repos
 * because both failures are invisible in a shared-ref-store fixture:
 *
 *  - `[branch] keep_fresh` — local heads the main clone carries for
 *    reference (`main`, when you fork from `staging`). `git fetch
 *    --prune` already moves `origin/<branch>`; nothing was moving the
 *    local head, so `git log main` answered about the last manual fetch.
 *  - `freshBaseRev` — a clone's own `origin/<trunk>` is frozen at clone
 *    time, so counting `origin/<trunk>..HEAD` there charges the branch
 *    for every trunk commit that landed after the freeze.
 *
 * Both run the real module under a generated `WT_CONFIG` in a
 * subprocess, since config loads once at module init.
 */
import { expect, test } from "bun:test";

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { git as rawGit, trackedTmpDirs } from "./test-fixtures.ts";

const { tmp } = trackedTmpDirs();

function git(cwd: string, args: string[]): string {
  return rawGit(cwd, args).trim();
}

/** Bare origin carrying `main` and `staging`, plus a seed clone to push from. */
function buildOrigin(): { origin: string; seed: string } {
  const origin = tmp("wt-fo-origin-");
  git(origin, ["init", "-q", "--bare", "-b", "main"]);
  const seed = tmp("wt-fo-seed-");
  git(seed, ["clone", "-q", origin, "."]);
  git(seed, ["commit", "-q", "--allow-empty", "-m", "M0"]);
  git(seed, ["push", "-q", "origin", "main"]);
  git(seed, ["checkout", "-q", "-b", "staging"]);
  git(seed, ["commit", "-q", "--allow-empty", "-m", "S1"]);
  git(seed, ["push", "-q", "origin", "staging"]);
  return { origin, seed };
}

function writeConfig(
  root: string,
  mainClone: string,
  extra: string,
): string {
  const path = join(root, "config.toml");
  mkdirSync(root, { recursive: true });
  writeFileSync(
    path,
    `
[paths]
main_clone = ${JSON.stringify(mainClone)}
worktree_root = ${JSON.stringify(join(root, "wts"))}
log_dir = ${JSON.stringify(join(root, "logs"))}
lock_dir = ${JSON.stringify(join(root, "locks"))}
cache_db = ${JSON.stringify(join(root, "cache.sqlite"))}

[branch]
prefix = "test"
base = "staging"
${extra}
`,
  );
  return path;
}

/** Run `script` with the wt config loaded from `configPath`; returns stdout. */
function runWithConfig(cwd: string, configPath: string, script: string): string {
  const env: Record<string, string | undefined> = {
    ...process.env,
    WT_CONFIG: configPath,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "wt test",
    GIT_AUTHOR_EMAIL: "wt@example.test",
    GIT_COMMITTER_NAME: "wt test",
    GIT_COMMITTER_EMAIL: "wt@example.test",
  };
  const r = Bun.spawnSync([process.execPath, "-e", script], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return r.stdout.toString();
}

const WORKTREE_MOD = JSON.stringify(
  pathToFileURL(join(import.meta.dir, "worktree.ts")).href,
);

const GIT_MOD = JSON.stringify(
  pathToFileURL(join(import.meta.dir, "git.ts")).href,
);

test("keep_fresh CREATES a local head the clone never had, and advances it", async () => {
  const { origin, seed } = buildOrigin();
  const root = tmp("wt-fo-root-");
  // `clone -b staging` gives a local `staging` and NO local `main` —
  // the shape a staging-based repo actually has, and the one where
  // skip-if-absent would make the option a silent no-op.
  const main = tmp("wt-fo-main-");
  git(main, ["clone", "-q", "-b", "staging", origin, "."]);
  expect(git(main, ["branch", "--format=%(refname:short)"])).toBe("staging");

  git(seed, ["checkout", "-q", "main"]);
  git(seed, ["commit", "-q", "--allow-empty", "-m", "M1"]);
  git(seed, ["push", "-q", "origin", "main"]);
  git(seed, ["checkout", "-q", "staging"]);
  git(seed, ["commit", "-q", "--allow-empty", "-m", "S2"]);
  git(seed, ["push", "-q", "origin", "staging"]);

  const cfg = writeConfig(root, main, 'keep_fresh = ["main"]');
  runWithConfig(
    root,
    cfg,
    `const m = await import(${WORKTREE_MOD}); await m.fetchOrigin();`,
  );

  // The named branch is created and current...
  expect(git(main, ["rev-parse", "main"])).toBe(git(main, ["rev-parse", "origin/main"]));
  // ...and the base still fast-forwards, checked out and clean.
  expect(git(main, ["rev-parse", "HEAD"])).toBe(git(main, ["rev-parse", "origin/staging"]));
});

test("keep_fresh refuses to touch a local head that has DIVERGED", async () => {
  const { origin, seed } = buildOrigin();
  const root = tmp("wt-fo-root-div-");
  const main = tmp("wt-fo-main-div-");
  git(main, ["clone", "-q", "-b", "staging", origin, "."]);
  git(main, ["checkout", "-q", "-b", "main", "origin/main"]);
  git(main, ["commit", "-q", "--allow-empty", "-m", "local-only"]);
  const localOnly = git(main, ["rev-parse", "main"]);
  git(main, ["checkout", "-q", "staging"]);

  git(seed, ["checkout", "-q", "main"]);
  git(seed, ["commit", "-q", "--allow-empty", "-m", "M1"]);
  git(seed, ["push", "-q", "origin", "main"]);

  const cfg = writeConfig(root, main, 'keep_fresh = ["main"]');
  runWithConfig(
    root,
    cfg,
    `const m = await import(${WORKTREE_MOD}); await m.fetchOrigin();`,
  );

  // Fast-forward only. This runs unattended every few minutes; the one
  // thing it must never do is decide which copy of a diverged branch wins.
  expect(git(main, ["rev-parse", "main"])).toBe(localOnly);
  expect(git(main, ["rev-parse", "main"])).not.toBe(git(main, ["rev-parse", "origin/main"]));
});

test("a branch with no commits of its own counts 0 ahead through a stale clone ref", async () => {
  // The live failure: a rift clone had already pulled the commit (via a
  // merge-queue ref GitHub creates, `gh-readonly-queue/...`), the restack
  // rebased onto it correctly, but the clone's own `origin/staging`
  // never moved — so the row read "3 commits ahead" on a branch nobody
  // had started, and the destroy guards read the same 3 as work at risk.
  const { origin, seed } = buildOrigin();
  const root = tmp("wt-fo-root-sync-");
  const main = tmp("wt-fo-main-sync-");
  git(main, ["clone", "-q", "-b", "staging", origin, "."]);

  // The clone that plays the worktree, forked at the OLD staging tip.
  const wt = tmp("wt-fo-wt-");
  git(wt, ["clone", "-q", "-b", "staging", origin, "."]);
  git(wt, ["checkout", "-q", "-b", "feature"]);
  const stale = git(wt, ["rev-parse", "origin/staging"]);

  for (const msg of ["S2", "S3", "S4"]) {
    git(seed, ["commit", "-q", "--allow-empty", "-m", msg]);
  }
  git(seed, ["push", "-q", "origin", "staging"]);
  // The merge queue's ref: same commit, different name. Fetching it by
  // explicit refspec brings the OBJECT over without moving origin/staging.
  git(seed, ["push", "-q", "origin", "staging:refs/heads/gh-readonly-queue/staging/pr-1"]);
  git(main, ["fetch", "-q", "origin", "--prune"]);
  const fresh = git(main, ["rev-parse", "origin/staging"]);
  git(wt, [
    "fetch", "-q", "--no-tags", "origin",
    "+refs/heads/gh-readonly-queue/staging/pr-1:refs/remotes/origin/queued",
  ]);
  git(wt, ["reset", "--hard", "-q", fresh]);

  expect(git(wt, ["rev-parse", "origin/staging"])).toBe(stale);
  // What the checkout's own frame says, and what it would have reported.
  expect(git(wt, ["rev-list", "--count", "origin/staging..HEAD"])).toBe("3");

  const cfg = writeConfig(root, main, "");
  const out = runWithConfig(
    root,
    cfg,
    `const m = await import(${WORKTREE_MOD});
     const s = await m.syncState(${JSON.stringify(wt)});
     const p = await m.pushCounts(${JSON.stringify(wt)});
     console.log(JSON.stringify({ ahead: s.main.ahead, behind: s.main.behind, unpushed: p.unpushed }));`,
  );
  expect(JSON.parse(out.trim())).toEqual({ ahead: 0, behind: 0, unpushed: 0 });

  // Same frame error, a surface further away and much harder to spot:
  // the pre-PR row TITLE is the oldest commit in `base..HEAD`, so a
  // branch with nothing of its own titles itself with whichever trunk
  // commit it happens to be behind by — a colleague's work, rendered as
  // this row's, with nothing anywhere to say it is wrong. Measured live
  // on a row showing 0 files and 0 lines changed.
  expect(git(wt, ["log", "--reverse", "--format=%s", "origin/staging..HEAD"]).split("\n")[0]).toBe(
    "S2",
  );
  const title = runWithConfig(
    root,
    cfg,
    `const g = await import(${GIT_MOD});
     const base = await g.freshBaseRev(${JSON.stringify(wt)}, "origin/staging");
     console.log(JSON.stringify(await g.firstCommitSubject(${JSON.stringify(wt)}, base)));`,
  );
  expect(JSON.parse(title.trim())).toBeNull();
});

test("the BARE trunk name normalizes to the remote ref, not a frozen local branch", async () => {
  // What the fork-base record actually stores for an ordinary trunk
  // worktree is `baseBranch: "staging"`, and a clone made with
  // `clone -b staging` carries a LOCAL branch of that name. Nothing
  // ever moves it — the freshen above fast-forwards
  // `refs/remotes/origin/<trunk>` — so resolving to it measures the
  // branch against clone time forever. Live fleet: 15 of 15 rows, local
  // trunks 97 to 383 commits behind, nine of them titled with the same
  // colleague's commit.
  const { origin, seed } = buildOrigin();
  const root = tmp("wt-fo-root-bare-");
  const main = tmp("wt-fo-main-bare-");
  git(main, ["clone", "-q", "-b", "staging", origin, "."]);

  const wt = tmp("wt-fo-wt-bare-");
  git(wt, ["clone", "-q", "-b", "staging", origin, "."]);
  git(wt, ["checkout", "-q", "-b", "feature"]);
  const frozen = git(wt, ["rev-parse", "staging"]);

  for (const msg of ["S2", "S3"]) {
    git(seed, ["commit", "-q", "--allow-empty", "-m", msg]);
  }
  git(seed, ["push", "-q", "origin", "staging"]);
  git(main, ["fetch", "-q", "origin", "--prune"]);
  git(wt, ["fetch", "-q", "origin", "--prune"]);
  git(wt, ["reset", "--hard", "-q", "origin/staging"]);

  // The local branch is a clone-time artifact and stays put.
  expect(git(wt, ["rev-parse", "staging"])).toBe(frozen);
  expect(git(wt, ["rev-parse", "origin/staging"])).not.toBe(frozen);
  // Which is what makes resolving to it so expensive: a branch with
  // NOTHING of its own reads as two commits of somebody else's work,
  // and the oldest of them becomes this row's title.
  expect(git(wt, ["rev-list", "--count", "staging..HEAD"])).toBe("2");

  const cfg = writeConfig(root, main, "");
  const out = runWithConfig(
    root,
    cfg,
    `const g = await import(${GIT_MOD});
     const eff = await g.effectiveBaseOrTrunk(${JSON.stringify(wt)}, "staging");
     const title = await g.firstCommitSubject(${JSON.stringify(wt)}, await g.freshBaseRev(${JSON.stringify(wt)}, eff));
     console.log(JSON.stringify({ eff, title }));`,
  );
  expect(JSON.parse(out.trim())).toEqual({ eff: "origin/staging", title: null });
});

/**
 * The same staleness at its source: nothing was fetching INSIDE a rift
 * checkout, so its `origin/<trunk>` decayed from the moment it was
 * created — and every base-derived surface reads it, including the ones
 * no read-side substitution can reach (`{{base}}` handed to the diff
 * tool, and the agent's own `git log origin/<trunk>..HEAD`). Measured on
 * a live fleet: 17 of 18 checkouts stale across three generations.
 */
function riftCheckout(worktreeRoot: string, name: string, origin: string): string {
  mkdirSync(worktreeRoot, { recursive: true });
  const path = join(worktreeRoot, name);
  git(worktreeRoot, ["clone", "-q", "-b", "staging", origin, name]);
  writeFileSync(join(path, ".rift"), "");
  return path;
}

test("fetchOrigin advances a lagging checkout's own trunk ref", async () => {
  const { origin, seed } = buildOrigin();
  const root = tmp("wt-fo-root-fresh-");
  const main = tmp("wt-fo-main-fresh-");
  git(main, ["clone", "-q", "-b", "staging", origin, "."]);

  const wts = join(root, "wts");
  // `withObject` will already hold the commit (the merge-queue path);
  // `needsFetch` will not, so it exercises the local transfer instead.
  const withObject = riftCheckout(wts, "with-object", origin);
  const needsFetch = riftCheckout(wts, "needs-fetch", origin);
  const stale = git(withObject, ["rev-parse", "origin/staging"]);

  git(seed, ["commit", "-q", "--allow-empty", "-m", "S2"]);
  git(seed, ["push", "-q", "origin", "staging"]);
  git(seed, ["push", "-q", "origin", "staging:refs/heads/gh-readonly-queue/staging/pr-1"]);
  git(withObject, [
    "fetch", "-q", "--no-tags", "origin",
    "+refs/heads/gh-readonly-queue/staging/pr-1:refs/remotes/origin/queued",
  ]);

  expect(git(withObject, ["rev-parse", "origin/staging"])).toBe(stale);
  expect(git(needsFetch, ["rev-parse", "origin/staging"])).toBe(stale);

  const cfg = writeConfig(root, main, "");
  runWithConfig(
    root,
    cfg,
    `const m = await import(${WORKTREE_MOD}); await m.fetchOrigin();`,
  );

  const tip = git(main, ["rev-parse", "origin/staging"]);
  expect(tip).not.toBe(stale);
  expect(git(withObject, ["rev-parse", "origin/staging"])).toBe(tip);
  expect(git(needsFetch, ["rev-parse", "origin/staging"])).toBe(tip);
});

test("fetchOrigin never REWINDS a checkout that fetched for itself", async () => {
  // A clone runs its own `git fetch` too, so it can be ahead of the main
  // clone's last one. Moving its ref back is the same lie pointing the
  // other way, and it would flap every time the two interleave.
  const { origin, seed } = buildOrigin();
  const root = tmp("wt-fo-root-ahead-");
  const main = tmp("wt-fo-main-ahead-");
  git(main, ["clone", "-q", "-b", "staging", origin, "."]);

  const wt = riftCheckout(join(root, "wts"), "ahead", origin);
  git(seed, ["commit", "-q", "--allow-empty", "-m", "S2"]);
  git(seed, ["push", "-q", "origin", "staging"]);
  // Only the checkout fetches; the main clone is deliberately left behind
  // (`fetchOrigin` will catch it up, so pin the AHEAD-ness by sha).
  git(wt, ["fetch", "-q", "origin", "--prune"]);
  const ahead = git(wt, ["rev-parse", "origin/staging"]);
  expect(git(main, ["rev-parse", "origin/staging"])).not.toBe(ahead);

  const cfg = writeConfig(root, main, "");
  runWithConfig(
    root,
    cfg,
    `const m = await import(${WORKTREE_MOD}); await m.fetchOrigin();`,
  );

  expect(git(wt, ["rev-parse", "origin/staging"])).toBe(ahead);
});
