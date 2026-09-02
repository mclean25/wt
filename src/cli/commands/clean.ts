import { Data, Effect } from "effect";

import { fetchGithubEffect } from "../../core/github.ts";
import { removeWorktree, spawnBackgroundRemove } from "../../core/lifecycle.ts";
import { isOurStageDeployed } from "../../core/stage-safety.ts";
import { killAllSessionsFor } from "../../core/tmux.ts";
import type { Status, Worktree } from "../../core/types.ts";
import { StatusKind } from "../../core/types.ts";
import {
  fetchOrigin,
  listWorktrees,
  worktreeIsDirty,
  worktreeStatus,
} from "../../core/worktree.ts";
import { owesPostMergeVerification } from "../../core/work-status.ts";
import { readWtState } from "../../core/wtstate.ts";
import { hasHelpFlag } from "../args.ts";
import { bold, cyan, dim, green, red, yellow } from "../colors.ts";
import { confirmEffect, isInteractive, type PromptError } from "../prompt.ts";

const USAGE = `usage: wt clean [options]

Remove every worktree that is merged or whose remote branch is gone
("gone" only auto-cleans when a merged PR confirms the content
actually landed; anything riskier is left for an explicit \`wt rm\`).

Never forces: a candidate holding uncommitted changes is listed and
kept, however thoroughly its branch landed. There is no --force here
on purpose — discard work deliberately, one worktree at a time, with
\`wt rm <slug> --force\`.

  --yes, -y               skip confirmation (required non-interactively)
  --destroy-stage / --no-destroy-stage
                           apply to all candidates (default: per-worktree,
                           destroy iff its stage is live)
  --foreground             run removals synchronously (background dispatch
                           is the default here, unlike \`rm\`)`;

type Flags = {
  yes: boolean;
  destroyStage: boolean | null;
  background: boolean;
};

function parse(argv: string[]): Flags | { error: string } {
  let yes = false;
  let destroyStage: boolean | null = null;
  let background = true;
  for (const a of argv) {
    if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--destroy-stage") destroyStage = true;
    else if (a === "--no-destroy-stage") destroyStage = false;
    else if (a === "--background") background = true;
    else if (a === "--foreground") background = false;
    else return { error: `unknown flag: ${a}` };
  }
  return { yes, destroyStage, background };
}

