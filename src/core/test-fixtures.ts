/**
 * Shared plumbing for the git-fixture test suites (stack-ops, lifecycle):
 * a spawn-git helper with the sandboxed identity/config env every fixture
 * needs, and tmpdir tracking so scratch repos get swept in `afterAll`.
 * Deliberately named without a `.test.` infix — `bun test`'s glob would
 * otherwise pick this up and fail on "no tests found".
 */
import { afterAll } from "bun:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Sandboxed config + deterministic identity every fixture git call needs. */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

/**
 * Run `git <args>` in `cwd` with the fixture identity/config env, throwing
 * on nonzero exit. Returns raw (untrimmed) stdout — callers that need a
 * bare ref/sha trim it themselves; nothing here assumes single-line output.
 */
export function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(r.stderr)}`);
  }
  return new TextDecoder().decode(r.stdout);
}

/**
 * Register a tracked-tmpdir factory + `afterAll` sweep for one test file.
 * Call once per file (registers exactly one `afterAll`); each `tmp(prefix)`
 * call mkdtemps a fresh dir and queues it for removal once the suite ends.
 */
export function trackedTmpDirs(): { tmp: (prefix: string) => string } {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  return {
    tmp: (prefix: string): string => {
      const d = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(d);
      return d;
    },
  };
}
