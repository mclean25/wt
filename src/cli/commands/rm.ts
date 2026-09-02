import { Effect } from "effect";

import { operationErrors } from "../../core/errors.ts";
import { branchExists, branchIsGone, branchIsMerged } from "../../core/git.ts";
import { removeWorktree, spawnBackgroundRemove } from "../../core/lifecycle.ts";
import { lockAge, lockLabel, lockStatus } from "../../core/locks.ts";
import { latestLogFor } from "../../core/logs.ts";
import { isOurStageDeployed } from "../../core/stage-safety.ts";
import { killAllSessionsFor } from "../../core/tmux.ts";
import type { Worktree } from "../../core/types.ts";
import {
  listWorktrees,
  pushCounts,
  worktreeIsDirty,
} from "../../core/worktree.ts";
import { owesPostMergeVerification } from "../../core/work-status.ts";
import { readWtState } from "../../core/wtstate.ts";
import { hasHelpFlag } from "../args.ts";
import { bold, dim, green, red, yellow } from "../colors.ts";
import { confirm, isInteractive, pickIndex } from "../prompt.ts";

const USAGE = `usage: wt rm [<slug>] [options]

Remove a worktree (with dirty/unpushed guards, optional SST stage
destroy, optional branch delete). No slug picks interactively.

  --yes, -y              skip confirmations
  --force                remove despite uncommitted / unpushed work
  --destroy-stage / --no-destroy-stage
                          force the SST stage decision (default: prompt
                          when your stage looks deployed)
  --delete-branch / --keep-branch
                          default deletes the branch
  --background, -b       dispatch as a background job (watch with
                          \`wt logs <slug>\`)`;

type Flags = {
  slug?: string;
  yes: boolean;
  force: boolean;
  destroyStage: boolean | null;
  deleteBranch: boolean | null;
  background: boolean;
};

function parse(argv: string[]): Flags | { error: string } {
  let slug: string | undefined;
  let yes = false;
  let force = false;
  let destroyStage: boolean | null = null;
  let deleteBranch: boolean | null = null;
  let background = false;
  for (const a of argv) {
    if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--force") force = true;
    else if (a === "--destroy-stage") destroyStage = true;
    else if (a === "--no-destroy-stage") destroyStage = false;
    else if (a === "--delete-branch") deleteBranch = true;
    else if (a === "--keep-branch") deleteBranch = false;
    else if (a === "--background" || a === "-b") background = true;
    else if (a.startsWith("--") || a.startsWith("-"))
      return { error: `unknown flag: ${a}` };
    else if (!slug) slug = a;
    else return { error: `unexpected arg: ${a}` };
  }
  return { slug, yes, force, destroyStage, deleteBranch, background };
}

const io = operationErrors("wt rm");

const decideDestroyStage = Effect.fnUntraced(function* (
  wt: Worktree,
  flag: boolean | null,
  yes: boolean,
) {
  if (flag === true) return true;
  if (flag === false) return false;
  // `isOurStageDeployed` is the strict check — outputs.json must
  // mention the owned (pinned, prefix-valid) stage, otherwise we treat
  // the worktree as not-deployed-by-us (a foreign deploy in this
  // directory will not trigger the prompt). `removeWorktree`
  // re-validates via `safeStage` before shelling out.
  if (!isOurStageDeployed(wt)) return false;
  if (yes) return true;
  if (isInteractive()) {
    return yield* confirm(
      `Stage ${bold(wt.stage)} looks deployed (.sst/outputs.json has live outputs). Run \`sst remove\`?`,
      true,
    );
  }
  console.log(
    yellow(
      `Skipping sst remove for ${wt.stage} (non-interactive; pass --destroy-stage to run it)`,
    ),
  );
  return false;
});

const decideDeleteBranch = Effect.fnUntraced(function* (
  wt: Worktree,
  flag: boolean | null,
) {
  // The user already asked to remove this worktree; dirty/unpushed work
  // is caught upstream by the tree-clean check. Default to deleting the
  // branch — pass --keep-branch to opt out.
  if (!wt.branch || !(yield* branchExists(wt.branch))) {
    return false;
  }
  if (flag !== null) return flag;
  return true;
});

