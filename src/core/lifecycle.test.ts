import { afterAll, expect, test } from "bun:test";

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { REPOSITORY_CONFIG_ENV } from "./config-layer.ts";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "wt test",
      GIT_AUTHOR_EMAIL: "wt@example.test",
      GIT_COMMITTER_NAME: "wt test",
      GIT_COMMITTER_EMAIL: "wt@example.test",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
}

test("createWorktree copies configured glob matches from the main clone", () => {
  const root = mkdtempSync(join(tmpdir(), "wt-copy-globs-"));
  dirs.push(root);
  const origin = join(root, "origin.git");
  const main = join(root, "main");
  const worktrees = join(root, "worktrees");
  const configPath = join(root, "config.toml");

  mkdirSync(origin);
  git(origin, ["init", "-q", "--bare"]);
  git(root, ["clone", "-q", origin, main]);
  git(main, ["checkout", "-q", "-b", "main"]);
  writeFileSync(join(main, ".gitignore"), ".agents/\n.cache/\n");
  writeFileSync(join(main, "README.md"), "fixture\n");
  git(main, ["add", ".gitignore", "README.md"]);
  git(main, ["commit", "-q", "-m", "fixture"]);
  git(main, ["push", "-q", "-u", "origin", "main"]);

  const skill = join(main, ".agents", "skills", "example", "SKILL.md");
  mkdirSync(join(main, ".agents", "skills", "example"), { recursive: true });
  writeFileSync(skill, "agent skill\n");
  mkdirSync(join(main, ".cache"), { recursive: true });
  writeFileSync(join(main, ".cache", "private.txt"), "do not copy\n");

  writeFileSync(configPath, `
[paths]
main_clone = ${JSON.stringify(main)}
worktree_root = ${JSON.stringify(worktrees)}
log_dir = ${JSON.stringify(join(root, "logs"))}
lock_dir = ${JSON.stringify(join(root, "locks"))}
cache_db = ${JSON.stringify(join(root, "cache.sqlite"))}

[branch]
prefix = "test"
base = "main"

[lifecycle]
env_files_to_copy = []
copy_globs = [".agents/**", ".git/**", "./.git/**"]
`);

  const lifecycleModule = pathToFileURL(join(import.meta.dir, "lifecycle.ts")).href;
  const script = `
    const { createWorktree } = await import(${JSON.stringify(lifecycleModule)});
    const result = await createWorktree("test/copy-agents", { runInstall: false });
    console.log(JSON.stringify(result));
  `;
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
  delete env[REPOSITORY_CONFIG_ENV];
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ ok: true });
  const copied = join(worktrees, "copy-agents", ".agents", "skills", "example", "SKILL.md");
  expect(readFileSync(copied, "utf8")).toBe("agent skill\n");
  expect(existsSync(join(worktrees, "copy-agents", ".cache", "private.txt"))).toBe(false);
});
