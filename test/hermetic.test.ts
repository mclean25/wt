import { describe, expect, test } from "bun:test";

import { config } from "../src/core/config.ts";

/**
 * The guard on the guard. `test/preload.ts` is wired through
 * `bunfig.toml`, which is a file bun reads on our behalf — if a bun
 * upgrade, a stray `--preload` flag or a deleted line ever stops it
 * running, every test starts reading the machine's own
 * `~/.config/wt/config.toml` again and the suite goes back to passing
 * for its author and failing for CI. That regression is silent: nothing
 * fails at the moment it happens, only later and somewhere else.
 */
describe("suite config", () => {
  test("runs against an explicit config, never the machine's default", () => {
    expect(process.env.WT_CONFIG ?? "").not.toBe("");
  });

  test("that config names paths nothing can mistake for a real checkout", () => {
    // Not an existence check on purpose — a `run()` with no explicit cwd
    // must fail on a missing directory rather than answer about a live
    // repository, and `/tmp/wt-ci-fake-main` is the sentinel that says so.
    expect(config.paths.mainClone).toContain("fake");
  });
});
