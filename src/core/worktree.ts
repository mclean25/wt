import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Data, Effect, Fiber, Schedule, Semaphore } from "effect";

import { listRiftWorktreePaths } from "./backend.ts";
import { config } from "./config.ts";
import { branchIsGone, branchIsMerged, effectiveBaseOrTrunk, freshBaseRev, git, gitQuiet, gitRun, invalidateMainFirstParents, localBranchExists, originBranchExists, revParse } from "./git.ts";
import { resolveMainSyncInstall } from "./install.ts";
import { lockAge, lockLabel, lockStatus, tryAcquireLock } from "./locks.ts";
import { createLogger } from "./logger.ts";
import { latestLogFor } from "./logs.ts";
import { runOk, runQuiet, runStreaming, type ProcError } from "./proc.ts";
import { computeStage } from "./stage.ts";
import { type Status, StatusKind, type Worktree } from "./types.ts";

const log = createLogger("[worktree]");
const FETCH_ORIGIN_LOCK = "__fetch_origin__";
export class WorktreeError extends Data.TaggedError("WorktreeError")<{
  readonly operation: "list" | "fetch-origin";
  readonly cause: unknown;
}> {
  override get message(): string { return this.cause instanceof Error ? this.cause.message : String(this.cause); }
}

export function listWorktrees(): Effect.Effect<Worktree[], WorktreeError> {
  return git(["worktree", "list", "--porcelain"]).pipe(
    Effect.map(parseWorktrees),
    Effect.mapError((cause) => new WorktreeError({ operation: "list", cause })),
  );
}

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

function countsFor(wtPath: string, range: string): Effect.Effect<SyncCounts, ProcError | WorktreeError> {
  return runOk(["git", "rev-list", "--left-right", "--count", range], { cwd: wtPath }).pipe(
    Effect.flatMap((out) => {
      const match = out.trim().match(/^(\d+)\s+(\d+)$/);
      return match
        ? Effect.succeed({ behind: Number.parseInt(match[1]!, 10), ahead: Number.parseInt(match[2]!, 10) })
        : Effect.fail(new WorktreeError({ operation: "list", cause: new Error(`unexpected rev-list output for ${range}: ${out}`) }));
    }),
  );
}

export const syncState = Effect.fn("syncState")(function* (wtPath: string, effectiveBase?: string | null) {
  const resolved = yield* effectiveBaseOrTrunk(wtPath, effectiveBase);
  const base = yield* freshBaseRev(wtPath, resolved);
  const main = yield* countsFor(wtPath, `${base}...HEAD`);
  const branch = (yield* runOk(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: wtPath })).trim();
  if (!branch || branch === "HEAD") return { main, remote: null };
  const originRef = `origin/${branch}`;
  const exists = yield* runQuiet(["git", "rev-parse", "--verify", "--quiet", originRef], { cwd: wtPath });
  if (!exists) return { main, remote: null };
  return { main, remote: yield* countsFor(wtPath, `${originRef}...HEAD`) };
});

export const worktreeDirtyFiles = (wtPath: string) =>
  runOk(["git", "status", "--porcelain"], { cwd: wtPath }).pipe(
    Effect.map((porcelain) => porcelain.split("\n").filter((line) => line.length > 0).map((line) => line.slice(3))),
  );
export const worktreeIsDirty = (wtPath: string) =>
  worktreeDirtyFiles(wtPath).pipe(Effect.map((files) => files.length > 0));
