/**
 * GitHub PR mutation flows (mark ready / auto-merge / ship), extracted
 * from `app.tsx`. Same pattern as the other `flows/*` modules:
 * `makeGithubPrFlows` is called per render with the current rows +
 * helpers so the returned closures always see fresh state. All three
 * flows follow the optimistic-patch rules from `state/hooks.ts` —
 * patch `["github"]` via `patchPullRequest`, reconcile on settle.
 */
import { config } from "../../core/config.ts";
import {
  AUTO_MERGE_METHOD,
  disableAutoMerge,
  editReviewers,
  enableAutoMerge,
  markPullRequestReady,
  streamFailedRunLog,
} from "../../core/github.ts";
import { createLogger } from "../../core/logger.ts";
import type { PullRequest } from "../../core/types.ts";
import { patchPullRequest, type GithubData } from "../../state/index.ts";
import type { QueryFilters } from "@tanstack/react-query";

import { armedFromPr } from "../badges.ts";
import {
  autoMergeRetryPending,
  cancelAutoMergeRetry,
  RETRY_LIMIT_MS,
  startAutoMergeRetry,
} from "./auto-merge-retry.ts";
import type { WorktreeRow } from "../hooks/useWorktreeRows.ts";
import type { ActionSubject } from "../action-subject.ts";
import { theme } from "../theme.ts";

export type GithubPrFlowsCtx = {
  rows: readonly WorktreeRow[];
  toast: (message: string, color?: string, ms?: number) => void;
  mutate: <TData>(opts: {
    filter: QueryFilters;
    patch: (prev: TData | undefined) => TData | undefined;
    run: () => Promise<void>;
  }) => Promise<void>;
  /**
   * Invalidate `["github"]`. Needed by the registration-gap retry,
   * which arms outside any `mutate` call and so has no settling
   * refetch of its own — without it the badge stays unarmed until the
   * slow staleTime expires.
   */
  refreshGithub: () => Promise<void>;
};

