import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Data, Effect, Schedule } from "effect";

import { listRiftWorktreePaths } from "./backend.ts";
import { config } from "./config.ts";
import { branchIsGoneEffect, branchIsMergedEffect, effectiveBaseOrTrunkEffect, freshBaseRevEffect, gitEffect, gitQuietEffect, gitRunEffect, invalidateMainFirstParents, localBranchExistsEffect, originBranchExistsEffect, revParseEffect } from "./git.ts";
import { resolveMainSyncInstall } from "./install.ts";
import { lockAge, lockLabel, lockStatus, tryAcquireLock, type LockHandle } from "./locks.ts";
import { createLogger } from "./logger.ts";
import { latestLogFor } from "./logs.ts";
import { runOkEffect, runQuietEffect, runStreamingEffect, type ProcError } from "./proc.ts";
import { computeStage } from "./stage.ts";
import { type Status, StatusKind, type Worktree } from "./types.ts";

const log = createLogger("[worktree]");
const FETCH_ORIGIN_LOCK = "__fetch_origin__";
let fetchOriginInFlight: Promise<void> | null = null;
export class WorktreeError extends Data.TaggedError("WorktreeError")<{
  readonly operation: "list" | "fetch-origin";
  readonly cause: unknown;
}> {
  override get message(): string { return this.cause instanceof Error ? this.cause.message : String(this.cause); }
}

export function listWorktreesEffect(): Effect.Effect<Worktree[], WorktreeError> {
  return gitEffect(["worktree", "list", "--porcelain"]).pipe(
    Effect.map(parseWorktrees),
    Effect.mapError((cause) => new WorktreeError({ operation: "list", cause })),
  );
}

export const listWorktrees = (): Promise<Worktree[]> => Effect.runPromise(listWorktreesEffect());

function parseWorktrees(out: string): Worktree[] {
  const lines = [...out.split("\n"), ""];
  const worktrees: Worktree[] = [];
  let block: Record<string, string> = {};
  for (const line of lines) {
    if (!line) {
      if (block.worktree) {
        const path = block.worktree;
        let branch = (block.branch ?? "").replace(/^refs\/heads\//, "");
        // A rebase detaches HEAD, so mid-rebase (the engine replaying, or
        // a `/restack`/hand resolve sitting on a conflict) the porcelain
        // reports `detached` and the branch would read "" — which strips
        // the row of everything keyed by branch: the PR lookup
        // (`pickPrForWorktree` bails on a branchless worktree, blanking
        // the PR/checks/review badges), the github query's branch-list
        // key, and stack membership (`buildStackIndex`). Git records
        // which branch the rebase is rewriting in its own state
        // (`rebase-merge/head-name`); recover it so the row keeps its
        // identity for the duration instead of dissolving and snapping
        // back when the rebase finishes.
        if (!branch && "detached" in block) {
          branch = rebasingBranch(path);
        }
        const isMain = path === config.paths.mainClone;
        const slug = isMain ? "main" : basename(path);
        // `git worktree list` includes worktrees created by other tools
        // against the same repo. Codex Desktop, for example, uses
        // `~/.codex/worktrees/<id>/<repo-name>`, which gives every row the
        // same leaf slug. wt owns only the configured worktree root.
        if (!isMain && !isManagedWorktreePath(path)) {
          block = {};
          continue;
        }
        // Skip throwaway detached worktrees (e.g. tooling-created)
        // (under tmpdir, registered in the main clone) — they're internal
        // scaffolding, present only for the duration of a verify run, and must
        // never surface as a worktree row.
        if (!isMain && slug.startsWith("wt-verify-")) {
          block = {};
          continue;
        }
        worktrees.push({
          path,
          branch,
          isMain,
          slug,
          stage: resolveStage(path, slug),
        });
      }
      block = {};
      continue;
    }
    const sp = line.indexOf(" ");
    if (sp === -1) block[line] = "";
    else block[line.slice(0, sp)] = line.slice(sp + 1);
  }
  appendRiftWorktrees(worktrees);
  return worktrees;
}

/**
 * Rift checkouts are independent clones, so `git worktree list` never
 * reports them — discovery scans the worktree root for `.rift` markers
 * and synthesizes rows here. Done regardless of the configured backend
 * so a rift checkout stays visible after the user flips the default
 * back to git-worktree (the backend is detected, not stored). Branch
 * resolution reads `.git/HEAD` directly (pure fs, no subprocess), with
 * the same mid-rebase recovery the porcelain path uses.
 */
function appendRiftWorktrees(worktrees: Worktree[]): void {
  // Dedup against the porcelain rows by path. Both sides are used raw (no
  // realpath): git's porcelain output is already canonical and
  // `listRiftWorktreePaths` joins the config's `worktree_root`, which wt
  // assumes canonical throughout (same assumption `isManagedWorktreePath`
  // makes). A checkout can't be both a linked worktree AND carry a `.rift`
  // marker under normal operation, so the two sets don't actually overlap.
  const seen = new Set(worktrees.map((w) => w.path));
  for (const path of listRiftWorktreePaths(config.paths.worktreeRoot)) {
    if (seen.has(path)) continue;
    const slug = basename(path);
    let branch = headBranch(path);
    if (!branch) branch = rebasingBranch(path);
    worktrees.push({
      path,
      branch,
      isMain: false,
      slug,
      stage: resolveStage(path, slug),
    });
  }
}

/**
 * The branch a checkout's `.git/HEAD` points at, or "" when HEAD is
 * detached (mid-rebase, or a rift clone before its branch switch). Pure
 * fs read — rift discovery runs on every worktree-list refresh, so it
 * must not spawn a subprocess per checkout.
 */
function headBranch(wtPath: string): string {
  const gitdir = gitDirOf(wtPath);
  if (!gitdir) return "";
  try {
    const head = readFileSync(join(gitdir, "HEAD"), "utf8").trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1]! : "";
  } catch {
    return "";
  }
}

