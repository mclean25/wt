import { expect, test } from "bun:test";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { REPOSITORY_CONFIG_ENV } from "./config-layer.ts";
import { git, trackedTmpDirs } from "./test-fixtures.ts";
import { resolveDestroyCommand } from "./lifecycle.ts";

const { tmp } = trackedTmpDirs();

test("createWorktree copies configured glob matches from the main clone", () => {
  const root = tmp("wt-copy-globs-");
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

// --- [lifecycle] destroy_command -------------------------------------------

test("resolveDestroyCommand substitutes path, slug and port", () => {
  expect(
    resolveDestroyCommand("teardown {{slug}} in {{path}} on {{port}}", {
      path: "/wt/thing",
      slug: "thing",
      port: 8103,
    }),
  ).toBe("teardown thing in /wt/thing on 8103");
});

test("resolveDestroyCommand substitutes every occurrence, not just the first", () => {
  expect(
    resolveDestroyCommand("a {{slug}} b {{slug}}", { path: "/p", slug: "s", port: null }),
  ).toBe("a s b s");
});

test("resolveDestroyCommand returns null when nothing is configured", () => {
  expect(resolveDestroyCommand(null, { path: "/p", slug: "s", port: 8100 })).toBeNull();
});

// A worktree with no recorded port never started a dev server, so the
// resources a port-derived teardown targets were never created. Running
// the command with an empty substitution would be the worse answer: it
// hands the shell a command with a hole in it.
test("resolveDestroyCommand skips a port-dependent command when no port was allocated", () => {
  expect(
    resolveDestroyCommand("docker stop stack-{{port}}", { path: "/p", slug: "s", port: null }),
  ).toBeNull();
});

test("resolveDestroyCommand still runs a port-independent command with no port", () => {
  expect(
    resolveDestroyCommand("docker rm -f {{slug}}", { path: "/p", slug: "s", port: null }),
  ).toBe("docker rm -f s");
});
