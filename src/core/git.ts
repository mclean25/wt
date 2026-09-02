import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { Data, Effect, Semaphore } from "effect";

import { config } from "./config.ts";
import { createLogger } from "./logger.ts";
import { run, runOk, runQuiet, type ProcError } from "./proc.ts";
import { readWtState } from "./wtstate.ts";

const log = createLogger("[git]");

export class GitError extends Data.TaggedError("GitError")<{
  readonly args: readonly string[];
  readonly cwd: string;
  readonly cause: ProcError;
}> {
  override get message(): string { return this.cause.message; }
}

const gitCwd = (cwd?: string) => cwd ?? config.paths.mainClone;

export function git(args: readonly string[], cwd?: string): Effect.Effect<string, GitError> {
  const actualCwd = gitCwd(cwd);
  return runOk(["git", ...args], { cwd: actualCwd }).pipe(
    Effect.mapError((cause) => new GitError({ args, cwd: actualCwd, cause })),
  );
}

/**
 * `true` iff `git <args>` exits 0. The Effect fails only when git itself
 * couldn't be spawned/read/interrupted (`ProcError`) — a nonzero exit is
 * data, not a failure, and folds to `false`. The Promise twin folds the
 * spawn failure too, to `false`, which is the historical "quiet" contract;
 * an Effect caller that cares about the spawn-failed case should not fold
 * it away.
 */
export function gitQuiet(args: readonly string[], cwd?: string) {
  return runQuiet(["git", ...args], { cwd: gitCwd(cwd) });
}

/**
 * Runs `git <args>` and always returns the captured `RunResult` — a
 * nonzero exit code is part of the result, not a failure. The Effect
 * fails only on `ProcError` (spawn/read/interrupted): git could not be
 * run at all. The Promise twin folds that case into a synthetic
 * `exitCode: -1` result so legacy callers never see a rejection.
 */
export function gitRun(args: readonly string[], cwd?: string) {
  return run(["git", ...args], { cwd: gitCwd(cwd) });
}

/**
 * Resolve the effective diff/sync base for a worktree, guarding against a
 * dead parent ref. A stacked slice diffs/syncs against its parent branch;
 * once that parent merges and its worktree is cleaned (branch deleted), the
 * recorded base no longer resolves and every `<base>...HEAD` git call errors
 * out (e.g. `git rev-list` via `runOk` throws a raw `fatal: bad revision`).
 * Fall back to trunk so the row degrades to a (fat) trunk diff instead of
 * surfacing that error. `reconcileStack` is the real fix — it reparents the
 * orphan onto trunk in its fork-base record — so this only covers the window before
 * reconcile runs (or if the PR-merged probe hasn't landed yet). An external
 * base (stack-on-stack) still resolves, so it's left untouched.
 */
export function effectiveBaseOrTrunk(
  wtPath: string,
  effectiveBase?: string | null,
): Effect.Effect<string, ProcError> {
  const trunk = `origin/${config.branch.base}`;
  // Both spellings of the trunk normalize to the remote-tracking ref.
  // The BARE one is what is actually stored: the fork-base record is
  // written for trunk forks too (`baseBranch: "staging"`), and every
  // reader is supposed to normalize that to "no parent". This one only
  // recognised `origin/staging`, so an ordinary trunk worktree fell
  // through to the local-branch preference below — and under `rift` a
  // clone's local `staging` is a clone-time artifact that NOTHING ever
  // moves (`freshenWorktreeTrunkRefs` fast-forwards
  // `refs/remotes/origin/<trunk>`, not the local head). Measured on a
  // live fleet of 15: every row resolved to a local trunk 97 to 383
  // commits behind, so `base..HEAD` was that whole run of somebody
  // else's commits. Its oldest became the row TITLE (nine rows sharing
  // one colleague's commit subject), and the same range fed the sync
  // counts, the conflict probe and the diff the AI summary reads.
  // `freshBaseRev` could not rescue any of it: it keys on the trunk
  // string too, so it saw a non-trunk base and returned it untouched.
  if (!effectiveBase || effectiveBase === trunk || effectiveBase === config.branch.base) {
    return Effect.succeed(trunk);
  }
  // Prefer the local branch: the git-worktree backend shares the main
  // clone's object db, so a sibling slice's branch is a local ref (and
  // carries any not-yet-pushed commits). A rift checkout is an independent
  // clone where that branch ISN'T local — its only view of the sibling's
  // tip is the `origin/<parent>` remote-tracking ref. Try that before
  // degrading to a fat trunk diff, so a stacked rift slice bases on its
  // real parent. Already-`origin/…` bases resolve on the first check.
  return revParse(effectiveBase, wtPath).pipe(Effect.flatMap((local) => {
    if (local) return Effect.succeed(effectiveBase);
    const originRef = `origin/${effectiveBase}`;
    return revParse(originRef, wtPath).pipe(Effect.map((remote) => remote ? originRef : trunk));
  }));
}