function isManagedWorktreePath(path: string): boolean {
  const rel = relative(config.paths.worktreeRoot, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The private git dir behind a checkout: `.git` itself for the main
 * clone, the `gitdir:` pointer's target for a linked worktree. Null
 * when unreadable (racing a destroy).
 */
function gitDirOf(wtPath: string): string | null {
  const dotGit = join(wtPath, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (!m) return null;
    const target = m[1]!;
    return isAbsolute(target) ? target : join(wtPath, target);
  } catch {
    return null;
  }
}

/**
 * The branch an in-progress rebase is rewriting in `wtPath`, or "" when
 * no rebase is running (or it's rebasing a genuinely detached HEAD).
 * Read from git's rebase state — `head-name` under `rebase-merge/`
 * (merge backend, the default) or `rebase-apply/` (am backend) holds
 * the full ref of the branch that will be reattached when the rebase
 * finishes. Sync fs reads, only reached for detached worktrees.
 */
function rebasingBranch(wtPath: string): string {
  const gitdir = gitDirOf(wtPath);
  if (!gitdir) return "";
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    try {
      const name = readFileSync(join(gitdir, dir, "head-name"), "utf8").trim();
      if (name.startsWith("refs/heads/")) {
        return name.replace(/^refs\/heads\//, "");
      }
    } catch {
      // No state for this backend — try the other, then give up.
    }
  }
  return "";
}

/**
 * `.sst/stage` is authoritative — pinned at create-time and used by
 * SST itself. Fall back to recomputing from the slug for worktrees
 * that haven't been initialised yet.
 */
function resolveStage(path: string, slug: string): string {
  const pinned = join(path, ".sst", "stage");
  if (existsSync(pinned)) {
    try {
      return readFileSync(pinned, "utf8").trim();
    } catch (err) {
      // .sst/stage exists but unreadable (perms, truncation mid-write) —
      // fall through to the slug-derived default.
      void err;
    }
  }
  return computeStage(slug);
}

/**
 * The worktree containing `cwd` (path-prefix match, normalized), or
 * null. THE resolver for "which worktree am I in" across CLI commands
 * (`wt status`, `wt dev`, `wt doctor`) — one implementation so the
 * matching rule can't drift.
 */
export function worktreeAtCwd(
  worktrees: readonly Worktree[],
  cwd: string = process.cwd(),
): Worktree | null {
  const here = resolve(cwd);
  for (const w of worktrees) {
    const wp = resolve(w.path);
    if (here === wp || here.startsWith(`${wp}/`)) return w;
  }
  return null;
}

export type SyncCounts = { ahead: number; behind: number };
export type SyncState = {
  /**
   * HEAD vs the effective base. For trunk-targeted branches that's
   * `origin/<config.branch.base>`; for stacked branches it's the
   * parent worktree's branch — same resolution as the diff base, so
   * "behind" reads as "behind your actual base," not "behind trunk."
   */
  main: SyncCounts;
  /**
   * HEAD vs `origin/<branch>` — the branch's OWN copy on the remote.
   * Null when no such ref exists (never pushed, or pushed and since
   * pruned).
   */
  remote: SyncCounts | null;
};

function countsForEffect(wtPath: string, range: string): Effect.Effect<SyncCounts, ProcError | WorktreeError> {
  return runOkEffect(["git", "rev-list", "--left-right", "--count", range], { cwd: wtPath }).pipe(
    Effect.flatMap((out) => {
      const match = out.trim().match(/^(\d+)\s+(\d+)$/);
      return match
        ? Effect.succeed({ behind: Number.parseInt(match[1]!, 10), ahead: Number.parseInt(match[2]!, 10) })
        : Effect.fail(new WorktreeError({ operation: "list", cause: new Error(`unexpected rev-list output for ${range}: ${out}`) }));
    }),
  );
}

/**
 * Ahead/behind of HEAD vs both the effective base and the branch's own
 * copy on origin.
 *
 * `remote` deliberately measures against `origin/<branch>` and NEVER
 * against `@{u}`: wt points a worktree branch's upstream at its BASE
 * (e.g. `origin/staging`), so an @{u} count answers the same question
 * `main` already answers. That made the two bracket groups render
 * identical numbers, and — far worse — made "ahead of base" the input
 * to every unpushed guard, so a fully pushed branch with an open PR
 * refused to be removed as "3 unpushed commits". An explicit-refspec
 * push (`git push origin <branch>`, how agents push) sets no tracking
 * at all, so the branch's own ref is the only reliable answer anyway.
 *
 * `effectiveBase` defaults to `origin/<config.branch.base>` (trunk).
 * Stacked worktrees pass the parent's branch instead so the brackets
 * read as "vs your actual base" rather than "vs main." Mirrors the
 * effective-base resolution used by the diff context.
 */
export const syncState = (wtPath: string, effectiveBase?: string | null): Promise<SyncState> =>
  Effect.runPromise(syncStateEffect(wtPath, effectiveBase));

export function syncStateEffect(wtPath: string, effectiveBase?: string | null) {
  return Effect.gen(function* () {
    const resolved = yield* effectiveBaseOrTrunkEffect(wtPath, effectiveBase);
    const base = yield* freshBaseRevEffect(wtPath, resolved);
    const main = yield* countsForEffect(wtPath, `${base}...HEAD`);
    const branch = (yield* runOkEffect(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: wtPath })).trim();
    if (!branch || branch === "HEAD") return { main, remote: null };
    const originRef = `origin/${branch}`;
    const exists = yield* runQuietEffect(["git", "rev-parse", "--verify", "--quiet", originRef], { cwd: wtPath });
    if (!exists) return { main, remote: null };
    return { main, remote: yield* countsForEffect(wtPath, `${originRef}...HEAD`) };
  });
}

/**
 * Paths flagged by `git status --porcelain` (relative to the worktree
 * root). Empty array == clean. Each entry is the porcelain `XY path`
 * line with the leading 3 chars stripped — fine for plain modifies /
 * adds / deletes / untracked, treats renames as the literal `old ->
 * new` payload (which callers comparing against a known path will
 * naturally fall through on).
 */
export const worktreeDirtyFiles = (wtPath: string): Promise<string[]> =>
  Effect.runPromise(worktreeDirtyFilesEffect(wtPath));

export const worktreeDirtyFilesEffect = (wtPath: string) =>
  runOkEffect(["git", "status", "--porcelain"], { cwd: wtPath }).pipe(
    Effect.map((porcelain) => porcelain.split("\n").filter((line) => line.length > 0).map((line) => line.slice(3))),
  );

/**
 * True when the working tree has uncommitted changes — matches git's
 * own "dirty" convention. Unpushed commits are tracked separately via
 * `syncState`; callers that want to guard against losing *any* kind of
 * work (e.g. `wt rm`) should check both.
 */
export const worktreeIsDirty = (wtPath: string): Promise<boolean> =>
  Effect.runPromise(worktreeIsDirtyEffect(wtPath));
export const worktreeIsDirtyEffect = (wtPath: string) =>
  worktreeDirtyFilesEffect(wtPath).pipe(Effect.map((files) => files.length > 0));

/**
 * Tracked-file changes only (staged or unstaged); untracked files don't
 * count. The stack replay gate uses this — `git rebase` is safe alongside
 * untracked files (it refuses cleanly if one would be overwritten), and the
 * workflow itself drops files like `prompt.txt` into slice worktrees by
 * convention, so blocking a replay on them is self-inflicted friction.
 */
export const worktreeHasTrackedChanges = (wtPath: string): Promise<boolean> =>
  Effect.runPromise(worktreeHasTrackedChangesEffect(wtPath));
export const worktreeHasTrackedChangesEffect = (wtPath: string) =>
  runOkEffect(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: wtPath }).pipe(
    Effect.map((porcelain) => porcelain.split("\n").some((line) => line.trim().length > 0)),
  );

