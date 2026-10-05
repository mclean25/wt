import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { appendRiftWorktrees } from "./worktree.ts";
import type { LockMeta, Worktree } from "./types.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRiftRoot(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "wt-rift-inventory-"));
  roots.push(root);
  const path = join(root, "stage-coz-1234-task");
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(join(path, ".rift"), "rift\n");
  return { root, path };
}

function discover(
  root: string,
  lock: Partial<LockMeta> | null,
): Worktree[] {
  const rows: Worktree[] = [];
  appendRiftWorktrees(rows, root, () => lock);
  return rows;
}

function runWithConfig(root: string, configPath: string): string {
  const worktree = join(root, "wts", "stage-coz-1234-task");
  const locks = join(root, "locks");
  const script = `
    const { config } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "config.ts")).href)});
    const { appendRiftWorktrees } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "worktree.ts")).href)});
    const { tryAcquireLock } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "locks.ts")).href)});
    const root = ${JSON.stringify(join(root, "wts"))};
    const path = ${JSON.stringify(worktree)};
    const slug = "stage-coz-1234-task";
    const head = path + "/.git/HEAD";
    const rows = () => { const result = []; appendRiftWorktrees(result); return result; };
    const result = { before: rows().length };
    const status = tryAcquireLock(slug, "status", { phase: "checking" });
    result.statusLock = rows().length;
    status.release();
    const create = tryAcquireLock(slug, "init", { phase: "creating worktree (rift)" });
    result.createLock = rows().length;
    await Bun.write(head, "ref: refs/heads/stage/coz-1234-task\\n");
    result.branchfulCreateLock = rows().length;
    create.release();
    result.released = rows().length;
    await Bun.write(${JSON.stringify(join(locks, "stage-coz-1234-task.lock"))}, JSON.stringify({ op: "init", phase: "stale" }));
    result.staleLockFile = rows().length;
    console.log(JSON.stringify(result));
  `;
  const run = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: root,
    env: {
      ...process.env,
      WT_CONFIG: configPath,
      WT_REPO_CONFIG: "",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  return run.stdout.toString();
}

test("rift inventory withholds live creates and reveals them after release", () => {
  const { root, path } = makeRiftRoot();
  writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/stage/coz-1234-task\n");

  // The cross-process lock stays held after HEAD becomes branchful, through
  // config copying and the final create bookkeeping.
  expect(discover(root, { op: "init", phase: "creating worktree (rift)" })).toEqual([]);

  // flock is held before its JSON metadata is first written. lockStatus can
  // return an empty live record in that tiny acquire window, while HEAD is
  // still detached; conservative branchless suppression covers it.
  writeFileSync(join(path, ".git", "HEAD"), "d34db33f\n");
  expect(discover(root, {})).toEqual([]);

  // Once the holder releases the flock, lockStatus returns null (including
  // for a stale file left by a dead process) and the real row is discoverable.
  writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/stage/coz-1234-task\n");
  const rows = discover(root, null);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    slug: "stage-coz-1234-task",
    branch: "stage/coz-1234-task",
    path,
    isMain: false,
  });
});

test("an unrelated live lock does not hide an established rift row", () => {
  const { root, path } = makeRiftRoot();
  writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/stage/coz-1234-task\n");

  expect(discover(root, { op: "status", phase: "checking" })).toHaveLength(1);
});

test("real create flock withholds Rift rows until release and ignores stale files", () => {
  const root = mkdtempSync(join(tmpdir(), "wt-rift-lock-inventory-"));
  roots.push(root);
  const worktreeRoot = join(root, "wts");
  const path = join(worktreeRoot, "stage-coz-1234-task");
  mkdirSync(join(path, ".git"), { recursive: true });
  mkdirSync(join(root, "locks"), { recursive: true });
  writeFileSync(join(path, ".rift"), "rift\n");
  writeFileSync(join(path, ".git", "HEAD"), "ref: refs/heads/stage/coz-1234-task\n");
  const configPath = join(root, "config.toml");
  writeFileSync(configPath, `
[paths]
main_clone = ${JSON.stringify(join(root, "main"))}
worktree_root = ${JSON.stringify(worktreeRoot)}
log_dir = ${JSON.stringify(join(root, "logs"))}
lock_dir = ${JSON.stringify(join(root, "locks"))}
cache_db = ${JSON.stringify(join(root, "cache", "cache.sqlite"))}
state_db = ${JSON.stringify(join(root, "state", "wt.sqlite"))}

[branch]
prefix = "stage"
base = "main"
`);

  const result = JSON.parse(runWithConfig(root, configPath)) as Record<string, number>;
  expect(result).toEqual({
    before: 1,
    statusLock: 1,
    createLock: 0,
    branchfulCreateLock: 0,
    released: 1,
    staleLockFile: 1,
  });
});
