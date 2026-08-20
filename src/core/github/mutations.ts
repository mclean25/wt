import { config } from "../config.ts";
import { createLogger } from "../logger.ts";
import { run, runStreaming } from "../proc.ts";
import type { AutoMergeMethod } from "../types.ts";
import { hasGh, repoSlug } from "./gh-cli.ts";
import type { GhActionResult, LivePrInfo } from "./types.ts";

const log = createLogger("[gh]");

/**
 * The merge method `enableAutoMerge` arms. Hardcoded to match the repo's
 * merge style; promote to config when there's a second concrete
 * preference. Exported so the TUI's optimistic patch shows the same
 * method the gh call will actually use — the two must never drift.
 */
export const AUTO_MERGE_METHOD: AutoMergeMethod = "REBASE";

/**
 * Shared body for every one-shot `gh` write below: gh-availability
 * check, run from the main clone with the standard timeout, exit-code
 * gate, and a uniform error-logged/GhActionResult shape. Callers supply
 * only the argv and their own log label/context.
 */
async function runGhMutation(
  argv: string[],
  logLabel: string,
  logCtx: Record<string, unknown>,
): Promise<GhActionResult> {
  if (!(await hasGh())) return { ok: false, error: "gh CLI not found" };
  const r = await run(argv, { cwd: config.paths.mainClone, timeoutMs: 15_000 });
  if (r.exitCode !== 0) {
    const msg = (r.stderr || r.stdout).trim() || `gh exited ${r.exitCode}`;
    log.error(logLabel, { ...logCtx, msg });
    return { ok: false, error: msg };
  }
  return { ok: true };
}

/**
 * Does `branch` have a merge queue? `null` when it doesn't, when the
 * repo can't be resolved, or when the probe fails — every one of those
 * means "fall back to classic auto-merge", which is the safe direction:
 * the worst case is the error the caller would have got anyway.
 *
 * Asked per action rather than read off row state on purpose. A queue
 * is configured in branch rules and can appear or disappear between
 * polls, and this is a keystroke-driven write — one cheap round trip
 * buys a deterministic answer instead of arming the wrong feature off a
 * stale badge.
 */