/**
 * Count of commits on HEAD that aren't on the branch's upstream (or on
 * origin/main if there's no upstream). Used by remove flows to warn
 * about work that would be lost if the worktree is destroyed. Returns
 * `null` when git couldn't answer — this feeds a data-loss guard, so
 * "couldn't determine" must never masquerade as "nothing to lose";
 * callers treat null as unpushed-work-unknown and stay cautious.
 */
export function unpushedCommitsEffect(wtPath: string) {
  return Effect.gen(function* () {
    // `@{u}` is resolved to its ref NAME rather than used directly, so
    // the trunk case is recognizable to `freshBaseRev` — wt points a
    // worktree's upstream at its base, so for an unstacked worktree
    // `@{u}` IS `origin/<trunk>`, and that is exactly the ref a rift
    // clone holds a stale copy of.
    const hasUpstream = yield* runQuietEffect(
      ["git", "rev-parse", "--abbrev-ref", "@{u}"],
      { cwd: wtPath },
    );
    const upstream = hasUpstream
      ? (yield* runOkEffect(["git", "rev-parse", "--abbrev-ref", "@{u}"], { cwd: wtPath })).trim()
      : "";
    const base = yield* freshBaseRevEffect(
      wtPath,
      upstream || `origin/${config.branch.base}`,
    );
    const ahead = yield* runOkEffect(
      ["git", "rev-list", "--count", `${base}..HEAD`],
      { cwd: wtPath },
    );
    return parseInt(ahead, 10) || 0;
  }).pipe(Effect.catchAll((err) => Effect.sync(() => {
    log.error(err instanceof Error ? err : String(err), { wtPath });
    return null;
  })));
}
export const unpushedCommits = (wtPath: string): Promise<number | null> =>
  Effect.runPromise(unpushedCommitsEffect(wtPath));

