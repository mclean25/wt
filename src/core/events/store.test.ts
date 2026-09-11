import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { buildSha } from "../build-id.ts";
import {
  EVENTS_DIR,
  SNAPSHOT_PATH,
  runningDaemonHasForeignBuild,
  snapshotForBranches,
  writeSnapshot,
  type GithubSnapshot,
} from "./store.ts";

/**
 * The daemon hands the TUI PARSED data, so a snapshot carries the writing
 * build's parsing rules with it — and the writer is a launchd agent that
 * stays up across every hot update. Two live badges were wrong for days
 * because of exactly that: a daemon from Aug 19 overrode a TUI holding
 * both of the fixes it lacked.
 *
 * These write into the suite's own cache root (`test/config.toml`
 * relocates `cache_db`), never the real `~/.cache/wt/events`.
 */
describe("snapshotForBranches build gate", () => {
  const base = (writerSha: string | null | undefined): GithubSnapshot => ({
    updatedAt: Date.now(),
    branches: ["feat/a"],
    prs: {},
    mergeQueue: {},
    ...(writerSha === undefined ? {} : { writerSha }),
  });

  afterAll(() => {
    rmSync(SNAPSHOT_PATH, { force: true });
    rmSync(EVENTS_DIR, { recursive: true, force: true });
  });

  test("a snapshot from this build is served", () => {
    writeSnapshot(base(buildSha()));
    expect(snapshotForBranches(["feat/a"])).not.toBeNull();
  });

  test("a snapshot from another build is refused", () => {
    writeSnapshot(base("0".repeat(40)));
    expect(snapshotForBranches(["feat/a"])).toBeNull();
  });

  test("an UNSTAMPED snapshot is refused — that is the shape the bug had", () => {
    // Every daemon predating the stamp writes this, and it is precisely
    // the population whose parse cannot be trusted. Failing open here
    // would make the whole gate a no-op for the only build it targets.
    writeSnapshot(base(undefined));
    expect(snapshotForBranches(["feat/a"])).toBeNull();
  });

  test("staleness still wins over a matching build", () => {
    writeSnapshot({ ...base(buildSha()), updatedAt: Date.now() - 10 * 60_000 });
    expect(snapshotForBranches(["feat/a"])).toBeNull();
  });

  test("an uncovered branch still falls back, matching build or not", () => {
    writeSnapshot(base(buildSha()));
    expect(snapshotForBranches(["feat/a", "feat/b"])).toBeNull();
  });
});

describe("runningDaemonHasForeignBuild", () => {
  const state = {
    pid: 42,
    port: 8765,
    writerSha: "current",
    startedAt: 1,
    lastEventAt: null,
    lastFetchAt: null,
    eventCount: 0,
    lastError: null,
  };

  test("does not blame a current daemon for its predecessor's leftover snapshot", () => {
    expect(runningDaemonHasForeignBuild(state, () => true, (sha) => sha === "current")).toBe(false);
  });

  test("detects a live daemon that really is on another build", () => {
    expect(runningDaemonHasForeignBuild(
      { ...state, writerSha: "old" },
      () => true,
      (sha) => sha === "current",
    )).toBe(true);
  });

  test("does not describe a stopped or missing daemon as running", () => {
    expect(runningDaemonHasForeignBuild(
      { ...state, writerSha: "old" },
      () => false,
      (sha) => sha === "current",
    )).toBe(false);
    expect(runningDaemonHasForeignBuild(null, () => true, () => false)).toBe(false);
  });
});
