import { beforeAll, expect, test } from "bun:test";

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { REPOSITORY_CONFIG_ENV } from "./config-layer.ts";
import { git, trackedTmpDirs } from "./test-fixtures.ts";

const { tmp } = trackedTmpDirs();

test("remove teardown keeps checkout-dependent cleanup before removal and browser cleanup after", () => {
  const source = readFileSync(join(import.meta.dir, "lifecycle.ts"), "utf8");
  const teardown = source.indexOf(
    "const destroyCommand = resolveTeardownCommand",
  );
  const reaper = source.indexOf("const reaped = yield* reapWorktreeListeners");
  const backend = source.indexOf("const removed = yield* backend.remove");
  const browser = source.indexOf(
    "const browser = yield* closeWorktreeBrowserSessions",
    backend,
  );
  expect(teardown).toBeGreaterThan(0);
  expect(reaper).toBeGreaterThan(teardown);
  expect(backend).toBeGreaterThan(reaper);
  expect(browser).toBeGreaterThan(backend);
}, 20_000);

let fixtureOrigin: string;

beforeAll(() => {
  const root = tmp("wt-lifecycle-origin-");
  fixtureOrigin = join(root, "origin.git");
  const seed = join(root, "seed");
  mkdirSync(fixtureOrigin);
  git(fixtureOrigin, ["init", "-q", "--bare"]);
  git(root, ["clone", "-q", fixtureOrigin, seed]);
  git(seed, ["checkout", "-q", "-b", "main"]);
  writeFileSync(join(seed, ".gitignore"), ".agents/\n.cache/\n");
  writeFileSync(join(seed, "README.md"), "fixture\n");
  git(seed, ["add", ".gitignore", "README.md"]);
  git(seed, ["commit", "-q", "-m", "fixture"]);
  git(seed, ["push", "-q", "-u", "origin", "main"]);
}, 20_000);