/**
 * Swap a trunk base ref for the main clone's SHA when the checkout can
 * resolve it, so a count is taken in a reference frame that means
 * "where the world is now".
 *
 * Under the `rift` backend a worktree is an independent clone whose
 * `origin/<trunk>` is frozen at clone time and only moves when
 * something inside that clone fetches. Every ahead/behind count then
 * measures against whatever that checkout last saw, and the error is
 * one-directional and invisible: commits that landed on trunk AFTER the
 * clone's stale ref, but are already in HEAD, get counted as the
 * branch's own work. Measured on a live fleet of 10, two rows were
 * wrong — one reporting 3 commits ahead on a branch with no commits at
 * all (rebased onto a tip its own `origin/staging` had never heard of),
 * and one reporting 156 where the true answer was 14.
 *
 * That number is not cosmetic: with no `origin/<branch>` yet, it is
 * also the answer `pushCounts` gives for `unpushed`, which is what the
 * destroy guards read. An empty worktree that claims to hold three
 * commits of unpushed work is a guard crying wolf, and those get forced
 * past by reflex.
 *
 * Only the trunk ref is swapped, and only when `wtPath` already has the
 * object — this counts, it never fetches. Anything else (a stacked
 * slice's parent, an external base) is left exactly as resolved: its
 * freshest copy genuinely is the local one. Returns a SHA, so callers
 * that need a stable ref NAME for display (the `{{base}}` substitution,
 * whose change kills a live diff session) must not route through here.
 */
export function freshBaseRev(wtPath: string, base: string) {
  if (base !== `origin/${config.branch.base}`) return Effect.succeed(base);
  return revParse(base, config.paths.mainClone).pipe(Effect.flatMap((fresh) => {
    if (!fresh) return Effect.succeed(base);
    return gitQuiet(["cat-file", "-e", `${fresh}^{commit}`], wtPath).pipe(
      Effect.map((exists) => exists ? fresh : base),
    );
  }));
}
/**
 * Is a rebase actually in progress in `cwd`? This is the authoritative test —
 * the presence of git's per-worktree `rebase-merge`/`rebase-apply` state dir —
 * NOT the exit code of `git rebase --abort` (which also fails when there's
 * nothing to abort, the exact ambiguity that produced false "left mid-rebase"
 * reports on slices whose rebase failed at preflight without ever starting).
 */
export const rebaseInProgress = Effect.fn("rebaseInProgress")(function* (cwd: string) {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const r = yield* gitRun(["rev-parse", "--git-path", dir], cwd);
    const p = r.stdout.trim();
    // `--git-path` is ABSOLUTE for a linked worktree (the common case here) and
    // relative to `cwd` only for the main clone. `resolvePath(cwd, p)` is
    // correct for both — Node's `resolve` returns an absolute second arg
    // unchanged and joins a relative one onto `cwd`. Don't "simplify" this.
    if (p && existsSync(resolvePath(cwd, p))) return true;
  }
  return false;
});
export type MergeConflictProbe =
  | { status: "clean"; base: string }
  | { status: "conflict"; base: string; files: readonly string[] }
  /** The worktree is mid-rebase (conflict being resolved by hand or by
   *  `/restack`) — HEAD is transient, so the merge dry-run is skipped. */
  | { status: "rebasing"; base: string }
  | { status: "unknown"; base: string };

