import type { ActionVars } from "../core/actions.ts";
import type { RemoteWorktreeSummary } from "../core/remote-worktrees.ts";
import type { WorktreeTarget } from "../core/worktree-target.ts";
import type { GithubData } from "../state/queries/github.ts";
import type { WorktreeRow } from "./hooks/useWorktreeRows.ts";
import {
  buildWorktreeModels,
  findWorktreeModel,
  type WorktreeModel,
} from "./worktree-model.ts";

/**
 * Location-neutral row state consumed by every `!` feature. The local and
 * remote inventory adapters normalize here; downstream picker/dispatch code
 * must not ask where the checkout lives until it reaches process execution.
 */
export type ActionSubject = WorktreeModel;

export type ActionSubjectResolver = (
  target: WorktreeTarget,
) => ActionSubject | undefined;

export function resolveActionSubject(
  target: WorktreeTarget,
  rows: readonly WorktreeRow[],
  remoteRows: readonly RemoteWorktreeSummary[],
  githubData: GithubData | undefined,
): ActionSubject | undefined {
  return findWorktreeModel(
    target,
    buildWorktreeModels(rows, remoteRows, new Set(), githubData),
  );
}

export function actionSubjectBlockedReason(subject: ActionSubject): string | null {
  return subject.blockedReason;
}

export function actionSubjectVars(
  subject: ActionSubject,
  skillPrefix: string,
): ActionVars {
  return {
    base: subject.base,
    base_branch: subject.baseBranch,
    branch: subject.branch,
    slug: subject.slug,
    cwd: subject.path,
    pr: subject.pr ? String(subject.pr.number) : "",
    issue_id: subject.issueId ?? "",
    stage: subject.stage,
    skill_prefix: skillPrefix,
  };
}