function lifecycleFixture() {
  const root = tmp("wt-lifecycle-");
  const main = join(root, "main");
  const worktrees = join(root, "worktrees");
  const configPath = join(root, "config.toml");
  git(root, ["clone", "-q", "--branch", "main", fixtureOrigin, main]);

  mkdirSync(join(main, ".agents", "skills", "example"), { recursive: true });
  writeFileSync(join(main, ".agents", "skills", "example", "SKILL.md"), "agent skill\n");
  mkdirSync(join(main, ".cache"));
  writeFileSync(join(main, ".cache", "private.txt"), "do not copy\n");
  const marker = (name: string) => join(root, name);
  writeFileSync(configPath, `
[paths]
main_clone = ${JSON.stringify(main)}
worktree_root = ${JSON.stringify(worktrees)}
log_dir = ${JSON.stringify(join(root, "logs"))}
lock_dir = ${JSON.stringify(join(root, "locks"))}
cache_db = ${JSON.stringify(join(root, "cache.sqlite"))}
state_db = ${JSON.stringify(join(root, "state.sqlite"))}

[branch]
prefix = "test"
base = "main"

[lifecycle]
env_files_to_copy = []
copy_globs = [".agents/**", ".git/**", "./.git/**"]
install_command = ${JSON.stringify(`touch ${marker("install-started")}; sleep 3; touch ${marker("install-finished")}`)}
`);

  const fakeBin = join(root, "bin");
  mkdirSync(fakeBin);
  const gitWrapper = join(fakeBin, "git");
  writeFileSync(gitWrapper, `#!/bin/sh
case "$*" in
  "worktree add "*backend-interrupted*) touch ${JSON.stringify(marker("backend-create-started"))}; exec sleep 3 ;;
  "worktree remove "*) touch ${JSON.stringify(marker("backend-remove-started"))}; exec sleep 3 ;;
esac
exec ${JSON.stringify(Bun.which("git")!)} "$@"
`);
  chmodSync(gitWrapper, 0o755);
  const pnpmWrapper = join(fakeBin, "pnpm");
  writeFileSync(pnpmWrapper, `#!/bin/sh
touch ${JSON.stringify(marker("sst-remove-started"))}
exec sleep 3
`);
  chmodSync(pnpmWrapper, 0o755);

  const env: Record<string, string | undefined> = {
    ...process.env,
    WT_CONFIG: configPath,
    PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "wt test",
    GIT_AUTHOR_EMAIL: "wt@example.test",
    GIT_COMMITTER_NAME: "wt test",
    GIT_COMMITTER_EMAIL: "wt@example.test",
  };
  delete env[REPOSITORY_CONFIG_ENV];
  const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(join(import.meta.dir, path)).href);
  const prelude = `
    const { Cause, Effect } = await import(${moduleUrl("../../node_modules/effect/dist/index.js")});
    const { createWorktree, removeWorktree } = await import(${moduleUrl("lifecycle.ts")});
    const { readWtState } = await import(${moduleUrl("wtstate.ts")});
    const { lockStatus } = await import(${moduleUrl("locks.ts")});
    const { existsSync } = await import("node:fs");
    const createOrFail = (branch, opts) => Effect.runPromise(createWorktree(branch, opts).pipe(
      Effect.catchTag("LifecycleError", (e) => Effect.succeed({ ok: false, reason: e.message })),
    ));
    const wasInterrupted = (exit) => exit._tag === "Failure" && Cause.hasInterrupts(exit.cause);
    const interruptAtMarker = async (operation, marker) => {
      const controller = new AbortController();
      const pending = Effect.runPromiseExit(operation, { signal: controller.signal });
      try {
        await Effect.runPromise(Effect.raceFirst(
          Effect.gen(function* () {
            while (!existsSync(marker)) yield* Effect.sleep(10);
          }),
          Effect.promise(() => pending).pipe(Effect.flatMap((exit) =>
            Effect.fail(new Error("operation completed before child marker " + marker + ": " + JSON.stringify(exit))),
          )),
        ));
        controller.abort();
        return await pending;
      } finally {
        controller.abort();
        await pending;
      }
    };
  `;
  const run = (script: string) => {
    const result = Bun.spawnSync([process.execPath, "-e", prelude + script], {
      cwd: root,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return JSON.parse(result.stdout.toString());
  };
  const checkout = (slug: string) => {
    const path = join(worktrees, slug);
    const branch = `test/${slug}`;
    git(main, ["worktree", "add", "--no-track", "-b", branch, path, "origin/main"]);
    return { slug, branch, path, stage: `test-${slug}`, isMain: false };
  };
  return { root, main, worktrees, marker, run, checkout };
}

test("createWorktree copies configured files and records successful creation", () => {
  const fixture = lifecycleFixture();
  expect(fixture.run(`
    const result = await createOrFail("test/copy-agents", { runInstall: false });
    console.log(JSON.stringify({
      result,
      created: typeof readWtState().slugs["copy-agents"]?.createdAt === "string",
      lock: lockStatus("copy-agents"),
    }));
  `)).toMatchObject({ result: { ok: true }, created: true, lock: null });
  const path = join(fixture.worktrees, "copy-agents");
  expect(readFileSync(join(path, ".agents", "skills", "example", "SKILL.md"), "utf8")).toBe("agent skill\n");
  expect(existsSync(join(path, ".cache", "private.txt"))).toBe(false);
  // The .git/** matches must not replace a linked checkout's .git pointer.
  expect(readFileSync(join(path, ".git"), "utf8")).toStartWith("gitdir: ");
}, 20_000);

test("createWorktree records attachment to an existing branch", () => {
  const fixture = lifecycleFixture();
  git(fixture.main, ["branch", "test/existing-branch"]);
  expect(fixture.run(`
    const result = await createOrFail("test/existing-branch", { runInstall: false });
    console.log(JSON.stringify({
      result,
      created: typeof readWtState().slugs["existing-branch"]?.createdAt === "string",
      lock: lockStatus("existing-branch"),
    }));
  `)).toMatchObject({ result: { ok: true }, created: true, lock: null });
}, 20_000);

test("createWorktree releases its lock and records no creation for a bad base", () => {
  const fixture = lifecycleFixture();
  expect(fixture.run(`
    const result = await createOrFail("test/bad-base", {
      runInstall: false,
      base: "missing-ref-that-does-not-exist",
    });
    console.log(JSON.stringify({ result, created: Boolean(readWtState().slugs["bad-base"]?.createdAt), lock: lockStatus("bad-base") }));
  `)).toMatchObject({ result: { ok: false }, created: false, lock: null });
}, 20_000);

test("createWorktree releases its lock when cancelled during preflight", () => {
  const fixture = lifecycleFixture();
  expect(fixture.run(`
    const controller = new AbortController();
    const exit = await Effect.runPromiseExit(createWorktree("test/interrupted", {
      runInstall: false,
      onPhase: () => controller.abort(),
    }), { signal: controller.signal });
    console.log(JSON.stringify({ interrupted: wasInterrupted(exit), lock: lockStatus("interrupted") }));
  `)).toEqual({ interrupted: true, lock: null });
  expect(existsSync(join(fixture.worktrees, "interrupted"))).toBe(false);
}, 20_000);

test("createWorktree cancels a running backend child without recording creation", () => {
  const fixture = lifecycleFixture();
  const marker = fixture.marker("backend-create-started");
  expect(fixture.run(`
    const exit = await interruptAtMarker(createWorktree("test/backend-interrupted", { runInstall: false }), ${JSON.stringify(marker)});
    console.log(JSON.stringify({ interrupted: wasInterrupted(exit), created: Boolean(readWtState().slugs["backend-interrupted"]?.createdAt), lock: lockStatus("backend-interrupted") }));
  `)).toEqual({ interrupted: true, created: false, lock: null });
  expect(existsSync(marker)).toBe(true);
  expect(existsSync(join(fixture.worktrees, "backend-interrupted"))).toBe(false);
}, 20_000);

test("createWorktree cancels a running install without recording creation", () => {
  const fixture = lifecycleFixture();
  const marker = fixture.marker("install-started");
  expect(fixture.run(`
    const exit = await interruptAtMarker(createWorktree("test/install-interrupted"), ${JSON.stringify(marker)});
    console.log(JSON.stringify({ interrupted: wasInterrupted(exit), created: Boolean(readWtState().slugs["install-interrupted"]?.createdAt), lock: lockStatus("install-interrupted") }));
  `)).toEqual({ interrupted: true, created: false, lock: null });
  expect(existsSync(marker)).toBe(true);
  expect(existsSync(fixture.marker("install-finished"))).toBe(false);
}, 20_000);

test("removeWorktree cancels its backend child and preserves the checkout", () => {
  const fixture = lifecycleFixture();
  const checkout = fixture.checkout("remove-interrupted");
  const marker = fixture.marker("backend-remove-started");
  expect(fixture.run(`
    const exit = await interruptAtMarker(removeWorktree(${JSON.stringify(checkout)}, {}), ${JSON.stringify(marker)});
    console.log(JSON.stringify({ interrupted: wasInterrupted(exit), lock: lockStatus("remove-interrupted") }));
  `)).toEqual({ interrupted: true, lock: null });
  expect(existsSync(marker)).toBe(true);
  expect(existsSync(checkout.path)).toBe(true);
}, 20_000);

test("removeWorktree cancels its SST child and preserves the checkout", () => {
  const fixture = lifecycleFixture();
  const checkout = fixture.checkout("sst-interrupted");
  mkdirSync(join(checkout.path, ".sst"), { recursive: true });
  writeFileSync(join(checkout.path, ".sst", "stage"), "test-owned\n");
  const marker = fixture.marker("sst-remove-started");
  expect(fixture.run(`
    const exit = await interruptAtMarker(removeWorktree(${JSON.stringify(checkout)}, { destroyStage: true }), ${JSON.stringify(marker)});
    console.log(JSON.stringify({ interrupted: wasInterrupted(exit), lock: lockStatus("sst-interrupted") }));
  `)).toEqual({ interrupted: true, lock: null });
  expect(existsSync(marker)).toBe(true);
  expect(existsSync(checkout.path)).toBe(true);
}, 20_000);