/**
 * Dry-run merge of `headRef` against `base` via `git merge-tree
 * --write-tree` — a real 3-way merge in the object database that never
 * touches a working tree or index. Approximates "will `headRef` rebase
 * cleanly onto `base`": exit 0 = clean, exit 1 = conflict, anything else
 * = unknown (rendered without any glyph).
 *
 * The exit-1 case is overloaded: git returns it BOTH for a real conflict
 * AND for an unresolvable ref ("not something we can merge", which it
 * prints to stderr with an empty stdout). A genuine conflict always
 * writes the result tree OID to stdout first, so non-empty stdout is
 * what tells the two apart — a bare exit code would false-positive a
 * conflict glyph onto any worktree whose base ref has gone missing.
 *
 * It's a merge, not a rebase replay, so for a multi-commit branch it's a
 * strong hint rather than a guarantee — good enough to warn before a
 * restack, cheap enough to run per row.
 */
// Mid-rebase, HEAD is a moving target (detached on the pick sequence) and
// the interesting fact is the rebase itself — report it instead of probing
// a transient tree. The TUI renders this as "resolution in progress" rather
// than a conflict warning.
export const mergeConflictProbe = Effect.fn("mergeConflictProbe")(function* (
  headRef: string,
  base: string,
  cwd?: string,
): Effect.fn.Return<MergeConflictProbe, ProcError> {
  if (cwd && (yield* rebaseInProgress(cwd))) return { status: "rebasing", base } as const;
  const r = yield* gitRun(["merge-tree", "--write-tree", "--name-only", "--no-messages", base, headRef], cwd);
  if (r.exitCode === 0) return { status: "clean", base } as const;
  if (r.exitCode === 1 && r.stdout.trim()) {
    // stdout: "<tree-oid>\n<file>\n<file>…" — first line is the result
    // tree OID, the rest are the conflicting paths.
    const files = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(1);
    return { status: "conflict", base, files } as const;
  }
  return { status: "unknown", base } as const;
});

/**
 * Resolve a ref to its commit SHA in `cwd` (default: the main clone),
 * or null when it doesn't resolve. The one canonical rev-parse helper —
 * the engine, stack ops, and base resolution all share it.
 */
export const revParse = (ref: string, cwd?: string) =>
  gitRun(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd).pipe(
    Effect.map((r) => {
      const sha = r.stdout.trim();
      return r.exitCode === 0 && sha ? sha : null;
    }),
  );

/**
 * Whether `sha` is an ancestor of `ref` (or `ref` itself). False when
 * either is unknown to this repo — a sha that has been rebased away is
 * usually still present as a dangling object, but a pruned one reads as
 * "not an ancestor", which is the answer that matters anyway.
 */
export function shaIsAncestor(
  sha: string,
  ref: string,
  cwd?: string,
): Effect.Effect<boolean, ProcError> {
  return gitRun(["merge-base", "--is-ancestor", sha, ref], cwd).pipe(
    Effect.map((r) => r.exitCode === 0),
  );
}

/**
 * Current tip of the branch a worktree merges INTO, resolved in the
 * main clone. `baseBranch` is the slug's recorded fork base, or null
 * for trunk.
 *
 * Resolved in the main clone deliberately, and this is the whole point
 * of the helper: under the `rift` backend every worktree is an
 * INDEPENDENT CLONE with its own remote-tracking refs, only as fresh as
 * the last fetch inside it. Asking a worktree for `origin/<trunk>`
 * returns whatever it last saw — measured on a live fleet, 10 distinct
 * answers across 28 rows, one of them 9 merges behind, none of them the
 * actual tip. The main clone is where `fetchOrigin` fetches, so it is
 * the freshest local answer and, more importantly, a CONSISTENT one:
 * any caller comparing two of these needs both sides computed in the
 * same reference frame or the comparison is meaningless.
 *
 * Prefers the remote-tracking ref, since a local branch of that name
 * may not exist in the main clone at all (again: independent clones).
 * Null when neither resolves — callers must treat that as unknown.
 */
export function baseTipSha(baseBranch: string | null) {
  const branch = baseBranch && baseBranch.trim() !== "" ? baseBranch : config.branch.base;
  return revParse(`origin/${branch}`).pipe(
    Effect.flatMap((remote) => remote ? Effect.succeed(remote) : revParse(branch)),
  );
}

/** First ref among `refs` that resolves to a commit in `cwd`, as a SHA. */
export const firstSha = Effect.fn("firstSha")(function* (cwd: string, refs: readonly string[]) {
  for (const ref of refs) {
    const sha = yield* revParse(ref, cwd);
    if (sha) return sha;
  }
  return null;
});
/** Does `branch` exist as a local head? */
export const localBranchExists = (branch: string, cwd?: string) =>
  gitQuiet(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd);

