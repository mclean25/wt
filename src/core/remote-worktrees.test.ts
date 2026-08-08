import { describe, expect, test } from "bun:test";

import { parseRemoteWorktrees } from "./remote-worktrees.ts";

describe("parseRemoteWorktrees", () => {
  test("normalizes wt ls JSON with host identity", () => {
    const rows = parseRemoteWorktrees(JSON.stringify([{
      slug: "remote-test",
      branch: "alex/remote-test",
      path: "/home/alex/dev/client-app-worktrees/remote-test",
      stage: "alex-123",
      exists: true,
      status: "busy",
      status_label: "init: pnpm install",
      status_age: "2m",
      status_op: "init",
      dirty: false,
      unpushed: 2,
      issue_url: null,
    }]), "cachy");
    expect(rows[0]).toEqual({
      hostLabel: "cachy",
      slug: "remote-test",
      branch: "alex/remote-test",
      path: "/home/alex/dev/client-app-worktrees/remote-test",
      stage: "alex-123",
      exists: true,
      status: "busy",
      statusLabel: "init: pnpm install",
      statusAge: "2m",
      statusOp: "init",
      dirty: false,
      unpushed: 2,
      issueUrl: null,
      workState: null,
    });
  });

  test("defaults missing unpushed metadata for older remote binaries", () => {
    const [row] = parseRemoteWorktrees(JSON.stringify([{
      slug: "x", branch: "x", path: "/x", stage: "x", exists: true,
      status: "clean", status_label: "clean", dirty: false,
    }]), "cachy");
    expect(row).toMatchObject({ unpushed: 0, statusOp: null, workState: null });
  });

  test("parses a work state and drops unknown vocabulary", () => {
    const rows = parseRemoteWorktrees(JSON.stringify([
      {
        slug: "a", branch: "a", path: "/a", stage: "a", exists: true,
        status: "clean", status_label: "clean", dirty: false,
        work_state: "needs-human",
      },
      {
        slug: "b", branch: "b", path: "/b", stage: "b", exists: true,
        status: "clean", status_label: "clean", dirty: false,
        work_state: "from-the-future",
      },
    ]), "cachy");
    expect(rows[0]?.workState).toBe("needs-human");
    expect(rows[1]?.workState).toBeNull();
  });

  test("infers an init lock from older remote status labels", () => {
    const [row] = parseRemoteWorktrees(JSON.stringify([{
      slug: "x", branch: "x", path: "/x", stage: "x", exists: true,
      status: "busy", status_label: "init: pnpm install", dirty: false,
    }]), "cachy");
    expect(row?.statusOp).toBe("init");
  });

  test("rejects malformed status values", () => {
    expect(() => parseRemoteWorktrees(JSON.stringify([{
      slug: "x", branch: "x", path: "/x", stage: "x", exists: true,
      status: "wat", status_label: "wat", dirty: false,
    }]), "cachy")).toThrow("status is invalid");
  });

  test("tolerates login-shell banner noise around the JSON payload", () => {
    const payload = JSON.stringify([{
      slug: "x", branch: "x", path: "/x", stage: "x", exists: true,
      status: "clean", status_label: "clean", dirty: false, unpushed: 0,
    }], null, 2);
    const polluted = `Welcome to CachyOS!\ndirenv: loading .envrc\n${payload}\n`;
    const [row] = parseRemoteWorktrees(polluted, "cachy");
    expect(row?.slug).toBe("x");
  });

  test("gives a distinct diagnostic when stdout has no JSON at all", () => {
    expect(() => parseRemoteWorktrees("command not found: wt\n", "cachy")).toThrow(
      "did not return JSON",
    );
  });
});
