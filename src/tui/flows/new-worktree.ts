/**
 * Worktree-creation flows: the `n`/`N` prompt (doNew), review checkout
 * (`w` on a review-request row), and removed-history restore (Enter in
 * the `h` view). Extracted from `app.tsx`; rebuilt per render so the
 * closures see fresh setters.
 */
import { config } from "../../core/config.ts";
import { createWorktree, parseInput } from "../../core/lifecycle.ts";
import { createLogger } from "../../core/logger.ts";
import { runRemoteWt } from "../../core/remote.ts";
import { setSlugGithubIssue, type RemovedWorktree } from "../../core/wtstate.ts";
import { parseNewInput } from "../app-helpers.ts";
import type { Modal } from "../modal-state.ts";
import type { RemoteCreation } from "../remote-creation.ts";
import { theme } from "../theme.ts";

const newLog = createLogger("[new]");

/** Section a review-requested PR lands in when checked out via `w`. */
export const REVIEW_SECTION = "Reviews";

type WorktreeCreateFlowsCtx = {
  setModal: (m: Modal | null) => void;
  setSection: (slug: string, section: string | null) => Promise<void>;
  setSel: (key: string | null) => void;
  setRemovedView: (v: boolean) => void;
  setRemoteCreation: (creation: RemoteCreation | null) => void;
  refreshAll: () => Promise<void>;
  refreshRemoteWorktrees: () => Promise<void>;
  toast: (message: string, color?: string, ms?: number) => void;
};