export const worktreeHasTrackedChanges = (wtPath: string) =>
  runOk(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: wtPath }).pipe(
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
export const unpushedCommits = Effect.fn("unpushedCommits")(function* (wtPath: string): Effect.fn.Return<number, ProcError> {
  // `@{u}` is resolved to its ref NAME rather than used directly, so
  // the trunk case is recognizable to `freshBaseRev` — wt points a
  // worktree's upstream at its base, so for an unstacked worktree
  // `@{u}` IS `origin/<trunk>`, and that is exactly the ref a rift
  // clone holds a stale copy of.
  const hasUpstream = yield* runQuiet(
    ["git", "rev-parse", "--abbrev-ref", "@{u}"],
    { cwd: wtPath },
  );
  const upstream = hasUpstream
    ? (yield* runOk(["git", "rev-parse", "--abbrev-ref", "@{u}"], { cwd: wtPath })).trim()
    : "";
  const base = yield* freshBaseRev(
    wtPath,
    upstream || `origin/${config.branch.base}`,
  );
  const ahead = yield* runOk(
    ["git", "rev-list", "--count", `${base}..HEAD`],
    { cwd: wtPath },
  );
  return parseInt(ahead, 10) || 0;
}, (effect, wtPath) => effect.pipe(Effect.catch((err) => Effect.sync(() => {
  log.error(err instanceof Error ? err : String(err), { wtPath });
  return null;
}))));

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
export const pushCounts = Effect.fn("pushCounts")(function* (wtPath: string) {
  const aheadOfBase = yield* unpushedCommits(wtPath);
  return yield* Effect.gen(function* () {
    const branch = (
      yield* runOk(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: wtPath })
    ).trim();
    // Detached HEAD reports the literal "HEAD" — no branch, no counterpart.
    if (branch && branch !== "HEAD") {
      const originRef = `origin/${branch}`;
      const originExists = yield* runQuiet(
        ["git", "rev-parse", "--verify", "--quiet", originRef],
        { cwd: wtPath },
      );
      if (originExists) {
        const count = yield* runOk(
          ["git", "rev-list", "--count", `${originRef}..HEAD`],
          { cwd: wtPath },
        );
        return { unpushed: parseInt(count, 10) || 0, aheadOfBase, pushed: true };
      }
    }
    return { unpushed: aheadOfBase, aheadOfBase, pushed: false };
  }).pipe(Effect.catch((err) => Effect.sync(() => {
    log.error(err instanceof Error ? err : String(err), { wtPath });
    return { unpushed: null, aheadOfBase, pushed: null };
  })));
});

export const worktreeStatus = Effect.fn("worktreeStatus")(function* (wt: Worktree): Effect.fn.Return<Status, ProcError> {
  const lock = lockStatus(wt.slug);
  if (lock) {
    return {
      kind: StatusKind.Busy,
      label: lockLabel(lock),
      age: lockAge(lock) ?? undefined,
      log: latestLogFor(wt.slug) ?? undefined,
      pid: lock.pid,
      op: lock.op,
    };
  }
  if (!existsSync(wt.path)) {
    return { kind: StatusKind.Missing, label: "missing" };
  }
  if (wt.branch) {
    if (yield* branchIsGone(wt.branch, wt.path)) {
      return { kind: StatusKind.Gone, label: "gone (squash-merged or deleted)" };
    }
    if (yield* branchIsMerged({ slug: wt.slug, branch: wt.branch, path: wt.path })) {
      return { kind: StatusKind.Merged, label: "merged into origin/main" };
    }
  }
  if (yield* worktreeIsDirty(wt.path)) return { kind: StatusKind.Dirty, label: "dirty" };
  return { kind: StatusKind.Clean, label: "clean" };
});

const acquireFetchOriginLock = Effect.fnUntraced(function* () {
  return yield* Effect.suspend(() => {
    const handle = tryAcquireLock(FETCH_ORIGIN_LOCK, "fetch-origin", {
      phase: "fetch origin",
    });
    return handle
      ? Effect.succeed(handle)
      : Effect.fail(new WorktreeError({ operation: "fetch-origin", cause: new Error("another origin fetch is still running") }));
  }).pipe(Effect.retry(Schedule.max([Schedule.spaced("250 millis"), Schedule.recurs(59)])));
});