/** Does `branch` exist as an origin remote-tracking ref? */
export const originBranchExists = (branch: string, cwd?: string) =>
  gitQuiet(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], cwd);

export const branchExists = (branch: string) => localBranchExists(branch).pipe(
  Effect.flatMap((local) => local ? Effect.succeed(true) : originBranchExists(branch)),
);

/**
 * `wtPath` is required for rift worktrees: an independent clone keeps
 * its branch + upstream config in its own `.git`, invisible to the main
 * clone. Linked git worktrees share refs, so main clone (the default)
 * and the worktree path are equivalent there.
 */
export function branchIsGone(branch: string, wtPath?: string) {
  return run(
    ["git", "for-each-ref", "--format=%(upstream:track)", `refs/heads/${branch}`],
    { cwd: wtPath ?? config.paths.mainClone },
  ).pipe(Effect.map((r) => r.exitCode === 0 && r.stdout.trim() === "[gone]"));
}

let _mainFirstParents: Set<string> | null = null;
// Bumped by every invalidation. A read captures it before spawning and
// commits its value only if nothing invalidated in between — otherwise a
// `rev-list` started before a fetch would overwrite the fresh `null` with
// the pre-fetch chain, quietly undoing the invalidation it lost the race to.
let _mainFirstParentsEpoch = 0;
const mainFirstParentsSemaphore = Semaphore.makeUnsafe(1);

/**
 * SHAs on origin/main's first-parent chain. A branch tip that lives
 * here is just an older main commit (nothing was merged *from* the
 * branch); one that sits off this chain was pulled in via a real merge
 * commit.
 *
 * Cached after the first successful read. Effect callers compose this
 * helper directly; invalidation drops the value before the next read.
 */
export function mainFirstParentShas() {
  return mainFirstParentsSemaphore.withPermits(1)(Effect.suspend(() => {
    if (_mainFirstParents) return Effect.succeed(_mainFirstParents);
    const epoch = _mainFirstParentsEpoch;
    // A failed `rev-list` fails the read rather than caching an empty chain:
    // an empty set reads as "no branch tip is an old trunk commit" for the
    // rest of the process, and every consumer already folds a failure into
    // the conservative answer.
    return runOk(
      ["git", "rev-list", "--first-parent", `origin/${config.branch.base}`],
      { cwd: config.paths.mainClone },
    ).pipe(Effect.map((out) => {
      const value = new Set(out.split("\n").filter(Boolean));
      if (epoch === _mainFirstParentsEpoch) _mainFirstParents = value;
      return value;
    }));
  }));
}
/** Invalidate cached first-parent set after a fetch. */
export function invalidateMainFirstParents(): void {
  _mainFirstParents = null;
  _mainFirstParentsEpoch++;
}

/**
 * Subject line of the *oldest* commit on the branch since its base.
 * That's the human's "what is this work" framing — captures intent
 * before a PR exists. Returns null if the branch has no commits ahead
 * of base, or `git log` fails.
 *
 * `base` defaults to the trunk, but a STACKED worktree must pass its
 * own fork base: against the trunk, a child with no commits of its own
 * walks its parent's history and reports the parent's oldest commit,
 * so every sibling in a fan resolves to one identical title.
 */
export function firstCommitSubject(
  wtPath: string,
  base: string = `origin/${config.branch.base}`,
): Effect.Effect<string | null, ProcError> {
  return run(
    ["git", "log", "--reverse", "--format=%s", `${base}..HEAD`],
    { cwd: wtPath, timeoutMs: 5_000 },
  ).pipe(Effect.map((r) => {
    if (r.exitCode !== 0) return null;
    return r.stdout.split("\n").find((l) => l.length > 0) ?? null;
  }));
}
/**
 * `wtPath` (see `branchIsGone`) is where the branch NAME resolves; the
 * ancestry checks below deliberately stay in the main clone, by SHA —
 * its `origin/<base>` is the one `fetchOrigin` keeps fresh, while a
 * rift clone's own origin ref can lag its last fetch. A pushed branch's
 * objects are reachable in the main clone via `origin/<branch>`; an
 * unpushed tip is unknown there, and unknown-to-origin means unmerged.
 */
