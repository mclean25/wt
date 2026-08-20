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
});