export const run = Effect.fn("wt rm")(function* (argv: string[]) {
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return 0;
  }
  const parsed = parse(argv);
  if ("error" in parsed) {
    console.error(red(parsed.error));
    return 2;
  }

  const wts = (yield* listWorktrees()).filter((w) => !w.isMain);
  if (wts.length === 0) {
    console.log(yellow("No worktrees to remove."));
    return 0;
  }

  let target: Worktree | undefined;
  if (parsed.slug) {
    target = wts.find((w) => w.slug === parsed.slug);
    if (!target) {
      console.error(red(`No worktree with slug: ${parsed.slug}`));
      return 1;
    }
  } else {
    if (!isInteractive()) {
      console.error(red("Picking a worktree requires a TTY."));
      return 2;
    }
    const idx = yield* pickIndex(
      wts.map((w) => w.slug),
      "Remove which worktree?",
    );
    if (idx === null) return 0;
    target = wts[idx];
  }
  if (!target) return 1;

  // Busy check — surface the holder and bail.
  const lock = yield* io.sync("read worktree lock", () => lockStatus(target.slug));
  if (lock) {
    const age = lockAge(lock);
    console.log(
      yellow(
        `${target.slug} is busy: ${lockLabel(lock)}${age ? ` (${age})` : ""}`,
      ),
    );
    const logPath = yield* io.sync("find latest destroy log", () => latestLogFor(target.slug));
    if (logPath) console.log(dim(`  log: ${logPath}`));
    return 1;
  }

  // Independent of the dirty/unpushed guards below and checked first,
  // because it is the one hazard that is not about the working tree:
  // a landed branch owing a deployed-environment check
  // (`--verify-after-merge`) loses the obligation along with the
  // checkout, and nothing afterwards records that the check never
  // happened. `--force` still overrides — a per-worktree decision, same
  // as every other guard here.
  if (!parsed.force) {
    const owed = (yield* io.sync("read wt state", readWtState)).slugs[target.slug]?.work;
    if (owesPostMergeVerification(owed, true)) {
      console.log(
        yellow(`${target.slug}: post-merge verification still owed`),
      );
      console.log(`  ${owed!.verifyAfterMerge}`);
      console.log(
        dim(
          `  run it, then: wt status ${target.slug} verified -m "<what you checked>"`,
        ),
      );
      if (parsed.yes || !isInteractive()) {
        console.error(red("Refusing to remove without --force."));
        return 1;
      }
      if (!(yield* confirm("Remove anyway?", false))) return 0;
    }
  }

  let force = parsed.force;
  if (!force) {
    const dirty = yield* worktreeIsDirty(target.path);
    // A squash-merged branch keeps its pre-squash commits locally, which
    // read as "unpushed" once origin prunes the branch — but the work IS
    // landed. Suppress the unpushed guard when the branch reads as
    // merged/gone (the same classification the row's status uses), so a
    // landed worktree tears down without a spurious --force.
    const landed =
      !dirty && target.branch
        ? (yield* branchIsMerged({
            slug: target.slug,
            branch: target.branch,
            path: target.path,
          })) || (yield* branchIsGone(target.branch, target.path))
        : false;
    // `pushCounts`, not `unpushedCommits`: wt points a worktree branch's
    // upstream at its BASE, so the @{u}-based count measures ahead-of-base
    // and a fully pushed branch with an open PR refused to be removed as
    // "3 unpushed commits". `unpushed` counts against `origin/<branch>`.
    const unpushed = dirty || landed ? 0 : (yield* pushCounts(target.path)).unpushed;
    // null = git couldn't answer; a data-loss guard fails cautious, so
    // treat unknown like unpushed work rather than like a clean tree.
    if (dirty || unpushed === null || unpushed > 0) {
      const reason = dirty
        ? "uncommitted changes"
        : unpushed === null
          ? "couldn't verify pushed state"
          : `${unpushed} unpushed commit${unpushed === 1 ? "" : "s"}`;
      console.log(yellow(`${target.slug}: ${reason}`));
      if (parsed.yes) {
        console.error(red("Refusing to remove without --force."));
        return 1;
      }
      if (!isInteractive()) {
        console.error(
          red("Pass --force (or --yes with --force) to remove anyway."),
        );
        return 1;
      }
      if (!(yield* confirm("Remove anyway?", false))) return 0;
      force = true;
    }
  }

  const destroyStage = yield* decideDestroyStage(
    target,
    parsed.destroyStage,
    parsed.yes,
  );
  const deleteBranch = yield* decideDeleteBranch(target, parsed.deleteBranch);

  if (parsed.background) {
    // Launch first. A bad executable/log path must not tear down a live
    // session for a removal that never started.
    const logPath = yield* spawnBackgroundRemove(target.slug, {
      force,
      destroyStage,
      deleteBranch,
    });
    // killAllSessionsFor folds its own failures; nothing left to catch here.
    yield* killAllSessionsFor(target.slug);
    console.log(
      green(
        `✓ dispatched destroy of ${bold(target.slug)} ${dim("in background")}`,
      ),
    );
    console.log(dim(`  → log: ${logPath}`));
    console.log(dim(`  → tail with `) + bold(`wt logs ${target.slug}`));
    return 0;
  }

  const result = yield* removeWorktree(target, {
    force,
    destroyStage,
    deleteBranch,
    onLog: (line) => console.log(dim(line)),
    onPhase: (phase) => console.log(dim(`· ${phase}`)),
  }).pipe(
    // Keep the ok/failed branching the CLI has always had, rather than
    // letting a plain remove failure propagate as a defect-shaped tagged
    // error.
    Effect.catchTag("LifecycleError", (error) =>
      Effect.succeed({
        ok: false,
        message: error.message,
        destroyedStage: false,
        deletedBranch: false,
      }),
    ),
  );

  if (!result.ok) {
    console.error(red(`Failed: ${result.message}`));
    if (!force) {
      console.log(
        dim(`  retry with `) +
          bold(`wt rm ${target.slug} --force`) +
          dim(" to override"),
      );
    }
    return 1;
  }
  // Do not tear sessions down for a removal that was refused or failed.
  yield* killAllSessionsFor(target.slug);
  console.log(green(`✓ ${result.message}`));
  if (result.destroyedStage)
    console.log(green(`✓ destroyed stage ${target.stage}`));
  if (result.deletedBranch)
    console.log(green(`✓ deleted branch ${target.branch}`));
  return 0;
});