export const branchIsMerged = Effect.fn("branchIsMerged")(function* (wt: {
  slug: string;
  branch: string;
  path?: string;
}): Effect.fn.Return<boolean, GitError | ProcError> {
  const { branch, path: wtPath } = wt;
  const branchSha = yield* git(["rev-parse", "--verify", branch], wtPath ?? config.paths.mainClone);
  const mainSha = yield* git(["rev-parse", "--verify", `origin/${config.branch.base}`]);
  // Real-divergence gate; FF-aligned branches skip out below.
  if (
    !(yield* gitQuiet([
      "merge-base",
      "--is-ancestor",
      branchSha,
      `origin/${config.branch.base}`,
    ]))
  ) {
    return false;
  }
  if (branchSha === mainSha) return false;
  // Branch tip on main's first-parent chain = just an older main SHA
  // (branch never got its own commits). Real merge-commit merges attach
  // the branch via a second parent.
  const fps = yield* mainFirstParentShas();
  if (fps.has(branchSha)) return false;
  return !(yield* forkBaseIsVacuous(wt, branchSha));
}, Effect.catch((err) => Effect.sync(() => {
  // Safe direction: a broken probe must never read as "merged" (closes
  // GitHub issues, feeds the clean sweep). Logged so a persistently
  // broken probe is visible in the daily log instead of silently always
  // answering "not merged".
  log.debug("branchIsMerged probe failed, folding to false", { err: err instanceof Error ? err.message : String(err) });
  return false;
})));

/**
 * VACUOUS CONTAINMENT: is this branch contained in trunk only because
 * it has no commits of its own?
 *
 * "Every commit reachable from the branch is on trunk" is trivially
 * true for a branch that added none, and that is evidence there is no
 * work, not that the work landed. It bites exactly one population, and
 * bites it hard: a freshly created STACKED worktree shares its parent's
 * tip until its first commit, so the moment the parent merges by merge
 * commit (which puts the parent's tip off trunk's first-parent chain,
 * past the check above) every unstarted child reads as merged. That
 * window is not an edge case — it is the normal state of a stack
 * between `wt new` and the first commit.
 *
 * The cost of getting it wrong is asymmetric. Offering an empty
 * worktree for cleanup loses nothing (there is no work in it), but the
 * merged status also drives `close-issue-on-merge`, which closes a
 * GitHub issue — off-machine, where wt's undo does not reach, and
 * describing work that was never started.
 *
 * Measured against the recorded fork base (`baseSha` preferred: it is
 * the exact commit the branch forked at, and it survives the parent
 * branch being deleted because the object stays reachable from trunk).
 * An unresolvable base counts as vacuous: unable to prove work exists,
 * the safe answer is "not started" — that leaves a row on the board,
 * which is visible and cheap, rather than closing an issue.
 *
 * A MISSING record still answers "not vacuous", which fails open, and
 * that is a deliberate floor rather than a comfortable one. `wt new`
 * now records a base for trunk forks too, so the gap is limited to
 * worktrees created before that; for them the first-parent check above
 * is the only guard, which is why `fetchOrigin` must keep that set
 * fresh. The alternative — treating "no record" as vacuous — would stop
 * every legacy worktree from ever reading as merged, which breaks the
 * clean sweep for exactly the rows it should handle.
 */
function forkBaseIsVacuous(
  wt: { slug: string; path?: string },
  branchSha: string,
): Effect.Effect<boolean, ProcError> {
  const rec = readWtState().slugs[wt.slug];
  const base = rec?.baseSha ?? rec?.baseBranch;
  if (!base) return Effect.succeed(false);
  return branchIsEmptySince(base, branchSha, wt.path);
}

/**
 * Has `branchSha` added nothing since `base`? Exported for the
 * vacuous-containment guard's tests; see `forkBaseIsVacuous` for why
 * an unresolvable base answers `true`.
 */
export function branchIsEmptySince(
  base: string,
  branchSha: string,
  cwd?: string,
): Effect.Effect<boolean, ProcError> {
  if (base === branchSha) return Effect.succeed(true);
  return gitRun(["rev-list", "--count", `${base}..${branchSha}`], cwd).pipe(
    Effect.map((r) => r.exitCode !== 0 || Number(r.stdout.trim()) === 0),
  );
}
