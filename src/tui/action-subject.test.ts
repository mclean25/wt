import { describe, expect, test } from "bun:test";

import type { RemoteWorktreeSummary } from "../core/remote-worktrees.ts";
import { StatusKind, type PullRequest } from "../core/types.ts";
import {
  localWorktreeTarget,
  remoteWorktreeTarget,
} from "../core/worktree-target.ts";
import type { GithubData } from "../state/queries/github.ts";
import {
  actionSubjectVars,
  resolveActionSubject,
} from "./action-subject.ts";
import type { WorktreeRow } from "./hooks/useWorktreeRows.ts";

const pr = { number: 42 } as PullRequest;

function localRow(): WorktreeRow {
  return {
    wt: {
      slug: "same-task",
      branch: "alex/same-task",
      path: "/local/same-task",
      stage: "same-task",
    },
    issueId: "COZ-42",
    pr,
    mq: undefined,
    status: { kind: StatusKind.Clean, label: "clean" },
    fields: {
      deploy: { data: true },
      dev: { data: { running: true } },
    },
  } as WorktreeRow;
}

function remoteRow(): RemoteWorktreeSummary {
  return {
    remote: { host: "dellserver", label: "Dell server", wtPath: "~/bin/wt" },
    hostKey: "dellserver",
    hostLabel: "Dell server",
    slug: "same-task",
    branch: "alex/same-task",
    base: "main",
    path: "/remote/same-task",
    stage: "same-task",
    deployed: true,
    section: null,
    exists: true,
    status: StatusKind.Clean,
    statusLabel: "clean",
    statusAge: null,
    statusOp: null,
    dirty: false,
    unpushed: 0,
    pushed: true,
    aheadOfBase: 1,
    issueUrl: null,
    issueId: "COZ-42",
    workState: null,
    workNote: null,
    workRisk: null,
    workBlockedOn: null,
    workVerifyAfterMerge: null,
    workAt: null,
  };
}

describe("resolveActionSubject", () => {
  test("normalizes local and remote rows to the same action metadata", () => {
    const local = localRow();
    const remote = remoteRow();
    const github = { prs: { [remote.branch]: pr }, mergeQueue: {} } as GithubData;
    const localSubject = resolveActionSubject(
      localWorktreeTarget(local.wt),
      [local],
      [remote],
      github,
    )!;
    remote.stage = localSubject.stage;
    const remoteSubject = resolveActionSubject(
      remoteWorktreeTarget(remote),
      [local],
      [remote],
      github,
    )!;

    expect({
      slug: remoteSubject.slug,
      branch: remoteSubject.branch,
      stage: remoteSubject.stage,
      issueId: remoteSubject.issueId,
      pr: remoteSubject.pr,
      deployed: remoteSubject.deployed,
      status: remoteSubject.status,
    }).toEqual({
      slug: localSubject.slug,
      branch: localSubject.branch,
      stage: localSubject.stage,
      issueId: localSubject.issueId,
      pr: localSubject.pr,
      deployed: localSubject.deployed,
      status: localSubject.status,
    });
    expect(remoteSubject.actionKey).not.toBe(localSubject.actionKey);
  });

  test("builds the same templates except for the checkout path", () => {
    const local = localRow();
    const remote = remoteRow();
    const github = { prs: { [remote.branch]: pr }, mergeQueue: {} } as GithubData;
    const localSubject = resolveActionSubject(
      localWorktreeTarget(local.wt),
      [local],
      [remote],
      github,
    )!;
    remote.stage = localSubject.stage;
    const localVars = actionSubjectVars(
      localSubject,
      "$",
    );
    const remoteVars = actionSubjectVars(
      resolveActionSubject(remoteWorktreeTarget(remote), [local], [remote], github)!,
      "$",
    );
    const { cwd: _localCwd, ...localRest } = localVars;
    const { cwd: _remoteCwd, ...remoteRest } = remoteVars;
    expect(remoteRest).toEqual(localRest);
  });
});
