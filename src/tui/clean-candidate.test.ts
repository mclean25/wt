import { describe, expect, test } from "bun:test";

import { parseRemoteWorktrees } from "../core/remote-worktrees.ts";
import {
  isRemoteCleanCandidate,
  remoteCleanHazardLabel,
} from "./clean-candidate.ts";

function remote(status: string, dirty = false, unpushed = 0) {
  return parseRemoteWorktrees(
    JSON.stringify([
      {
        slug: "remote-row",
        branch: "alex/remote-row",
        path: "/remote/row",
        stage: "remote-row",
        exists: true,
        status,
        status_label: status,
        dirty,
        unpushed,
      },
    ]),
    "remote",
  )[0]!;
}

describe("isRemoteCleanCandidate", () => {
  test("includes merged and gone remote rows", () => {
    expect(isRemoteCleanCandidate(remote("merged"), false)).toBeTrue();
    expect(isRemoteCleanCandidate(remote("gone"), false)).toBeTrue();
  });

  test("excludes archived, busy, and active remote rows", () => {
    expect(isRemoteCleanCandidate(remote("merged"), true)).toBeFalse();
    expect(isRemoteCleanCandidate(remote("busy"), false)).toBeFalse();
    expect(isRemoteCleanCandidate(remote("clean"), false)).toBeFalse();
  });

  test("reports remote cleanup hazards", () => {
    expect(remoteCleanHazardLabel(remote("merged"))).toBeNull();
    expect(remoteCleanHazardLabel(remote("merged", true))).toBe(
      "uncommitted changes",
    );
    expect(remoteCleanHazardLabel(remote("gone", false, 2))).toBe(
      "2 unpushed commits",
    );
  });
});