export type PushCounts = {
  /**
   * Commits on HEAD that origin doesn't have for THIS branch. When the
   * branch has no origin counterpart, nothing is pushed, so this falls
   * back to the ahead-of-base count (and `pushed` goes false).
   */
  unpushed: number | null;
  /**
   * Commits ahead of the branch's upstream/base — the restack-pressure
   * signal. This is what `unpushedCommits` measures.
   */
  aheadOfBase: number | null;
  /** Whether `origin/<branch>` exists at all. */
  pushed: boolean | null;
};

/**
 * Push/divergence counts for `wt ls --json`. Null = couldn't determine;
 * consumers must not read it as 0.
 *
 * wt sets a worktree branch's upstream to its BASE (e.g.
 * `origin/staging`), so the @{u}-based `unpushedCommits` count really
 * measures "ahead of base" — the fleet manager misread that as "worker
 * never pushed". This keeps both numbers apart: `unpushed` counts
 * against `origin/<branch>` when that ref exists (true unpushed), and
 * `aheadOfBase` carries the old measurement.
 */
export function pushCountsEffect(wtPath: string) {
  return Effect.gen(function* () {
    const aheadOfBase = yield* unpushedCommitsEffect(wtPath);
    return yield* Effect.gen(function* () {
      const branch = (
        yield* runOkEffect(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: wtPath })
      ).trim();
      // Detached HEAD reports the literal "HEAD" — no branch, no counterpart.
      if (branch && branch !== "HEAD") {
        const originRef = `origin/${branch}`;
        const originExists = yield* runQuietEffect(
          ["git", "rev-parse", "--verify", "--quiet", originRef],
          { cwd: wtPath },
        );
        if (originExists) {
          const count = yield* runOkEffect(
            ["git", "rev-list", "--count", `${originRef}..HEAD`],
            { cwd: wtPath },
          );
          return { unpushed: parseInt(count, 10) || 0, aheadOfBase, pushed: true };
        }
      }
      return { unpushed: aheadOfBase, aheadOfBase, pushed: false };
    }).pipe(Effect.catchAll((err) => Effect.sync(() => {
      log.error(err instanceof Error ? err : String(err), { wtPath });
      return { unpushed: null, aheadOfBase, pushed: null };
    })));
  });
}
export const pushCounts = (wtPath: string): Promise<PushCounts> =>
  Effect.runPromise(pushCountsEffect(wtPath));