export class CleanCommandError extends Data.TaggedError("CleanCommandError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type RemoveResult = Awaited<ReturnType<typeof removeWorktree>>;

export type CleanDeps = {
  readonly fetchOrigin: typeof fetchOrigin;
  readonly listWorktrees: typeof listWorktrees;
  readonly worktreeStatus: typeof worktreeStatus;
  readonly fetchGithub: typeof fetchGithubEffect;
  readonly worktreeIsDirty: typeof worktreeIsDirty;
  readonly readWtState: typeof readWtState;
  readonly removeWorktree: (
    wt: Worktree,
    opts: Parameters<typeof removeWorktree>[1],
  ) => Promise<RemoveResult>;
  readonly spawnBackgroundRemove: typeof spawnBackgroundRemove;
  readonly isOurStageDeployed: typeof isOurStageDeployed;
  readonly killAllSessionsFor: typeof killAllSessionsFor;
};

const defaultDeps: CleanDeps = {
  fetchOrigin,
  listWorktrees,
  worktreeStatus,
  fetchGithub: fetchGithubEffect,
  worktreeIsDirty,
  readWtState,
  removeWorktree,
  spawnBackgroundRemove,
  isOurStageDeployed,
  killAllSessionsFor,
};

function commandIo<A>(
  operation: string,
  f: () => A,
): Effect.Effect<A, CleanCommandError> {
  return Effect.try({
    try: f,
    catch: (cause) => new CleanCommandError({ operation, cause }),
  });
}

function commandPromise<A>(
  operation: string,
  f: () => Promise<A>,
): Effect.Effect<A, CleanCommandError> {
  return Effect.tryPromise({
    try: f,
    catch: (cause) => new CleanCommandError({ operation, cause }),
  });
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function runWithDeps(
  argv: string[],
  deps: CleanDeps,
): Effect.Effect<number, CleanCommandError | PromptError> {
  return Effect.gen(function* () {
    if (hasHelpFlag(argv)) {
      console.log(USAGE);
      return 0;
    }
    const parsed = parse(argv);
    if ("error" in parsed) {
      console.error(red(parsed.error));
      return 2;
    }

    console.log(dim("Fetching origin..."));
    const fetched = yield* Effect.either(
      commandPromise("fetch origin", deps.fetchOrigin),
    );
    if (fetched._tag === "Left") {
      console.error(
        red(`Failed to fetch origin: ${causeMessage(fetched.left.cause)}`),
      );
      return 1;
    }

    const wts = (yield* commandPromise(
      "list worktrees",
      deps.listWorktrees,
    )).filter((w) => !w.isMain && w.branch);

    const candidates: [Worktree, Status][] = [];
    const skipped: [Worktree, Status][] = [];
    const gone: [Worktree, Status][] = [];
    const dirtyRows: Worktree[] = [];
    for (const w of wts) {
      const st = yield* commandPromise(`read ${w.slug} status`, () =>
        deps.worktreeStatus(w),
      );
      if (st.kind === StatusKind.Busy) skipped.push([w, st]);
      else if (st.kind === StatusKind.Merged) candidates.push([w, st]);
      else if (st.kind === StatusKind.Gone) gone.push([w, st]);
    }

    // `[gone]` only says the remote ref vanished. Resolve every candidate in
    // the same chunked GraphQL path as the TUI; never issue one request per row.
    // A failed PR fetch leaves every gone row risky rather than treating missing
    // data as proof that the work landed.
    const risky: Worktree[] = [];
    if (gone.length > 0) {
      const github = yield* Effect.either(
        deps
          .fetchGithub(gone.map(([w]) => w.branch))
          .pipe(
            Effect.mapError(
              (cause) =>
                new CleanCommandError({
                  operation: "fetch pull requests",
                  cause,
                }),
            ),
          ),
      );
      if (github._tag === "Left") {
        console.error(
          red(
            `Failed to verify gone branches: ${causeMessage(github.left.cause)}`,
          ),
        );
        risky.push(...gone.map(([w]) => w));
      } else {
        for (const [w, st] of gone) {
          if (github.right.prs.get(w.branch)?.state === "MERGED") {
            candidates.push([w, st]);
          } else {
            risky.push(w);
          }
        }
      }
    }

    // A landed branch says nothing about the working tree, and the two
    // drift apart the moment anyone re-opens a session in a merged
    // worktree. `clean` never forces, but no backend enforces that for us:
    // `rift remove` trashes a dirty checkout, and a rift worktree is an
    // independent clone, so its objects, branch and reflog go with the
    // directory. Filtered AFTER classification so the report only names
    // worktrees this command would otherwise have destroyed.
    //
    // Unpushed commits are deliberately not a hazard here: every candidate
    // is merged-or-landed, and a squash-merge leaves pre-squash commits
    // locally that read as unpushed without being unsaved work.
    // Same filter, second reason. A branch carrying
    // `--verify-after-merge` owes a check that could only run once it
    // deployed, and this command's whole population is branches that
    // just did. Sweeping one deletes the checkout AND the only record
    // that the check was ever owed, after which nothing anywhere says it
    // never happened — so the row is kept until someone asserts
    // `verified`. This is the reason the field exists.
    const slugStates = (yield* commandIo("read wt state", deps.readWtState))
      .slugs;
    const unverified: Worktree[] = [];
    for (let i = candidates.length - 1; i >= 0; i--) {
      const [w] = candidates[i]!;
      if (
        yield* commandPromise(`check ${w.slug} working tree`, () =>
          deps.worktreeIsDirty(w.path),
        )
      ) {
        candidates.splice(i, 1);
        dirtyRows.unshift(w);
      } else if (owesPostMergeVerification(slugStates[w.slug]?.work, true)) {
        candidates.splice(i, 1);
        unverified.unshift(w);
      }
    }

    if (skipped.length) {
      console.log(dim("Skipping (already in progress):"));
      for (const [w, st] of skipped) {
        const age = st.age ? dim(` (${st.age})`) : "";
        console.log(
          `  ${cyan(w.slug)} — ${yellow(st.label)}${age}  ${dim(`wt logs ${w.slug}`)}`,
        );
      }
    }

    if (dirtyRows.length) {
      console.log(dim("Skipping (uncommitted changes — clean never forces):"));
      for (const w of dirtyRows) {
        console.log(
          `  ${cyan(w.slug)}  ${dim(`commit them, or discard with: wt rm ${w.slug} --force`)}`,
        );
      }
    }

    if (unverified.length) {
      console.log(dim("Skipping (post-merge verification still owed):"));
      for (const w of unverified) {
        const steps = slugStates[w.slug]?.work?.verifyAfterMerge ?? "";
        console.log(`  ${cyan(w.slug)}  ${steps}`);
        console.log(
          `    ${dim(`run it, then: wt status ${w.slug} verified -m "<what you checked>"`)}`,
        );
      }
    }

    if (risky.length) {
      console.log(
        dim(
          "Skipping (remote gone but no merged PR — may hold unmerged work):",
        ),
      );
      for (const w of risky) {
        console.log(
          `  ${cyan(w.slug)}  ${dim(`remove explicitly with: wt rm ${w.slug}`)}`,
        );
      }
    }

    if (candidates.length === 0) {
      console.log(green("Nothing to clean."));
      return 0;
    }

    console.log(bold("Cleanup candidates:"));
    for (const [w, st] of candidates) {
      const tag =
        st.kind === StatusKind.Merged
          ? green("merged")
          : yellow("gone (squash-merged or force-deleted)");
      console.log(`  ${cyan(w.slug.padEnd(40))}  ${tag}  ${dim(w.branch)}`);
    }

    if (!parsed.yes) {
      if (!isInteractive()) {
        console.error(red("Confirming clean requires a TTY. Pass -y."));
        return 2;
      }
      if (!(yield* confirmEffect(`Remove ${candidates.length}?`, true)))
        return 0;
    }

    let failed = false;
    for (const [w] of candidates) {
      // Explicit flag wins; default is "destroy iff *our* stage is
      // actually deployed". `isOurStageDeployed` rejects worktrees
      // whose outputs.json is from a foreign deploy (e.g. someone ran
      // `deployProductionApp.sh` here), so we never auto-destroy on
      // those. `removeWorktree` re-checks via `safeStage` before
      // shelling out — this is the surface-level UX gate.
      const destroy =
        parsed.destroyStage !== null
          ? parsed.destroyStage
          : yield* commandIo(`check ${w.slug} stage`, () =>
              deps.isOurStageDeployed(w),
            );

      if (parsed.background) {
        const launched = yield* Effect.either(
          commandIo(`launch ${w.slug} removal`, () =>
            deps.spawnBackgroundRemove(w.slug, {
              force: false,
              destroyStage: destroy,
              deleteBranch: true,
            }),
          ),
        );
        if (launched._tag === "Right") {
          console.log(
            green(`✓ dispatched ${w.slug}`) + dim(` → ${launched.right}`),
          );
        } else {
          failed = true;
          console.log(red(`✗ ${w.slug}: ${causeMessage(launched.left.cause)}`));
        }
      } else {
        const removed = yield* Effect.either(
          commandPromise(`remove ${w.slug}`, () =>
            deps.removeWorktree(w, {
              force: false,
              destroyStage: destroy,
              deleteBranch: true,
              onLog: (line) => console.log(dim(`  ${line}`)),
              onPhase: (phase) => console.log(dim(`· ${phase}`)),
            }),
          ),
        );
        if (removed._tag === "Left") {
          failed = true;
          console.log(red(`✗ ${w.slug}: ${causeMessage(removed.left.cause)}`));
        } else if (!removed.right.ok) {
          failed = true;
          console.log(red(`✗ ${w.slug}: ${removed.right.message}`));
        } else {
          console.log(green(`✓ ${removed.right.message}`));
          const cleanup = yield* Effect.either(
            commandPromise(`kill ${w.slug} sessions`, () =>
              deps.killAllSessionsFor(w.slug),
            ),
          );
          if (cleanup._tag === "Left") {
            failed = true;
            console.log(
              red(
                `✗ ${w.slug}: removed, but session cleanup failed: ${causeMessage(cleanup.left.cause)}`,
              ),
            );
          }
        }
      }
    }
    return failed ? 1 : 0;
  });
}

export function run(
  argv: string[],
): Effect.Effect<number, CleanCommandError | PromptError> {
  return runWithDeps(argv, defaultDeps);
}
