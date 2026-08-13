import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import { config } from "./config.ts";
import { run, runOk, runQuiet } from "./proc.ts";
import { readWtState } from "./wtstate.ts";

export async function git(args: string[], cwd?: string): Promise<string> {
  return runOk(["git", ...args], { cwd: cwd ?? config.paths.mainClone });
}

export async function gitQuiet(args: string[], cwd?: string): Promise<boolean> {
  return runQuiet(["git", ...args], { cwd: cwd ?? config.paths.mainClone });
}

export async function gitRun(
  args: string[],
  cwd?: string,
) {
  return run(["git", ...args], { cwd: cwd ?? config.paths.mainClone });
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
export async function effectiveBaseOrTrunk(
  wtPath: string,
  effectiveBase?: string | null,
): Promise<string> {
  const trunk = `origin/${config.branch.base}`;
  if (!effectiveBase || effectiveBase === trunk) return trunk;
  // Prefer the local branch: the git-worktree backend shares the main
  // clone's object db, so a sibling slice's branch is a local ref (and
  // carries any not-yet-pushed commits). A rift checkout is an independent
  // clone where that branch ISN'T local — its only view of the sibling's
  // tip is the `origin/<parent>` remote-tracking ref. Try that before
  // degrading to a fat trunk diff, so a stacked rift slice bases on its
  // real parent. Already-`origin/…` bases resolve on the first check.
  if (await revParse(effectiveBase, wtPath)) return effectiveBase;
  const originRef = `origin/${effectiveBase}`;
  if (await revParse(originRef, wtPath)) return originRef;
  return trunk;
}

/**
 * Is a rebase actually in progress in `cwd`? This is the authoritative test —
 * the presence of git's per-worktree `rebase-merge`/`rebase-apply` state dir —
 * NOT the exit code of `git rebase --abort` (which also fails when there's
 * nothing to abort, the exact ambiguity that produced false "left mid-rebase"
 * reports on slices whose rebase failed at preflight without ever starting).
 */
export async function rebaseInProgress(cwd: string): Promise<boolean> {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const r = await gitRun(["rev-parse", "--git-path", dir], cwd);
    const p = r.stdout.trim();
    // `--git-path` is ABSOLUTE for a linked worktree (the common case here) and
    // relative to `cwd` only for the main clone. `resolvePath(cwd, p)` is
    // correct for both — Node's `resolve` returns an absolute second arg
    // unchanged and joins a relative one onto `cwd`. Don't "simplify" this.
    if (p && existsSync(resolvePath(cwd, p))) return true;
  }
  return false;
}

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
export async function mergeConflictProbe(
  headRef: string,
  base: string,
  cwd?: string,
): Promise<MergeConflictProbe> {
  // Mid-rebase, HEAD is a moving target (detached on the pick sequence)
  // and the interesting fact is the rebase itself — report it instead of
  // probing a transient tree. The TUI renders this as "resolution in
  // progress" rather than a conflict warning.
  if (cwd && (await rebaseInProgress(cwd))) {
    return { status: "rebasing", base };
  }
  const r = await gitRun(
    ["merge-tree", "--write-tree", "--name-only", "--no-messages", base, headRef],
    cwd,
  );
  if (r.exitCode === 0) return { status: "clean", base };
  if (r.exitCode === 1 && r.stdout.trim()) {
    // stdout: "<tree-oid>\n<file>\n<file>…" — first line is the result
    // tree OID, the rest are the conflicting paths.
    const files = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(1);
    return { status: "conflict", base, files };
  }
  return { status: "unknown", base };
}

/**
 * Resolve a ref to its commit SHA in `cwd` (default: the main clone),
 * or null when it doesn't resolve. The one canonical rev-parse helper —
 * the engine, stack ops, and base resolution all share it.
 */
export async function revParse(ref: string, cwd?: string): Promise<string | null> {
  const r = await gitRun(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], cwd);
  const sha = r.stdout.trim();
  return r.exitCode === 0 && sha ? sha : null;
}

/** First ref among `refs` that resolves to a commit in `cwd`, as a SHA. */
export async function firstSha(cwd: string, refs: string[]): Promise<string | null> {
  for (const ref of refs) {
    const sha = await revParse(ref, cwd);
    if (sha) return sha;
  }
  return null;
}

/** Does `branch` exist as a local head? */
export async function localBranchExists(branch: string, cwd?: string): Promise<boolean> {
  return gitQuiet(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
}

/** Does `branch` exist as an origin remote-tracking ref? */
export async function originBranchExists(branch: string, cwd?: string): Promise<boolean> {
  return gitQuiet(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], cwd);
}

export async function branchExists(branch: string): Promise<boolean> {
  return (await localBranchExists(branch)) || originBranchExists(branch);
}

