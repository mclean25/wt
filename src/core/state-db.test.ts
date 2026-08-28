import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const WTSTATE = JSON.stringify(pathToFileURL(join(import.meta.dir, "wtstate.ts")).href);

function run(cwd: string, userConfig: string, script: string) {
  const env: Record<string, string | undefined> = { ...process.env, WT_CONFIG: userConfig };
  delete env.WT_REPO_CONFIG;
  return Bun.spawnSync([process.execPath, "-e", script], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function writeRepoConfig(path: string, main: string, stateDb: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, ".wt.toml"), `
[paths]
main_clone = ${JSON.stringify(main)}
worktree_root = ${JSON.stringify(`${main}-worktrees`)}
cache_db = ${JSON.stringify(join(path, ".cache", "cache.sqlite"))}
state_db = ${JSON.stringify(stateDb)}

[tmux]
socket = ${JSON.stringify(`wt-test-${path.replace(/[^a-z0-9]/gi, "-")}`)}
`);
}

test("one database isolates repository state by path-derived id", () => {
  const root = mkdtempSync(join(tmpdir(), "wt-state-db-"));
  roots.push(root);
  const db = join(root, "state", "wt.sqlite");
  const user = join(root, "config.toml");
  writeFileSync(user, "[branch]\nprefix = \"test\"\n");
  const one = join(root, "one");
  const two = join(root, "two");
  writeRepoConfig(one, one, db);
  writeRepoConfig(two, two, db);

  const firstWrite = run(one, user, `
    const state = await import(${WTSTATE});
    state.setSlugSection("shared-slug", "one-section");
  `);
  expect(firstWrite.exitCode, firstWrite.stderr.toString()).toBe(0);
  const secondWrite = run(two, user, `
    const state = await import(${WTSTATE});
    state.setSlugSection("shared-slug", "two-section");
  `);
  expect(secondWrite.exitCode, secondWrite.stderr.toString()).toBe(0);

  const firstRead = run(one, user, `
    const state = await import(${WTSTATE});
    console.log(state.readWtState().slugs["shared-slug"].section);
  `);
  expect(firstRead.exitCode, firstRead.stderr.toString()).toBe(0);
  expect(firstRead.stdout.toString().trim()).toBe("one-section");
});

test("a namespace collision refuses the second canonical repository path", () => {
  const root = mkdtempSync(join(tmpdir(), "wt-state-collision-"));
  roots.push(root);
  const db = join(root, "state.sqlite");
  const user = join(root, "config.toml");
  writeFileSync(user, "[branch]\nprefix = \"test\"\n");
  const flat = join(root, "a-b");
  const nested = join(root, "a", "b");
  writeRepoConfig(flat, flat, db);
  writeRepoConfig(nested, nested, db);

  const first = run(flat, user, `
    const state = await import(${WTSTATE});
    state.readWtState();
  `);
  expect(first.exitCode, first.stderr.toString()).toBe(0);
  const second = run(nested, user, `
    const state = await import(${WTSTATE});
    state.readWtState();
  `);
  expect(second.exitCode).not.toBe(0);
  expect(second.stderr.toString()).toContain("repository namespace collision");
});