async function mergeQueueIdForBranch(branch: string): Promise<string | null> {
  if (!branch) return null;
  const slug = await repoSlug();
  if (!slug) return null;
  const [owner, name] = slug.split("/");
  if (!owner || !name) return null;
  const r = await run(
    [
      "gh", "api", "graphql",
      "-f",
      "query=query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { mergeQueue(branch: $branch) { id } } }",
      "-f", `owner=${owner}`,
      "-f", `name=${name}`,
      "-f", `branch=${branch}`,
    ],
    { cwd: config.paths.mainClone, timeoutMs: 15_000 },
  );
  if (r.exitCode !== 0) {
    log.warn("merge-queue probe failed", { branch, msg: (r.stderr || r.stdout).slice(0, 200) });
    return null;
  }
  try {
    return JSON.parse(r.stdout)?.data?.repository?.mergeQueue?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Enable "merge when ready" on a PR — ARM ONLY, never merge now.
 *
 * **Two different GitHub features wear that label, and picking the wrong
 * one fails outright.** A branch with a MERGE QUEUE gets
 * `enqueuePullRequest`; everything else gets classic auto-merge via
 * `enablePullRequestAutoMerge`. They are not interchangeable and they
 * are gated on different settings: classic auto-merge requires the
 * repo-level "Allow auto-merge", while a queue does not. Assuming the
 * classic mutation covered both is what produced `Auto merge is not
 * allowed for this repository` on a repo whose GitHub UI happily
 * offered the "Merge when ready" button — the button was enqueuing.
 *
 * Note the second trap the queue path steps over. Classic auto-merge
 * REFUSES on a PR with a clean status (nothing left to wait for), so on
 * a queue repo the old code would have failed on green PRs even with
 * the repo setting enabled. Enqueuing a green PR is the entire point of
 * a queue.
 *
 * `gh pr merge --auto` stays banned for the classic path: it looks
 * equivalent but silently falls through to an IMMEDIATE merge on an
 * unprotected repo — the picker's confirm-less "arm" keystroke once
 * shipped a dogfood PR on the spot while toasting "auto-merge enabled".
 */
export async function enableAutoMerge(
  prId: string,
  opts: { baseRefName?: string; headRefOid?: string } = {},
): Promise<GhActionResult> {
  // Callers guard, but a raw GraphQL "Could not resolve to a node with
  // the global id of ''" toast is useless — fail with a named reason.
  if (!prId) return { ok: false, error: "missing PR node id" };

  const queueId = opts.baseRefName ? await mergeQueueIdForBranch(opts.baseRefName) : null;
  if (queueId) {
    // `expectedHeadOid` makes this fail rather than enqueue a commit we
    // never saw, if the branch moved between the poll and the keystroke.
    // The merge queue's own configuration decides the merge method, so
    // AUTO_MERGE_METHOD deliberately plays no part here.
    const argv = [
      "gh", "api", "graphql",
      "-f",
      "query=mutation($prId: ID!, $oid: GitObjectID) { enqueuePullRequest(input: {pullRequestId: $prId, expectedHeadOid: $oid}) { mergeQueueEntry { position } } }",
      "-f", `prId=${prId}`,
    ];
    if (opts.headRefOid) argv.push("-f", `oid=${opts.headRefOid}`);
    return runGhMutation(argv, "enqueue failed", { prId, base: opts.baseRefName });
  }

  return runGhMutation(
    [
      "gh", "api", "graphql",
      "-f",
      "query=mutation($prId: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: {pullRequestId: $prId, mergeMethod: $method}) { pullRequest { number } } }",
      "-f", `prId=${prId}`,
      "-f", `method=${AUTO_MERGE_METHOD}`,
    ],
    "auto-merge failed",
    { prId },
  );
}

/**
 * Cancel a previously-armed "merge when ready".
 *
 * Mirrors `enableAutoMerge`'s split, and has to: `--disable-auto` does
 * not remove a PR from a merge queue, so on a queue branch the cancel
 * would report success while the PR stayed queued and merged anyway.
 * Queued PRs go through `dequeuePullRequest`; everything else through
 * `gh pr merge --disable-auto`, which no-ops with an error we surface
 * verbatim when the PR wasn't armed.
 */
export async function disableAutoMerge(
  prNumber: number,
  opts: { prId?: string; baseRefName?: string } = {},
): Promise<GhActionResult> {
  const queueId =
    opts.prId && opts.baseRefName ? await mergeQueueIdForBranch(opts.baseRefName) : null;
  if (queueId && opts.prId) {
    return runGhMutation(
      [
        "gh", "api", "graphql",
        "-f",
        "query=mutation($prId: ID!) { dequeuePullRequest(input: {pullRequestId: $prId}) { mergeQueueEntry { position } } }",
        "-f", `prId=${opts.prId}`,
      ],
      "dequeue failed",
      { prNumber, base: opts.baseRefName },
    );
  }
  return runGhMutation(
    ["gh", "pr", "merge", String(prNumber), "--disable-auto"],
    "disable auto-merge failed",
    { prNumber },
  );
}

/**
 * Edit a PR's review requests via `gh pr edit`. Both `add` and
 * `remove` may be passed in the same call — gh accepts both flag
 * sets at once. Logins are users; team slugs use the `org/team-slug`
 * form. Empty changes is a no-op.
 */
export async function editReviewers(
  prNumber: number,
  changes: { add: readonly string[]; remove: readonly string[] },
): Promise<GhActionResult> {
  if (changes.add.length === 0 && changes.remove.length === 0) {
    return { ok: true };
  }
  const argv = ["gh", "pr", "edit", String(prNumber)];
  for (const l of changes.add) argv.push("--add-reviewer", l);
  for (const l of changes.remove) argv.push("--remove-reviewer", l);
  return runGhMutation(argv, "edit reviewers failed", { prNumber, changes });
}

/**
 * Retarget a PR's base branch via `gh pr edit --base`. The native restack
 * engine calls this after replaying a branch whose parent moved (e.g. a
 * child reparented onto trunk once its parent landed), so the PR's base on
 * GitHub matches the recorded parent. No-op-safe: gh is idempotent if the base
 * already matches. Runs from the main clone so gh resolves the right repo.
 */
export async function retargetPrBase(
  prNumber: number,
  base: string,
): Promise<GhActionResult> {
  return runGhMutation(
    ["gh", "pr", "edit", String(prNumber), "--base", base],
    "retarget pr base failed",
    { prNumber, base },
  );
}

/**
 * Flip a draft PR to "ready for review" via `gh pr ready`. Notifies
 * reviewers and triggers any code-owner auto-requests, so callers
 * should gate on user confirmation. Runs from the main clone so gh
 * resolves the right repo.
 */
export async function markPullRequestReady(prNumber: number): Promise<GhActionResult> {
  return runGhMutation(
    ["gh", "pr", "ready", String(prNumber)],
    "mark ready failed",
    { prNumber },
  );
}

/**
 * Close a GitHub issue on the origin repo as completed. Used by the
 * `builtin:close-issue` automation once a worktree's branch lands.
 * Callers treat failure as advisory — the issue may already be closed
 * (a PR-body closing keyword, or a hand close, beat us to it) — so
 * they log and move on rather than surfacing an error.
 */
export async function closeGithubIssue(issue: number): Promise<GhActionResult> {
  return runGhMutation(
    ["gh", "issue", "close", String(issue), "--reason", "completed"],
    "close issue failed",
    { issue },
  );
}

/**
 * Delete a landed branch's ref on the origin repo. Used by the
 * `builtin:delete-branch` automation once a worktree's branch merges —
 * the same effect as GitHub's "Automatically delete head branches"
 * setting, for repos that have not enabled it.
 *
 * The trunk refusal is defence in depth rather than a live worry: the
 * only branch that ever reaches here is a worktree's own, frozen onto a
 * fire that already required the branch to have LANDED. It is here
 * because the blast radius is asymmetric — every other failure in this
 * file costs a retry, and this one costs the repo's mainline.
 *
 * Failure is advisory, exactly like `closeGithubIssue`: a repo with the
 * GitHub setting on, or anyone who deleted it by hand, gets there first
 * and GitHub answers `Reference does not exist`. That is the desired
 * end state, not an error, so callers log and move on rather than
 * retrying into a ref that is already gone.
 */
export async function deleteRemoteBranch(branch: string): Promise<GhActionResult> {
  if (!branch) return { ok: false, error: "missing branch" };
  if (branch === config.branch.base) {
    return { ok: false, error: `refusing to delete the trunk branch ${branch}` };
  }
  const slug = await repoSlug();
  if (!slug) return { ok: false, error: "could not resolve the origin repo" };
  // Nested refs (`user/feature`) need no escaping — the REST path takes
  // the rest of the ref verbatim after `heads/`.
  return runGhMutation(
    ["gh", "api", "--method", "DELETE", `repos/${slug}/git/refs/heads/${branch}`],
    "delete branch failed",
    { branch },
  );
}

/**
 * Stream the failed-job logs of the most recent failed CI run for
 * `branch` to `onLine`, via `gh run view <id> --log-failed`. Resolves
 * the count of lines emitted, or a reason when gh is missing, no failed
 * run exists (a check can fail as a bare `StatusContext` with no Actions
 * run behind it), or gh errors. Read-only; safe to fire from a keybind.
 */
export async function streamFailedRunLog(
  branch: string,
  onLine: (line: string) => void,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!(await hasGh())) return { ok: false, reason: "gh CLI not found" };
  const listed = await run(
    [
      "gh", "run", "list",
      "--branch", branch,
      "--status", "failure",
      "--limit", "1",
      "--json", "databaseId",
    ],
    { cwd: config.paths.mainClone, timeoutMs: 15_000 },
  );
  if (listed.exitCode !== 0) {
    return { ok: false, reason: (listed.stderr || listed.stdout).trim() || "gh run list failed" };
  }
  let runs: Array<{ databaseId?: number }>;
  try {
    runs = JSON.parse(listed.stdout) as typeof runs;
  } catch {
    return { ok: false, reason: "could not parse gh run list" };
  }
  const runId = runs[0]?.databaseId;
  if (runId === undefined) return { ok: false, reason: "no failed workflow run" };
  const code = await runStreaming(
    ["gh", "run", "view", String(runId), "--log-failed"],
    { cwd: config.paths.mainClone, onLine },
  );
  if (code !== 0) return { ok: false, reason: `gh run view exited ${code}` };
  return { ok: true };
}

/**
 * Read the live `baseRefName` / `state` for a branch's PR via
 * `gh pr view`. The restack reconcile/retarget paths use it to compare
 * the recorded parent against the PR's actual base. Returns null when
 * there's no PR (or gh is unavailable).
 */
export async function viewPrInfo(branch: string): Promise<LivePrInfo | null> {
  if (!branch || !(await hasGh())) return null;
  const r = await run(
    ["gh", "pr", "view", branch, "--json", "number,baseRefName,state,isDraft,title"],
    { cwd: config.paths.mainClone, timeoutMs: 15_000 },
  );
  if (r.exitCode !== 0) return null;
  try {
    const d = JSON.parse(r.stdout) as Partial<LivePrInfo>;
    if (typeof d.number !== "number") return null;
    // Validate `state` against the known set rather than asserting — gh
    // could in principle return a value outside the union, and downstream
    // merge-detection branches on it.
    const state: LivePrInfo["state"] =
      d.state === "CLOSED" || d.state === "MERGED" ? d.state : "OPEN";
    return {
      number: d.number,
      baseRefName: typeof d.baseRefName === "string" ? d.baseRefName : "",
      state,
      isDraft: d.isDraft === true,
      title: typeof d.title === "string" ? d.title : "",
    };
  } catch {
    return null;
  }
}