/**
 * `branch` itself when the local head exists, else `origin/<branch>` —
 * a ref other git commands can resolve either way. Doesn't verify the
 * origin ref; pair with `branchExists` when absence is an error.
 */
export async function localOrOriginRef(branch: string): Promise<string> {
  return (await localBranchExists(branch)) ? branch : `origin/${branch}`;
}

/**
 * `wtPath` is required for rift worktrees: an independent clone keeps
 * its branch + upstream config in its own `.git`, invisible to the main
 * clone. Linked git worktrees share refs, so main clone (the default)
 * and the worktree path are equivalent there.
 */
export async function branchIsGone(branch: string, wtPath?: string): Promise<boolean> {
  const r = await run(
    ["git", "for-each-ref", "--format=%(upstream:track)", `refs/heads/${branch}`],
    { cwd: wtPath ?? config.paths.mainClone },
  );
  if (r.exitCode !== 0) return false;
  return r.stdout.trim() === "[gone]";
}

let _mainFirstParents: Promise<Set<string>> | null = null;

/**
 * SHAs on origin/main's first-parent chain. A branch tip that lives
 * here is just an older main commit (nothing was merged *from* the
 * branch); one that sits off this chain was pulled in via a real merge
 * commit.
 *
 * Cached as a promise (not a value) so concurrent callers on a cold
 * cache share a single `git rev-list` — the queryFn for every non-main
 * worktree's `branchIsMerged` calls this, and they all fire at once
 * after `invalidateMainFirstParents()`.
 */
export function mainFirstParentShas(): Promise<Set<string>> {
  if (_mainFirstParents) return _mainFirstParents;
  _mainFirstParents = (async () => {
    const r = await run(
      ["git", "rev-list", "--first-parent", `origin/${config.branch.base}`],
      { cwd: config.paths.mainClone },
    );
    return new Set(
      r.exitCode === 0 ? r.stdout.split("\n").filter(Boolean) : [],
    );
  })();
  return _mainFirstParents;
}

/** Invalidate cached first-parent set after a fetch. */
export function invalidateMainFirstParents(): void {
  _mainFirstParents = null;
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
export async function firstCommitSubject(
  wtPath: string,
  base: string = `origin/${config.branch.base}`,
): Promise<string | null> {
  const r = await run(
    ["git", "log", "--reverse", "--format=%s", `${base}..HEAD`],
    { cwd: wtPath, timeoutMs: 5_000 },
  );
  if (r.exitCode !== 0) return null;
  const first = r.stdout.split("\n").find((l) => l.length > 0);
  return first ?? null;
}

/**
 * `wtPath` (see `branchIsGone`) is where the branch NAME resolves; the
 * ancestry checks below deliberately stay in the main clone, by SHA —
 * its `origin/<base>` is the one `fetchOrigin` keeps fresh, while a
 * rift clone's own origin ref can lag its last fetch. A pushed branch's
 * objects are reachable in the main clone via `origin/<branch>`; an
 * unpushed tip is unknown there, and unknown-to-origin means unmerged.
 */
export async function branchIsMerged(wt: {
  slug: string;
  branch: string;
  path?: string;
}): Promise<boolean> {
  const { branch, path: wtPath } = wt;
  let branchSha: string;
  let mainSha: string;
  try {
    branchSha = await git(["rev-parse", "--verify", branch], wtPath ?? config.paths.mainClone);
    mainSha = await git(["rev-parse", "--verify", `origin/${config.branch.base}`]);
  } catch {
    return false;
  }
  // Real-divergence gate; FF-aligned branches skip out below.
  if (
    !(await gitQuiet([
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
  const fps = await mainFirstParentShas();
  if (fps.has(branchSha)) return false;
  return !(await forkBaseIsVacuous(wt, branchSha));
}

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
async function forkBaseIsVacuous(
  wt: { slug: string; path?: string },
  branchSha: string,
): Promise<boolean> {
  const rec = readWtState().slugs[wt.slug];
  const base = rec?.baseSha ?? rec?.baseBranch;
  if (!base) return false;
  return branchIsEmptySince(base, branchSha, wt.path);
}

/**
 * Has `branchSha` added nothing since `base`? Exported for the
 * vacuous-containment guard's tests; see `forkBaseIsVacuous` for why
 * an unresolvable base answers `true`.
 */
export async function branchIsEmptySince(
  base: string,
  branchSha: string,
  cwd?: string,
): Promise<boolean> {
  if (base === branchSha) return true;
  const r = await gitRun(["rev-list", "--count", `${base}..${branchSha}`], cwd);
  if (r.exitCode !== 0) return true;
  return Number(r.stdout.trim()) === 0;
}
