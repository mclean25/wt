import { describe, expect, test } from "bun:test";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  mergeConfig,
  repositoryConfigPath,
  REPOSITORY_CONFIG_ENV,
} from "./config-layer.ts";

describe("repositoryConfigPath", () => {
  test("finds the nearest .wt.toml above the invocation directory", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-config-layer-"));
    try {
      const nested = join(root, "src", "feature");
      mkdirSync(nested, { recursive: true });
      const path = join(root, ".wt.toml");
      writeFileSync(path, "[branch]\nbase = \"trunk\"\n");

      expect(repositoryConfigPath(nested, {})).toBe(path);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("prefers the inherited repository config path", () => {
    const path = join(tmpdir(), "selected-wt.toml");
    expect(repositoryConfigPath("/", { [REPOSITORY_CONFIG_ENV]: path })).toBe(path);
  });
});

describe("mergeConfig", () => {
  test("merges tables while replacing scalar values and arrays", () => {
    expect(mergeConfig(
      {
        paths: { main_clone: "/one", worktree_root: "/one-wt" },
        branch: { prefix: "alex", base: "main" },
        actions: [{ id: "global" }],
      },
      {
        paths: { main_clone: "/two" },
        branch: { base: "develop" },
        actions: [{ id: "local" }],
      },
    )).toEqual({
      paths: { main_clone: "/two", worktree_root: "/one-wt" },
      branch: { prefix: "alex", base: "develop" },
      actions: [{ id: "local" }],
    });
  });
});

describe("config loader integration", () => {
  test("builds config from user defaults plus repository overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-config-load-"));
    try {
      const repo = join(root, "repo");
      const nested = join(repo, "src");
      mkdirSync(nested, { recursive: true });
      const userConfig = join(root, "user.toml");
      writeFileSync(userConfig, `
[paths]
main_clone = "/global/repo"
worktree_root = "/global/worktrees"

[branch]
prefix = "alex"
base = "main"

[ui]
rows = ["branch", "git"]
`);
      writeFileSync(join(repo, ".wt.toml"), `
[paths]
main_clone = "/local/repo"

[branch]
base = "develop"

[lifecycle]
copy_globs = [".agents/**"]

[github]
reviewers = false
`);

      const configModule = pathToFileURL(join(import.meta.dir, "config.ts")).href;
      const badgesModule = pathToFileURL(join(import.meta.dir, "../tui/badges.ts")).href;
      const githubQueriesModule = pathToFileURL(
        join(import.meta.dir, "../state/queries/github.ts"),
      ).href;
      const script = `
        const { config } = await import(${JSON.stringify(configModule)});
        const { reviewBadge } = await import(${JSON.stringify(badgesModule)});
        const { githubQuery, reviewRequestsQuery } = await import(${JSON.stringify(githubQueriesModule)});
        console.log(JSON.stringify({
          paths: config.paths,
          branch: config.branch,
          lifecycle: config.lifecycle,
          github: config.github,
          rows: config.ui.rows,
          reviewerBadgeHidden: reviewBadge("unrequested") === null,
          githubEnabled: githubQuery(["feature"]).enabled,
          reviewRequestsEnabled: reviewRequestsQuery().enabled,
        }));
      `;
      const env: Record<string, string | undefined> = {
        ...process.env,
        WT_CONFIG: userConfig,
      };
      delete env[REPOSITORY_CONFIG_ENV];
      const result = Bun.spawnSync([process.execPath, "-e", script], {
        cwd: nested,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toMatchObject({
        paths: { mainClone: "/local/repo", worktreeRoot: "/global/worktrees" },
        branch: { prefix: "alex", base: "develop" },
        lifecycle: { copyGlobs: [".agents/**"] },
        github: { reviewers: false },
        rows: ["branch", "git"],
        reviewerBadgeHidden: true,
        githubEnabled: true,
        reviewRequestsEnabled: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects copy globs that can escape the main clone", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-config-copy-globs-"));
    try {
      const userConfig = join(root, "config.toml");
      writeFileSync(userConfig, `
[paths]
main_clone = "/repo"
worktree_root = "/worktrees"

[branch]
prefix = "alex"

[lifecycle]
copy_globs = ["/tmp/**", "../secrets/**"]
`);

      const configModule = pathToFileURL(join(import.meta.dir, "config.ts")).href;
      const env: Record<string, string | undefined> = {
        ...process.env,
        WT_CONFIG: userConfig,
      };
      delete env[REPOSITORY_CONFIG_ENV];
      const result = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(configModule)})`], {
        cwd: root,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr.toString()).toContain(
        "lifecycle.copy_globs entries must be relative paths without '..' segments",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
