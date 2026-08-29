import { config } from "../core/config.ts";
import { resolveIssueId } from "../core/issue-tracker.ts";
import type { RemoteWorktreeSummary } from "../core/remote-worktrees.ts";
import { expectedStage } from "../core/stage-safety.ts";
import type { MergeQueueEntry, PullRequest, Status } from "../core/types.ts";
import { StatusKind } from "../core/types.ts";
import type { WorkStatusRecord } from "../core/work-status.ts";
import {
  DEV_SERVER_STOPPED,
  type DevServerStatus,
} from "../core/dev-server.ts";
import { worktreeLedgerKey } from "../core/worktree-ref.ts";
import {
  localWorktreeTarget,
  remoteWorktreeTarget,
  worktreeActionKey,
  type WorktreeTarget,
} from "../core/worktree-target.ts";
import type { GithubData } from "../state/queries/github.ts";
import { launchBlockedReason } from "./app-helpers.ts";
import type { WorktreeRow } from "./hooks/useWorktreeRows.ts";

export type WorktreeModelSource =
  | { kind: "local"; row: WorktreeRow }
  | { kind: "remote"; row: RemoteWorktreeSummary };

/**
 * The location-neutral worktree shape consumed by the TUI. Inventory adapters
 * build this once; feature code reads common fields and inspects `source` only
 * for a capability that is genuinely unavailable in one inventory protocol.
 */
export type WorktreeModel = {
  source: WorktreeModelSource;
  target: WorktreeTarget;
  /** Host-qualified fleet identity. Bare slug for local compatibility. */
  key: string;
  /** Tmux-safe identity for the locally supervised action slot. */
  actionKey: string;
  slug: string;
  branch: string;
  path: string;
  stage: string;
  base: string;
  baseBranch: string;
  section: string | null;
  archived: boolean;
  exists: boolean;
  status: Status;
  pr: PullRequest | undefined;
  mq: MergeQueueEntry | undefined;
  issueId: string | null;
  githubIssue: number | null;
  work: WorkStatusRecord | null;
  deployed: boolean;
  dev: DevServerStatus;
  dirty: boolean | null;
  unpushed: number | null;
  blockedReason: string | null;
  devLogsAvailable: boolean;
};

export function localWorktreeModel(row: WorktreeRow): WorktreeModel {
  const target = localWorktreeTarget(row.wt);
  const sync = row.fields?.sync?.data;
  const dirty = row.fields?.dirty?.data;
  const status = row.status ?? { kind: StatusKind.Clean, label: "clean" };
  return {
    source: { kind: "local", row },
    target,
    key: worktreeLedgerKey(target.ref),
    actionKey: worktreeActionKey(target),
    slug: row.wt.slug,
    branch: row.wt.branch,
    path: row.wt.path,
    stage: expectedStage(row.wt),
    base: row.stackedOn?.diffBase ?? config.branch.base,
    baseBranch: row.stackedOn?.branch ?? config.branch.base,
    section: row.section ?? null,
    archived: row.archived ?? false,
    exists: true,
    status: {
      kind: status.kind,
      label: status.label,
      age: status.age,
      op: status.op,
    },
    pr: row.pr,
    mq: row.mq,
    issueId: resolveIssueId(row.wt.slug, row.issueId),
    githubIssue: row.githubIssue,
    work: row.work,
    deployed: row.fields?.deploy?.data ?? false,
    dev: row.fields?.dev?.data ?? DEV_SERVER_STOPPED,
    dirty: dirty === undefined ? null : dirty.length > 0,
    unpushed: sync
      ? sync.remote === null
        ? sync.main.ahead
        : sync.remote.ahead
      : null,
    blockedReason: row.fields ? launchBlockedReason(row) : null,
    devLogsAvailable:
      row.fields?.dev?.data?.running === true ||
      row.fields?.dev?.data?.starting === true ||
      row.fields?.dev?.data?.crashed === true,
  };
}

export function remoteWorktreeModel(
  row: RemoteWorktreeSummary,
  archived: boolean,
  githubData: GithubData | undefined,
): WorktreeModel {
  const target = remoteWorktreeTarget(row);
  return {
    source: { kind: "remote", row },
    target,
    key: worktreeLedgerKey(target.ref),
    actionKey: worktreeActionKey(target),
    slug: row.slug,
    branch: row.branch,
    path: row.path,
    stage: row.stage,
    base: row.base,
    baseBranch: row.base,
    section: row.section,
    archived,
    exists: row.exists,
    status: row.status,
    pr: githubData?.prs[row.branch],
    mq: githubData?.mergeQueue?.[row.branch],
    issueId: resolveIssueId(row.slug, row.issueId),
    githubIssue: row.githubIssue,
    work: row.work,
    deployed: row.deployed,
    dev: row.dev ?? DEV_SERVER_STOPPED,
    dirty: row.dirty,
    unpushed: row.unpushed,
    blockedReason: row.status.kind === StatusKind.Busy ? row.status.label : null,
    devLogsAvailable:
      row.dev?.running === true ||
      row.dev?.starting === true ||
      row.dev?.crashed === true,
  };
}

export function buildWorktreeModels(
  rows: readonly WorktreeRow[],
  remoteRows: readonly RemoteWorktreeSummary[],
  archivedKeys: ReadonlySet<string>,
  githubData: GithubData | undefined,
): WorktreeModel[] {
  return [
    ...rows.map(localWorktreeModel),
    ...remoteRows.map((row) => {
      const target = remoteWorktreeTarget(row);
      return remoteWorktreeModel(
        row,
        archivedKeys.has(worktreeLedgerKey(target.ref)),
        githubData,
      );
    }),
  ];
}

export function findWorktreeModel(
  target: WorktreeTarget,
  models: readonly WorktreeModel[],
): WorktreeModel | undefined {
  const key = worktreeLedgerKey(target.ref);
  return models.find((model) => model.key === key);
}

export function worktreeVisualKey(model: WorktreeModel): string {
  return model.source.kind === "local"
    ? model.slug
    : `remote:${model.source.row.hostKey}:${model.slug}`;
}