const fetchOriginLocked = Effect.fnUntraced(function* (opts: { onWarn?: (msg: string) => void } = {}) {
  return yield* Effect.acquireUseRelease(
    acquireFetchOriginLock(),
    () => Effect.gen(function* () {
    const fetch = yield* gitRun(["fetch", "origin", "--prune"]);
    if (fetch.exitCode !== 0) {
      return yield* new WorktreeError({ operation: "fetch-origin", cause: new Error(
        `git fetch origin failed: ${(fetch.stderr || fetch.stdout).trim() || `exit ${fetch.exitCode}`}`) });
    }
    const main = config.paths.mainClone;
    // Resolved ONCE, not per branch: at most one of them can be the
    // checked-out head, and only that one needs the dirty-tree dance.
    let head: string | null = null;
    if (yield* gitQuiet(["symbolic-ref", "--quiet", "HEAD"], main)) {
      head = (yield* git(["symbolic-ref", "--quiet", "--short", "HEAD"], main)).trim();
    }
    // Trunk first, then whatever else the user wants current. Deduped,
    // so naming the base in `keep_fresh` is redundant rather than a
    // double fast-forward.
    for (const branch of new Set([config.branch.base, ...config.branch.keepFresh])) {
      yield* syncLocalBranch(branch, {
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
    yield* freshenWorktreeTrunkRefs(main);
    }),
    (handle) => Effect.sync(() => handle.release()),
  ).pipe(Effect.mapError((cause) => cause instanceof WorktreeError ? cause : new WorktreeError({ operation: "fetch-origin", cause })));
});

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
const freshenWorktreeTrunkRefs = Effect.fnUntraced(function* (main: string) {
  const trunk = config.branch.base;
  const tip = yield* revParse(`origin/${trunk}`, main);
  if (!tip) return;
  const worktrees = yield* listWorktrees().pipe(
    Effect.map((items) => items.filter((w) => !w.isMain)),
    Effect.catch((err) => Effect.sync(() => {
      log.debug(`could not list worktrees to freshen origin/${trunk}`, { err: err.message });
      return [];
    })),
  );
  yield* Effect.all(worktrees.map((wt) => freshenTrunkRef(wt, trunk, tip, main)), { concurrency: 8 });
});

/**
 * One checkout's trunk ref. Never throws: a directory removed
 * out-of-band between the listing and here must not fail the fetch that
 * every caller of `fetchOrigin` is actually waiting on.
 */
const freshenTrunkRef = Effect.fnUntraced(function* (
  wt: Worktree,
  trunk: string,
  tip: string,
  main: string,
) {
  const ref = `refs/remotes/origin/${trunk}`;
  const have = yield* revParse(`origin/${trunk}`, wt.path);
  if (have === tip) return;
  if (!(yield* gitQuiet(["cat-file", "-e", `${tip}^{commit}`], wt.path))) {
    // Not here yet. The fetch brings the object and moves the ref in
    // one step, over the filesystem from the main clone — no network.
    yield* gitRun(
      ["fetch", "--no-tags", "--quiet", main, `+refs/remotes/origin/${trunk}:${ref}`],
      wt.path,
    );
    return;
  }
  // Fast-forward only. A clone that ran its own `git fetch` can be
  // AHEAD of the main clone's last one, and rewinding its ref is the
  // same lie pointing the other way.
  if (have && !(yield* gitQuiet(["merge-base", "--is-ancestor", have, tip], wt.path))) {
    return;
  }
  yield* gitRun(["update-ref", ref, tip], wt.path);
  log.debug(`freshened ${ref}`, { slug: wt.slug, from: have ?? "(none)", to: tip });
}, (effect, wt, trunk) => effect.pipe(Effect.catch((err) => Effect.sync(() => {
  log.debug(`could not freshen refs/remotes/origin/${trunk}`, {
    slug: wt.slug,
    err: err instanceof Error ? err.message : String(err),
  });
}))));

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
const syncLocalBranch = Effect.fnUntraced(function* (
  branch: string,
  opts: {
    main: string;
    checkedOut: boolean;
    create: boolean;
    onWarn?: (msg: string) => void;
  },
): Effect.fn.Return<void, ProcError> {
  const { main, checkedOut, create } = opts;
  const remoteRef = `origin/${branch}`;
  const exists = yield* localBranchExists(branch, main);
  if (!exists && !create) return;
  if (!(yield* originBranchExists(branch, main))) {
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
    !(yield* gitQuiet(["merge-base", "--is-ancestor", branch, remoteRef], main))
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
    const r = yield* gitRun(["branch", "--force", branch, remoteRef], main);
    if (r.exitCode !== 0) {
      log.warn(`could not advance ${branch}: ${(r.stderr || r.stdout).trim()}`, { branch });
    }
    return;
  }
  yield* restoreAutoRegen(main);
  const status = yield* runOk(["git", "status", "--porcelain"], { cwd: main });
  if (status.trim()) return;
  const before = (yield* runOk(["git", "rev-parse", "HEAD"], { cwd: main })).trim();
  yield* gitRun(["merge", "--ff-only", "--quiet", remoteRef], main);
  yield* syncMainDeps(main, before);
});

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
// Single-flight IN THE EFFECT: concurrent `fetchOrigin` callers join the one
// in-flight fetch instead of each paying the lock retry plus a redundant
// `git fetch`. Previously this lived only in the Promise twin's own
// module-level cache, so Effect callers (lifecycle.ts, stack-ops/replay.ts,
// events/daemon.ts) each called `fetchOriginLocked` directly and bypassed it.
// The claim/read is done under a semaphore (fast — it only forks, never
// blocks on the fetch itself); joins happen outside it so concurrent
// joiners don't serialize on the semaphore for the fetch's duration.
// `forkDetach` so the underlying fetch outlives whichever caller's own
// fiber happens to be interrupted while others are still joined on it.
let fetchOriginFiber: Fiber.Fiber<void, WorktreeError> | null = null;
const fetchOriginGate = Semaphore.makeUnsafe(1);

export const fetchOrigin = (opts: { onWarn?: (msg: string) => void } = {}): Effect.Effect<void, WorktreeError> =>
  fetchOriginGate.withPermits(1)(Effect.suspend(() => {
    if (fetchOriginFiber) return Effect.succeed(fetchOriginFiber);
    return fetchOriginLocked(opts).pipe(
      Effect.ensuring(Effect.sync(invalidateMainFirstParents)),
      Effect.ensuring(Effect.sync(() => { fetchOriginFiber = null; })),
      Effect.forkDetach,
      Effect.tap((fiber) => Effect.sync(() => { fetchOriginFiber = fiber; })),
    );
  })).pipe(Effect.flatMap(Fiber.join));

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
const syncMainDeps = Effect.fnUntraced(function* (cwd: string, beforeHead: string): Effect.fn.Return<void, ProcError> {
  const after = (yield* runOk(["git", "rev-parse", "HEAD"], { cwd })).trim();
  if (!after || after === beforeHead) return; // nothing was pulled
  const sync = resolveMainSyncInstall(cwd);
  if (!sync) return; // no lockfile, no override — nothing to keep in sync
  const changed = yield* runOk(
    ["git", "diff", "--name-only", beforeHead, after, "--", ...sync.gateLockfiles],
    { cwd },
  );
  if (!changed.trim()) return; // deps unchanged on trunk — skip the install

  const lockfile = changed.trim().split("\n")[0];
  log.event.info(`${lockfile} changed on trunk — syncing main clone deps (${sync.label})`);
  const code = yield* runStreaming(sync.argv, { cwd });
  if (code === 0) {
    log.event.ok("main clone deps synced", { toast: true });
  } else {
    log.warn("main clone dependency sync failed", { cwd, code, command: sync.label });
    log.event.warn(`main clone deps sync failed (${sync.label} exit ${code}) — run it there by hand`, {
      toast: true,
    });
  }
});

const restoreAutoRegen = Effect.fnUntraced(function* (cwd: string): Effect.fn.Return<void, ProcError> {
  for (const p of config.sst?.autoRegenPaths ?? []) {
    if (!existsSync(join(cwd, p))) continue;
    const porcelain = yield* runOk(["git", "status", "--porcelain", "--", p], { cwd });
    if (porcelain) {
      yield* runQuiet(["git", "checkout", "HEAD", "--", p], { cwd });
    }
  }
});
