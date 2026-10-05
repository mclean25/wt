import { expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { git, trackedTmpDirs } from "../test-fixtures.ts";

const { tmp } = trackedTmpDirs();

function fixture(dirty: boolean) {
  const root = tmp("wt-rift-index-");
  const main = join(root, "main");
  const path = join(root, "copy");
  const bin = join(root, "bin");
  mkdirSync(main);
  mkdirSync(bin);
  git(main, ["init", "-q", "-b", "main"]);
  writeFileSync(join(main, ".gitignore"), ".rift\n");
  writeFileSync(join(main, ".rift"), "fixture");
  writeFileSync(join(main, "unchanged"), "same contents\n");
  writeFileSync(join(main, "modified"), "committed\n");
  git(main, ["add", "."]);
  git(main, ["commit", "-qm", "base"]);
  git(main, ["branch", "existing"]);
  if (dirty) writeFileSync(join(main, "modified"), "local changes\n");
  // Model the copied tree/index before rift's branch materialization. It has
  // the source index but fresh file metadata, including on unchanged files.
  cpSync(main, path, { recursive: true });
  writeFileSync(join(path, ".git", "HEAD"), `${git(main, ["rev-parse", "HEAD"]).trim()}\n`);
  utimesSync(join(path, "unchanged"), 946684800, 946684800);
  const before = statSync(join(path, "unchanged"));
  // The filesystem copy is already prepared; exercise the production backend
  // with real Git, without needing a globally installed rift or registry.
  writeFileSync(join(bin, "rift"), '#!/bin/sh\nprintf "%s\\n" "$RIFT_FIXTURE_PATH"\n');
  chmodSync(join(bin, "rift"), 0o755);
  const config = join(root, "config.toml");
  writeFileSync(config, `
[paths]
main_clone = ${JSON.stringify(main)}
worktree_root = ${JSON.stringify(root)}
log_dir = ${JSON.stringify(join(root, "logs"))}
lock_dir = ${JSON.stringify(join(root, "locks"))}
cache_db = ${JSON.stringify(join(root, "cache.sqlite"))}
state_db = ${JSON.stringify(join(root, "state.sqlite"))}
[branch]
prefix = "test"
base = "main"
`);
  const url = (relative: string) => JSON.stringify(pathToFileURL(join(import.meta.dir, relative)).href);
  const run = async (baseRef: string | null) => {
    const branch = baseRef === null ? "existing" : "test/new";
    const child = Bun.spawn(["bun", "-e", `
      import { Effect } from ${url("../../../node_modules/effect/dist/index.js")};
      import { createRiftWorktree } from ${url("rift.ts")};
      await Effect.runPromise(createRiftWorktree(${JSON.stringify({
        path, branch, slug: "copy", baseRef, mainClone: main,
      })}));
    `], {
      cwd: root,
      env: {
        ...process.env,
        WT_CONFIG: config,
        WT_REPO_CONFIG: config,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RIFT_FIXTURE_PATH: path,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exit, stderr).toBe(0);
    expect(git(path, ["branch", "--show-current"]).trim()).toBe(branch);
  };
  return { main, path, before, run };
}

test("a new Rift branch retains unchanged files instead of rewriting the copied tree", async () => {
  const f = fixture(false);
  await f.run("main");
  const after = statSync(join(f.path, "unchanged"));
  expect(after.mtimeMs).toBe(f.before.mtimeMs);
  expect(after.ino).toBe(f.before.ino);
  expect(git(f.path, ["status", "--porcelain"]).trim()).toBe("");
}, 10_000);

test("attaching a branch accepts dirty-index refresh and discards only the copied edits", async () => {
  const f = fixture(true);
  await f.run(null);
  expect(statSync(join(f.path, "unchanged")).mtimeMs).toBe(f.before.mtimeMs);
  expect(readFileSync(join(f.path, "modified"), "utf8")).toBe("committed\n");
  expect(readFileSync(join(f.main, "modified"), "utf8")).toBe("local changes\n");
  expect(git(f.path, ["status", "--porcelain"]).trim()).toBe("");
}, 10_000);
