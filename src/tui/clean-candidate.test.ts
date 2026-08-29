import { describe, expect, test } from "bun:test";

import { parseRemoteWorkerWorktrees } from "../core/remote-worktrees.ts";
import { DEV_SERVER_STOPPED } from "../core/dev-server.ts";
import { WORKER_PROTOCOL_VERSION } from "../core/worker-info.ts";
import {
  isRemoteCleanCandidate,
  remoteCleanHazardLabel,
} from "./clean-candidate.ts";

function remote(status: "merged" | "gone" | "busy" | "clean", dirty = false, unpushed = 0) {
  return parseRemoteWorkerWorktrees(
    JSON.stringify({
      protocol: WORKER_PROTOCOL_VERSION,
      worktrees: [
      {
        slug: "remote-row",
        branch: "alex/remote-row",
        base: "main",
        path: "/remote/row",
        stage: "remote-row",
        deployed: false,
        exists: true,
        status: { kind: status, label: status },
        dev: DEV_SERVER_STOPPED,
        dirty,
        unpushed,
        pushed: true,
        aheadOfBase: 1,
        issueId: null,
        issueUrl: null,
        githubIssue: null,
        githubIssueUrl: null,
        work: null,
      },
    ] }),
    "remote",
  )[0]!;
}

describe("isRemoteCleanCandidate", () => {
  test("includes merged and gone remote rows", () => {
    expect(isRemoteCleanCandidate(remote("merged"), false)).toBeTrue();
    expect(isRemoteCleanCandidate(remote("gone"), false)).toBeTrue();
  });

  test("includes a remote row whose PR merged without git-level containment", () => {
    expect(
      isRemoteCleanCandidate(remote("clean"), false, { state: "MERGED" }),
    ).toBeTrue();
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