export function worktreeStatusEffect(wt: Worktree): Effect.Effect<Status, ProcError> {
  const lock = lockStatus(wt.slug);
  if (lock) {
    return Effect.succeed({
      kind: StatusKind.Busy,
      label: lockLabel(lock),
      age: lockAge(lock) ?? undefined,
      log: latestLogFor(wt.slug) ?? undefined,
      pid: lock.pid,
      op: lock.op,
    });
  }
  if (!existsSync(wt.path)) {
    return Effect.succeed({ kind: StatusKind.Missing, label: "missing" });
  }
  return Effect.gen(function* () {
    if (wt.branch) {
      if (yield* branchIsGoneEffect(wt.branch, wt.path)) {
        return { kind: StatusKind.Gone, label: "gone (squash-merged or deleted)" } as Status;
      }
      if (yield* branchIsMergedEffect({ slug: wt.slug, branch: wt.branch, path: wt.path })) {
        return { kind: StatusKind.Merged, label: "merged into origin/main" } as Status;
      }
    }
    if (yield* worktreeIsDirtyEffect(wt.path)) return { kind: StatusKind.Dirty, label: "dirty" } as Status;
    return { kind: StatusKind.Clean, label: "clean" } as Status;
  });
}
export const worktreeStatus = (wt: Worktree): Promise<Status> => Effect.runPromise(worktreeStatusEffect(wt));

function acquireFetchOriginLockEffect(): Effect.Effect<LockHandle, WorktreeError> {
  return Effect.suspend(() => {
    const handle = tryAcquireLock(FETCH_ORIGIN_LOCK, "fetch-origin", {
      phase: "fetch origin",
    });
    return handle
      ? Effect.succeed(handle)
      : Effect.fail(new WorktreeError({ operation: "fetch-origin", cause: new Error("another origin fetch is still running") }));
  }).pipe(Effect.retry(Schedule.intersect(Schedule.spaced("250 millis"), Schedule.recurs(59))));
}