export function makeGithubPrFlows(ctx: GithubPrFlowsCtx) {
  const { rows, toast, mutate, refreshGithub } = ctx;

  async function doMarkReady(slug: string): Promise<void> {
    const log = createLogger(slug);
    const row = rows.find((r) => r.wt.slug === slug);
    if (!row?.pr) {
      toast("no PR for this row", theme.warn, 2000);
      return;
    }
    const prNumber = row.pr.number;
    const branch = row.wt.branch;
    try {
      await mutate<GithubData>({
        filter: { queryKey: ["github"] },
        patch: (data) =>
          patchPullRequest(data, branch, (pr) => ({ ...pr, isDraft: false })),
        run: async () => {
          const result = await markPullRequestReady(prNumber);
          if (!result.ok) throw new Error(result.error);
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.event.err(`mark ready failed for #${prNumber}: ${msg}`);
      toast(`mark ready failed: ${msg}`, theme.err, 4000);
      return;
    }
    log.event.ok(`marked #${prNumber} ready for review`);
    toast(`marked #${prNumber} ready`, theme.ok, 2500);
  }

  /**
   * Toggle GitHub "merge when ready" on the PR. Which of the two
   * features that means is decided in `enableAutoMerge`/
   * `disableAutoMerge` from the PR's base branch — a queued base is
   * enqueued/dequeued, anything else arms classic auto-merge.
   *
   * The optimistic patch flips `pr.autoMerge` either way, so on a queue
   * branch it paints the "armed" badge for the round trip even though
   * the truth will arrive as a queue POSITION instead. That is
   * deliberate: the point of the optimistic write is immediate
   * acknowledgement of a keystroke, and the settling invalidate replaces
   * it with whichever badge GitHub actually lands on.
   */
  async function doAutoMerge(
    subject: ActionSubject,
    action: "enable" | "disable",
  ): Promise<void> {
    const log = createLogger(subject.slug);
    const { pr } = subject;
    if (!pr) {
      toast("no PR for this row", theme.warn, 2000);
      return;
    }
    // Armed-ness spans BOTH features this keystroke can drive. Keying on
    // `pr.autoMerge` alone left a queued PR looking unarmed, so the disarm
    // leg refused to dequeue it.
    const armed = armedFromPr(pr, subject.mq);
    if (action === "enable" && armed) {
      toast("merge when ready already armed", theme.info, 2000);
      return;
    }
    // Nothing is armed while a pending-checks retry is waiting, so
    // without this the disarm leg would report "not armed" and leave
    // the loop running to arm it a minute later — the worst possible
    // answer to someone who just asked for it to stop.
    if (action === "disable" && cancelAutoMergeRetry(pr.number)) {
      log.event.ok(`#${pr.number}: cancelled the pending merge-when-ready arm`);
      toast("cancelled pending arm", theme.ok, 2500);
      return;
    }
    if (action === "enable" && autoMergeRetryPending(pr.number)) {
      toast("already waiting on checks", theme.info, 2000);
      return;
    }
    if (action === "disable" && !armed) {
      toast("merge when ready not armed", theme.info, 2000);
      return;
    }
    const prNumber = pr.number;
    const prId = pr.id;
    // The arm mutation needs the GraphQL node id, which persisted-cache
    // entries from before the field existed lack. One live fetch fills
    // it in — don't guess-and-merge with the number-based porcelain
    // (see enableAutoMerge's doc for why that command is banned).
    if (action === "enable" && prId === undefined) {
      toast("PR cache predates this build — press r, then retry", theme.warn, 3500);
      return;
    }
    const branch = subject.branch;
    // Optimistic shape for enable: seed the method the gh call will arm
    // (shared AUTO_MERGE_METHOD constant, so this can't drift from
    // enableAutoMerge). The invalidate that fires on success replaces it
    // with truth on the next refetch — what matters for UX is that the
    // badge flips immediately.
    let retryable = false;
    const optimisticAutoMerge: PullRequest["autoMerge"] | null =
      action === "enable"
        ? { enabledAt: new Date().toISOString(), mergeMethod: AUTO_MERGE_METHOD }
        : null;
    try {
      await mutate<GithubData>({
        filter: { queryKey: ["github"] },
        patch: (data) =>
          patchPullRequest(data, branch, (pr) => ({
            ...pr,
            autoMerge: optimisticAutoMerge,
          })),
        run: async () => {
          const result =
            action === "enable"
              ? await enableAutoMerge(prId ?? "", {
                  baseRefName: pr.baseRefName,
                  headRefOid: pr.headRefOid,
                })
              : await disableAutoMerge(prNumber, {
                  prId,
                  baseRefName: pr.baseRefName,
                });
          if (!result.ok) {
            // The flag dies in the Error otherwise, and it is the one
            // bit that says whether waiting would help.
            retryable = result.retryable === true;
            throw new Error(result.error);
          }
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const verb = action === "enable" ? "auto-merge" : "disable auto-merge";
      if (retryable) {
        // A required check that has not reported yet — unregistered or
        // still running. Nothing about it needs a human, and pressing
        // the key again when CI finishes is exactly the work wt exists
        // to absorb. The retry re-sends the SAME `expectedHeadOid`, so
        // a push during the wait makes GitHub refuse rather than arming
        // a commit nobody saw.
        startAutoMergeRetry(
          prNumber,
          () =>
            enableAutoMerge(prId ?? "", {
              baseRefName: pr.baseRefName,
              headRefOid: pr.headRefOid,
            }),
          {
            onArmed: () => {
              log.event.ok(`merge when ready armed for #${prNumber} once its checks reported`, {
                toast: true,
              });
              void refreshGithub();
            },
            onFailed: (error) => {
              log.event.err(`auto-merge failed for #${prNumber}: ${error}`, { toast: true });
            },
            onGaveUp: () => {
              log.event.err(
                `#${prNumber}: gave up arming merge when ready — a required check still had not reported after ${
                  RETRY_LIMIT_MS / 60_000
                } min, so check the workflow actually runs for this branch`,
                { toast: true },
              );
            },
          },
        );
        log.event.warn(
          `#${prNumber}: required checks have not reported yet — will arm merge when ready as soon as they do`,
        );
        toast(`#${prNumber}: waiting on checks, will arm`, theme.warn, 3500);
        return;
      }
      log.event.err(`${verb} failed for #${prNumber}: ${msg}`);
      toast(`${verb} failed: ${msg}`, theme.err, 4000);
      return;
    }
    const past = action === "enable" ? "enabled" : "disabled";
    log.event.ok(`auto-merge ${past} for #${prNumber}`);
    toast(`auto-merge ${past} for #${prNumber}`, theme.ok, 2500);
  }

  /**
   * One-keystroke "ship it" (`E`): mark the PR ready, request
   * `config.github.defaultReviewer` if set, and arm auto-merge — in
   * the right order so GitHub doesn't reject the chain. Mark-ready
   * and reviewer-request run in parallel (no dependency); auto-merge
   * awaits mark-ready since `gh pr merge --auto` rejects drafts.
   * Each leg is idempotent: a re-press after partial failure only
   * re-runs the still-pending legs.
   */
  async function doShipPr(slug: string): Promise<void> {
    const log = createLogger(slug);
    const row = rows.find((r) => r.wt.slug === slug);
    if (!row?.pr) {
      toast("no PR for this row", theme.warn, 2000);
      return;
    }
    if (row.pr.state !== "OPEN") {
      toast("PR is not open", theme.warn, 2000);
      return;
    }
    const prNumber = row.pr.number;
    const prId = row.pr.id ?? null;
    const branch = row.wt.branch;
    const wasDraft = row.pr.isDraft;
    const reviewerToAdd =
      config.github.reviewers &&
      config.github.defaultReviewer &&
      !row.pr.requestedReviewers.includes(config.github.defaultReviewer)
        ? config.github.defaultReviewer
        : null;
    const needsAutoMerge = !row.pr.autoMerge;
    // Arm-only auto-merge needs the node id (absent from pre-field
    // persisted caches; one live fetch fills it in).
    if (needsAutoMerge && prId === null) {
      toast("PR cache predates this build — press r, then retry", theme.warn, 3500);
      return;
    }

    if (!wasDraft && !reviewerToAdd && !needsAutoMerge) {
      toast(`#${prNumber} already shipped`, theme.info, 2000);
      return;
    }
    const steps: string[] = [];
    if (wasDraft) steps.push("mark ready");
    if (reviewerToAdd) steps.push(`request ${reviewerToAdd}`);
    if (needsAutoMerge) steps.push("arm auto-merge");
    log.event.info(`ship #${prNumber}: ${steps.join(" + ")}`);

    const markReadyP: Promise<unknown> = wasDraft
      ? mutate<GithubData>({
          filter: { queryKey: ["github"] },
          patch: (data) =>
            patchPullRequest(data, branch, (pr) => ({ ...pr, isDraft: false })),
          run: async () => {
            const r = await markPullRequestReady(prNumber);
            if (!r.ok) throw new Error(r.error);
          },
        })
      : Promise.resolve();
    const reviewerP: Promise<unknown> = reviewerToAdd
      ? mutate<GithubData>({
          filter: { queryKey: ["github"] },
          patch: (data) =>
            patchPullRequest(data, branch, (pr) => ({
              ...pr,
              requestedReviewers: [...pr.requestedReviewers, reviewerToAdd],
              reviewRequests: pr.reviewRequests + 1,
            })),
          run: async () => {
            const r = await editReviewers(prNumber, {
              add: [reviewerToAdd],
              remove: [],
            });
            if (!r.ok) throw new Error(r.error);
          },
        })
      : Promise.resolve();

    const [readyRes, reviewerRes] = await Promise.allSettled([
      markReadyP,
      reviewerP,
    ]);

    if (readyRes.status === "rejected") {
      const msg =
        readyRes.reason instanceof Error
          ? readyRes.reason.message
          : String(readyRes.reason);
      log.event.err(`mark ready failed for #${prNumber}: ${msg}`);
      toast(`mark ready failed: ${msg}`, theme.err, 4000);
      // Bail: auto-merge would fail on the still-draft PR.
      return;
    }
    if (wasDraft) log.event.ok(`marked #${prNumber} ready`);

    if (reviewerRes.status === "rejected") {
      const msg =
        reviewerRes.reason instanceof Error
          ? reviewerRes.reason.message
          : String(reviewerRes.reason);
      log.event.err(
        `request reviewer ${reviewerToAdd} failed for #${prNumber}: ${msg}`,
      );
      toast(`reviewer request failed: ${msg}`, theme.err, 4000);
      // Don't bail — auto-merge is independent of the reviewer request.
    } else if (reviewerToAdd) {
      log.event.ok(`requested ${reviewerToAdd} for #${prNumber}`);
    }

    if (needsAutoMerge) {
      try {
        await mutate<GithubData>({
          filter: { queryKey: ["github"] },
          patch: (data) =>
            patchPullRequest(data, branch, (pr) => ({
              ...pr,
              autoMerge: {
                enabledAt: new Date().toISOString(),
                mergeMethod: AUTO_MERGE_METHOD,
              },
            })),
          run: async () => {
            const r = await enableAutoMerge(prId ?? "", {
              baseRefName: row.pr?.baseRefName,
              headRefOid: row.pr?.headRefOid,
            });
            if (!r.ok) throw new Error(r.error);
          },
        });
        log.event.ok(`auto-merge enabled for #${prNumber}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.event.err(`auto-merge failed for #${prNumber}: ${msg}`);
        toast(`auto-merge failed: ${msg}`, theme.err, 4000);
        return;
      }
    }

    toast(`shipped #${prNumber}`, theme.ok, 2500);
  }

  /**
   * `f` — tail the failed-job logs of this PR's most recent failed CI run
   * into the activity pane (`gh run view --log-failed`), so a red check
   * can be diagnosed without a browser trip. Refuses when the PR's checks
   * aren't failing. Output is capped so a giant log can't flood the pane;
   * the tail keeps draining silently past the cap.
   */
  async function doTailFailedChecks(slug: string): Promise<void> {
    const log = createLogger(slug);
    const row = rows.find((r) => r.wt.slug === slug);
    if (!row?.pr) {
      toast("no PR for this row", theme.warn, 2000);
      return;
    }
    if (row.pr.checks !== "fail") {
      toast("no failing checks", theme.info, 2000);
      return;
    }
    const branch = row.wt.branch;
    // `?? []` guards a stale persisted PR (disk cache) from before this
    // field existed; the log fetch below still works off the branch alone.
    const names = row.pr.failedChecks ?? [];
    log.event.warn(
      `failing: ${names.length > 0 ? names.join(", ") : "checks"} — fetching logs…`,
    );
    toast("fetching failed CI logs…", theme.info, 2500);
    const CAP = 200;
    let emitted = 0;
    const res = await streamFailedRunLog(branch, (line) => {
      if (emitted < CAP) log.event.dim(line);
      else if (emitted === CAP) {
        log.event.dim(`… (truncated at ${CAP} lines; \`gh run view --log-failed\` for the rest)`);
      }
      emitted++;
    });
    if (!res.ok) {
      log.event.err(`failed CI logs: ${res.reason}`);
      toast(`failed logs: ${res.reason}`, theme.err, 4000);
      return;
    }
    log.event.ok(`failed CI logs for ${branch} (${Math.min(emitted, CAP)} shown)`);
  }

  return { doMarkReady, doAutoMerge, doShipPr, doTailFailedChecks };
}
