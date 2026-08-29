import { describe, expect, test } from "bun:test";

import { DEV_SERVER_STOPPED } from "./dev-server.ts";
import { parseRemoteWorkerWorktrees } from "./remote-worktrees.ts";
import { WORKER_PROTOCOL_VERSION } from "./worker-info.ts";

function row(extra: Record<string, unknown> = {}) {
  return {
    slug: "remote-test",
    branch: "alex/remote-test",
    base: "main",
    path: "/home/alex/dev/worktrees/remote-test",
    stage: "remote-test",
    deployed: false,
    exists: true,
    status: { kind: "clean", label: "clean" },
    dev: DEV_SERVER_STOPPED,
    dirty: false,
    unpushed: 0,
    pushed: true,
    aheadOfBase: 1,
    issueId: null,
    issueUrl: null,
    githubIssue: null,
    githubIssueUrl: null,
    work: null,
    ...extra,
  };
}

function payload(rows: unknown[], protocol = WORKER_PROTOCOL_VERSION): string {
  return JSON.stringify({ protocol, worktrees: rows });
}

describe("parseRemoteWorkerWorktrees", () => {
  test("adds endpoint identity without changing the execution snapshot", () => {
    const [parsed] = parseRemoteWorkerWorktrees(
      payload([row({
        status: { kind: "busy", label: "init: pnpm install", age: "2m", op: "init" },
        unpushed: 2,
      })]),
      "Cachy",
      "cachy.internal",
    );
    expect(parsed).toMatchObject({
      remote: {
        host: "cachy.internal",
        label: "Cachy",
        wtPath: "~/.wt/bin/wt",
      },
      hostKey: "cachy.internal",
      hostLabel: "Cachy",
      section: null,
      slug: "remote-test",
      status: { kind: "busy", label: "init: pnpm install", age: "2m", op: "init" },
      unpushed: 2,
    });
  });

  test("carries nested lifecycle and dev-server state as one snapshot", () => {
    const [parsed] = parseRemoteWorkerWorktrees(payload([row({
      dev: {
        running: false,
        starting: true,
        crashed: false,
        port: 4312,
        url: null,
        since: 123,
        waiting: { rank: 2, since: 100 },
        rebasedSince: false,
        restarts: { count: 1, lastExit: 75 },
      },
      work: {
        state: "needs-human",
        at: "2026-08-28T12:00:00.000Z",
        note: "login required",
      },
    })]), "cachy");
    expect(parsed?.dev).toMatchObject({
      starting: true,
      port: 4312,
      waiting: { rank: 2, since: 100 },
      restarts: { count: 1, lastExit: 75 },
    });
    expect(parsed?.work).toMatchObject({
      state: "needs-human",
      note: "login required",
    });
  });

  test("rejects a mismatched protocol before interpreting rows", () => {
    expect(() => parseRemoteWorkerWorktrees(payload([row()], 1), "cachy")).toThrow(
      "uses protocol 1",
    );
  });

  test("rejects malformed required status and dev state", () => {
    expect(() => parseRemoteWorkerWorktrees(
      payload([row({ status: { kind: "future", label: "future" } })]),
      "cachy",
    )).toThrow("status.kind is invalid");
    expect(() => parseRemoteWorkerWorktrees(
      payload([row({ dev: { running: "yes" } })]),
      "cachy",
    )).toThrow("dev.running is invalid");
  });

  test("tolerates login-shell banner noise around the object", () => {
    const noisy = `Welcome to CachyOS!\ndirenv: loading .envrc\n${payload([row()])}\n`;
    expect(parseRemoteWorkerWorktrees(noisy, "cachy")[0]?.slug).toBe("remote-test");
  });

  test("gives a distinct diagnostic when stdout has no JSON", () => {
    expect(() => parseRemoteWorkerWorktrees("command not found: wt\n", "cachy")).toThrow(
      "did not return JSON",
    );
  });
});