function fetchOriginLockedEffect(opts: { onWarn?: (msg: string) => void } = {}) {
  return Effect.acquireUseRelease(
    acquireFetchOriginLockEffect(),
    () => Effect.gen(function* () {
    const fetch = yield* gitRunEffect(["fetch", "origin", "--prune"]);
    if (fetch.exitCode !== 0) {
      return yield* new WorktreeError({ operation: "fetch-origin", cause: new Error(
        `git fetch origin failed: ${(fetch.stderr || fetch.stdout).trim() || `exit ${fetch.exitCode}`}`) });
    }
    const main = config.paths.mainClone;
    // Resolved ONCE, not per branch: at most one of them can be the
    // checked-out head, and only that one needs the dirty-tree dance.
    let head: string | null = null;
    if (yield* gitQuietEffect(["symbolic-ref", "--quiet", "HEAD"], main)) {
      head = (yield* gitEffect(["symbolic-ref", "--quiet", "--short", "HEAD"], main)).trim();
    }
    // Trunk first, then whatever else the user wants current. Deduped,
    // so naming the base in `keep_fresh` is redundant rather than a
    // double fast-forward.
    for (const branch of new Set([config.branch.base, ...config.branch.keepFresh])) {
      yield* syncLocalBranchEffect(branch, {
        main,
        checkedOut: head === branch,
        // `base` keeps its historical skip-if-absent semantics — it is a
        // branch wt assumes the clone already manages, and creating one
        // that has never existed there is not this function's call. A
        // `keep_fresh` entry is the opposite: the user asked for a local
        // head that tracks origin, so ABSENT is the condition it exists
        // to fix, and skipping would make the option a silent no-op.
        create: branch !== config.branch.base,
        onWarn: opts.onWarn,
      });
    }
    yield* freshenWorktreeTrunkRefsEffect(main);
    }),
    (handle) => Effect.sync(() => handle.release()),
  ).pipe(Effect.mapError((cause) => cause instanceof WorktreeError ? cause : new WorktreeError({ operation: "fetch-origin", cause })));
}

/**
 * Point every worktree's OWN `origin/<trunk>` at the tip the main clone
 * just fetched.
 *
 * Under `rift` a worktree is an independent clone whose remote-tracking
 * refs are only as fresh as the last fetch inside it, and nothing was
 * fetching there — `fetchOrigin` runs in the main clone. The ref decays
 * quietly from the moment the clone is created, and EVERYTHING keyed to
 * the base reads it: the ahead/behind counts, the pre-PR row title (the
 * oldest commit in `base..HEAD`, which becomes a colleague's commit),
 * the diff context the AI summary is generated from, the git row's
 * files/insertions, the merge-conflict probe (which then reports clean
 * against a trunk several merges old — a false green), the `{{base}}`
 * handed to the diff tool, and the agent's own `git log
 * origin/<trunk>..HEAD` inside the checkout. Measured on this fleet: a
 * branch with no commits of its own showed 3 ahead and an 11-file diff
 * of somebody else's work, and one real branch showed 304 files changed
 * against a true 24.
 *
 * That last reader is the reason this fixes the REF instead of each
 * caller. A read-side substitution (`freshBaseRev`) can only correct
 * what goes through wt, and `{{base}}` has to stay a ref NAME anyway —
 * a sha that moved with trunk would kill the live diff session on every
 * merge.
 *
 * Cheap in the shape it actually runs: the value comparison exits
 * first, which is every checkout under `git-worktree` (one shared ref
 * store) and every already-current rift clone. When it does lag, the
 * object is almost always here already — rift CoW-copies the main
 * clone's object db at create, and a clone's own `git fetch` drags
 * GitHub's merge-queue branches in ahead of the merge — so it is a ref
 * write, not a transfer (0 of 19 live checkouts needed the fetch).
 */
function freshenWorktreeTrunkRefsEffect(main: string) {
  return Effect.gen(function* () {
    const trunk = config.branch.base;
    const tip = yield* revParseEffect(`origin/${trunk}`, main);
    if (!tip) return;
    const worktrees = yield* listWorktreesEffect().pipe(
      Effect.map((items) => items.filter((w) => !w.isMain)),
      Effect.catchAll((err) => Effect.sync(() => {
        log.debug(`could not list worktrees to freshen origin/${trunk}`, { err: err.message });
        return [];
      })),
    );
    yield* Effect.all(worktrees.map((wt) => freshenTrunkRefEffect(wt, trunk, tip, main)), { concurrency: 8 });
  });
}

/**
 * One checkout's trunk ref. Never throws: a directory removed
 * out-of-band between the listing and here must not fail the fetch that
 * every caller of `fetchOrigin` is actually waiting on.
 */