export function makeWorktreeCreateFlows(ctx: WorktreeCreateFlowsCtx) {
  const {
    setModal,
    setSection,
    setSel,
    setRemovedView,
    setRemoteCreation,
    refreshAll,
    refreshRemoteWorktrees,
    toast,
  } = ctx;

  // Returns whether the create succeeded. The footer-input handler awaits
  // this to decide between the optimistic legend reset (success) and
  // restoring the typed line for editing in place (failure) — see
  // `handleFooterInputKey`'s new/new-remote submit path.
  async function doNew(raw: string, defaultBase?: string): Promise<boolean> {
    const parsed = parseNewInput(raw, defaultBase);
    if ("error" in parsed) {
      newLog.event.err(parsed.error);
      toast(parsed.error, theme.err, 3000);
      return false;
    }
    newLog.event.info(`resolving ${parsed.input}`);
    if (parsed.anyAuthor) newLog.event.info("searching all authors (--any)");
    if (parsed.attach) newLog.event.info("attaching to an existing branch (--attach)");
    if (parsed.base) newLog.event.info(`base: ${parsed.base}`);
    let branch: string;
    try {
      branch = await parseInput(parsed.input, {
        anyAuthor: parsed.anyAuthor,
        attach: parsed.attach,
        promptForChoice: (id, branches) =>
          new Promise<string | null>((resolve) => {
            setModal({
              kind: "branchPicker",
              title: `multiple branches for ${id}`,
              items: branches,
              index: 0,
              resolve,
            });
          }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      newLog.event.err(message);
      newLog.error(err instanceof Error ? err : String(err));
      toast(message, theme.err, 3000);
      return false;
    }
    newLog.event.info(`branch = ${branch}`);
    const result = await createWorktree(branch, {
      onPhase: (p) => newLog.event.info(`phase: ${p}`),
      onLog: (line) => newLog.event.dim(line),
      runInstall: true,
      base: parsed.base,
    });
    if (!result.ok) {
      // Attention-channel: a create failure is an async completion whose
      // trigger keystroke is long past, and it needs acting on (fix the
      // main clone, retry). The emit toasts by default — no ctx.toast on
      // top, per the single-emit contract.
      newLog.attention.err(`worktree failed: ${result.reason}`);
      return false;
    }
    if (parsed.gh) {
      setSlugGithubIssue(result.slug, parsed.gh);
      newLog.event.info(`gh issue: #${parsed.gh}`);
    }
    newLog.event.ok(`ready at ${result.path}`);
    toast(`created ${result.slug}`, theme.ok, 2200);
    setSel(result.slug);
    void refreshAll();
    return true;
  }

  /**
   * Create on the remote host, then refresh its rows in this TUI. Returns
   * whether it succeeded — same contract as `doNew`, so the footer-input
   * handler can restore the typed line on failure.
   */
  async function doRemoteNew(raw: string): Promise<boolean> {
    const remote = config.remote;
    if (!remote) {
      toast("[remote] is not configured", theme.warn, 2200);
      return false;
    }
    const parsed = parseNewInput(raw);
    if ("error" in parsed) {
      newLog.event.err(parsed.error);
      return false;
    }
    const args = ["new", parsed.input, "--no-open"];
    if (parsed.anyAuthor) args.push("--any");
    if (parsed.attach) args.push("--attach");
    if (parsed.gh) args.push("--gh", String(parsed.gh));
    if (parsed.base) args.push("--base", parsed.base);

    const remoteLog = createLogger(`[remote:${remote.label}]`);
    setRemoteCreation({
      remote,
      hostKey: remote.host,
      hostLabel: remote.label,
      input: parsed.input,
      status: "creating",
    });
    remoteLog.event.info(`creating ${parsed.input}`);
    // The normal remote inventory interval is 15s while no busy row is known.
    // Probe eagerly during creation so the authoritative row replaces the
    // placeholder as soon as the checkout exists; F10/F11/F12 can then enter
    // it while the remaining init phases continue in the background.
    let refreshStopped = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const pollRemote = async (): Promise<void> => {
      await refreshRemoteWorktrees().catch(() => undefined);
      if (!refreshStopped) {
        refreshTimer = setTimeout(() => void pollRemote(), 1_500);
      }
    };
    void pollRemote();
    let code: number;
    try {
      code = await runRemoteWt(remote, args, {
        onLine: (line) => remoteLog.event.dim(line),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      remoteLog.event.err(message);
      toast(`remote create failed: ${message}`, theme.err, 3500);
      setRemoteCreation(null);
      return false;
    } finally {
      refreshStopped = true;
      if (refreshTimer) clearTimeout(refreshTimer);
    }
    if (code !== 0) {
      remoteLog.event.err(`create failed (exit ${code})`);
      toast(`remote create failed (exit ${code})`, theme.err, 3000);
      setRemoteCreation(null);
      return false;
    }
    remoteLog.event.ok(`ready on ${remote.label}`);
    try {
      await refreshRemoteWorktrees();
      toast(`ready on ${remote.label}`, theme.ok, 1800);
    } finally {
      setRemoteCreation(null);
    }
    return true;
  }

  // Check out a review-requested PR's branch as a worktree and drop it
  // into the "Reviews" section. The branch already exists on origin, so
  // `createWorktree` takes the checkout-existing path (sets upstream,
  // installs packages); `setSection` materializes the section by simply
  // assigning the new slug to it. Leaves the review-request row in place
  // — this spawns a worktree, it doesn't consume the PR.
  async function doCheckoutReview(branch: string): Promise<void> {
    const log = createLogger("[review]");
    log.event.info(`creating review worktree for ${branch}`);
    const result = await createWorktree(branch, {
      onPhase: (p) => log.event.info(`phase: ${p}`),
      onLog: (line) => log.event.dim(line),
      runInstall: true,
    });
    if (!result.ok) {
      // Attention-channel (toasts by default) — see doNew's failure path.
      log.attention.err(`worktree failed: ${result.reason}`);
      return;
    }
    await setSection(result.slug, REVIEW_SECTION);
    log.event.ok(`ready at ${result.path} → ${REVIEW_SECTION}`);
    toast(`created ${result.slug} in ${REVIEW_SECTION}`, theme.info, 2200);
    setSel(result.slug);
    void refreshAll();
  }

  // Restore a removed worktree: a real `createWorktree` for the recorded
  // branch. If the branch still exists (locally or on origin) this checks
  // it out; if it's fully gone (merged + deleted) it starts a fresh branch
  // of the same name off trunk. `createWorktree` clears the removed-history
  // entry itself, so success just needs to land the cursor on the new row.
  async function doRestoreRemoved(entry: RemovedWorktree): Promise<void> {
    const log = createLogger("[restore]");
    log.event.info(`restoring ${entry.slug} (${entry.branch})`);
    const result = await createWorktree(entry.branch, {
      onPhase: (p) => log.event.info(`phase: ${p}`),
      onLog: (line) => log.event.dim(line),
      runInstall: true,
    });
    if (!result.ok) {
      // Attention-channel (toasts by default) — see doNew's failure path.
      log.attention.err(`restore failed: ${result.reason}`);
      return;
    }
    log.event.ok(`restored at ${result.path}`);
    toast(`restored ${result.slug}`, theme.ok, 2500);
    setRemovedView(false);
    setSel(result.slug);
    void refreshAll();
  }

  return { doNew, doRemoteNew, doCheckoutReview, doRestoreRemoved };
}