function freshenTrunkRefEffect(
  wt: Worktree,
  trunk: string,
  tip: string,
  main: string,
): Effect.Effect<void> {
  const ref = `refs/remotes/origin/${trunk}`;
  return Effect.gen(function* () {
    const have = yield* revParseEffect(`origin/${trunk}`, wt.path);
    if (have === tip) return;
    if (!(yield* gitQuietEffect(["cat-file", "-e", `${tip}^{commit}`], wt.path))) {
      // Not here yet. The fetch brings the object and moves the ref in
      // one step, over the filesystem from the main clone — no network.
      yield* gitRunEffect(
        ["fetch", "--no-tags", "--quiet", main, `+refs/remotes/origin/${trunk}:${ref}`],
        wt.path,
      );
      return;
    }
    // Fast-forward only. A clone that ran its own `git fetch` can be
    // AHEAD of the main clone's last one, and rewinding its ref is the
    // same lie pointing the other way.
    if (have && !(yield* gitQuietEffect(["merge-base", "--is-ancestor", have, tip], wt.path))) {
      return;
    }
    yield* gitRunEffect(["update-ref", ref, tip], wt.path);
    log.debug(`freshened ${ref}`, { slug: wt.slug, from: have ?? "(none)", to: tip });
  }).pipe(Effect.catchAll((err) => Effect.sync(() => {
    log.debug(`could not freshen ${ref}`, {
      slug: wt.slug,
      err: err instanceof Error ? err.message : String(err),
    });
  })));
}

/**
 * Fast-forward one local branch in the main clone onto the
 * `origin/<branch>` the fetch just refreshed.
 *
 * - Not checked out → `git update-ref refs/heads/<branch>`
 * - Checked out + clean → `git merge --ff-only`
 * - Checked out + dirty → skip. `origin/<branch>` is already fresh, and
 *   that is what the semantic checks consume; `update-ref` on a
 *   checked-out branch would invent phantom staged changes.
 *
 * Auto-regen files (`sst-env.d.ts`) get restored before the dirty check
 * so a routine `sst deploy/delete` write doesn't push us into the skip
 * path.
 *
 * Fast-forward ONLY, in every branch of it. A local head that has
 * diverged holds commits `origin` does not, and this runs unattended
 * every few minutes — the one thing it must never do is decide which
 * copy wins.
 */
function syncLocalBranchEffect(
  branch: string,
  opts: {
    main: string;
    checkedOut: boolean;
    create: boolean;
    onWarn?: (msg: string) => void;
  },
): Effect.Effect<void, ProcError> {
  return Effect.gen(function* () {
  const { main, checkedOut, create } = opts;
  const remoteRef = `origin/${branch}`;
  const exists = yield* localBranchExistsEffect(branch, main);
  if (!exists && !create) return;
  if (!(yield* originBranchExistsEffect(branch, main))) {
    // Only worth saying for a branch the user named: a missing
    // `origin/<base>` is a broken clone that everything else already
    // shouts about, while a typo in `keep_fresh` has no other symptom.
    if (create) {
      log.warn(`keep_fresh: no ${remoteRef} to track`, { branch });
    }
    return;
  }
  if (
    exists &&
    !(yield* gitQuietEffect(["merge-base", "--is-ancestor", branch, remoteRef], main))
  ) {
    const msg = `Local ${branch} has diverged from ${remoteRef}; not updating.`;
    opts.onWarn?.(msg);
    log.warn(msg, { branch });
    return;
  }
  if (!checkedOut) {
    // `git branch -f` rather than `update-ref`: it refuses to move a
    // branch that is checked out in some OTHER worktree, where a bare
    // ref write would silently invent phantom staged changes in a
    // checkout nobody is looking at. wt's own worktrees carry
    // `branch.prefix` names so this can't collide with them, but a
    // hand-made one on `main` is exactly what `keep_fresh` invites.
    const r = yield* gitRunEffect(["branch", "--force", branch, remoteRef], main);
    if (r.exitCode !== 0) {
      log.warn(`could not advance ${branch}: ${(r.stderr || r.stdout).trim()}`, { branch });
    }
    return;
  }
  yield* restoreAutoRegenEffect(main);
  const status = yield* runOkEffect(["git", "status", "--porcelain"], { cwd: main });
  if (status.trim()) return;
  const before = (yield* runOkEffect(["git", "rev-parse", "HEAD"], { cwd: main })).trim();
  yield* gitRunEffect(["merge", "--ff-only", "--quiet", remoteRef], main);
  yield* syncMainDepsEffect(main, before);
  });
}

/**
 * The ONE place origin gets fetched, and therefore the one place that
 * drops the first-parent SHA cache.
 *
 * That cache answers "is this branch tip just an older trunk commit?",
 * which is the only thing standing between an unstarted branch and a
 * `merged` verdict — and `merged` closes GitHub issues and feeds the
 * clean sweep. A fetch that advances `origin/<trunk>` without dropping
 * it leaves a set that cannot contain the new tip, so a worktree forked
 * at that tip reads as "off the first-parent chain" = landed work.
 *
 * It used to be invalidated by the caller, and five of six callers
 * didn't: `wt new` (which fetches immediately before forking, the exact
 * race), the restack replay, the webhook daemon, `wt ls` and `wt clean`.
 * Invalidating here makes forgetting impossible rather than making it a
 * rule to remember.
 */
export const fetchOriginEffect = (opts: { onWarn?: (msg: string) => void } = {}) =>
  fetchOriginLockedEffect(opts).pipe(Effect.ensuring(Effect.sync(invalidateMainFirstParents)));

export const fetchOrigin = (opts: { onWarn?: (msg: string) => void } = {}): Promise<void> => {
  if (fetchOriginInFlight) return fetchOriginInFlight;
  fetchOriginInFlight = Effect.runPromise(fetchOriginEffect(opts)).finally(() => { fetchOriginInFlight = null; });
  return fetchOriginInFlight;
};

/**
 * After the main clone fast-forwards to fresh trunk, reinstall deps IF the
 * pulled commits changed the repo's lockfile — so the main clone's
 * `node_modules` never drifts behind trunk. This matters most for the
 * `rift` backend, which CoW-copies the main clone's `node_modules` into
 * every new worktree (a stale main clone = stale worktrees); it's also
 * plain hygiene for working in the main clone directly. Because the
 * 3-minute fetch interval + webhook fetch both run through here, the main
 * clone stays synced in the background, so a `wt new` right after usually
 * finds nothing to install and stays fast.
 *
 * The package manager (and the lockfile whose change gates the sync)
 * comes from `resolveMainSyncInstall` — the `[lifecycle] install_command`
 * override or lockfile detection; a repo with neither makes the feature
 * inert. Gated on the lockfile actually changing, so the common
 * no-dep-change pull pays only one cheap `git diff --name-only`. The
 * frozen install variant keeps the committed lockfile untouched, which
 * would otherwise dirty the main clone and break the next fast-forward.
 * Best-effort: a failed install warns to the activity pane and never
 * fails the fetch.
 */
function syncMainDepsEffect(cwd: string, beforeHead: string): Effect.Effect<void, ProcError> {
  return Effect.gen(function* () {
  const after = (yield* runOkEffect(["git", "rev-parse", "HEAD"], { cwd })).trim();
  if (!after || after === beforeHead) return; // nothing was pulled
  const sync = resolveMainSyncInstall(cwd);
  if (!sync) return; // no lockfile, no override — nothing to keep in sync
  const changed = yield* runOkEffect(
    ["git", "diff", "--name-only", beforeHead, after, "--", ...sync.gateLockfiles],
    { cwd },
  );
  if (!changed.trim()) return; // deps unchanged on trunk — skip the install

  const lockfile = changed.trim().split("\n")[0];
  log.event.info(`${lockfile} changed on trunk — syncing main clone deps (${sync.label})`);
  const code = yield* runStreamingEffect(sync.argv, { cwd });
  if (code === 0) {
    log.event.ok("main clone deps synced", { toast: true });
  } else {
    log.warn("main clone dependency sync failed", { cwd, code, command: sync.label });
    log.event.warn(`main clone deps sync failed (${sync.label} exit ${code}) — run it there by hand`, {
      toast: true,
    });
  }
  });
}

function restoreAutoRegenEffect(cwd: string): Effect.Effect<void, ProcError> {
  return Effect.gen(function* () {
    for (const p of config.sst?.autoRegenPaths ?? []) {
    if (!existsSync(join(cwd, p))) continue;
    const porcelain = yield* runOkEffect(["git", "status", "--porcelain", "--", p], { cwd });
    if (porcelain) {
      yield* runQuietEffect(["git", "checkout", "HEAD", "--", p], { cwd });
    }
  }
  });
}
