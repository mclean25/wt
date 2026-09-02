/**
 * Restack maintenance over inferred stacks. `chain.ts` resolves which
 * worktrees a restack walks (from live worktrees + fork-base records),
 * `reconcile.ts` rewrites records when parents land, `replay.ts` drives
 * the native squash-safe engine to replay members onto their (possibly
 * rewritten) parents, and `rebaseStack` is the thin
 * reconcile-then-replay convenience. The genuinely hard part (anchored
 * rebase replay) lives in `RestackEngine`.
 */
import { Data, Effect, Schedule } from "effect";

import { config } from "../config.ts";
import { tryAcquireLock, type LockHandle } from "../locks.ts";
import { createLogger } from "../logger.ts";
import { retargetPrBase, viewPrInfo } from "../github/mutations.ts";
import { gitQuiet } from "../git.ts";
import { resolveChain, type RestackChain } from "./chain.ts";
import { causeMessage } from "../errors.ts";

/** PRs already warned about as closed-by-base-deletion (once per process). */
const warnedClosedPrs = new Set<number>();

export const log = createLogger("[stack-ops]");

export type Logger = (line: string) => void;

/** Error every mutator returns/logs when the chain's locks can't be had. */
export const STACK_BUSY =
  "another wt operation is already running on this stack's worktrees";

export type ChainLockResult =
  | { status: "ok"; chain: RestackChain; handles: readonly LockHandle[] }
  /** Some member's per-slug lock is held by another operation. */
  | { status: "busy" }
  /** The branch resolves no live worktree — nothing to lock or restack. */
  | { status: "gone" };

export class StackLockError extends Data.TaggedError("StackLockError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return causeMessage(this.cause);
  }
}

/** Internal retry signal: membership grew, or a member's lock is currently
 *  held by another operation. Never escapes `lockChain` — it's caught into
 *  `{status: "busy"}` once the retry budget is spent. */
class ChainLockContention extends Data.TaggedError("ChainLockContention")<Record<string, never>> {}

function releaseHandles(handles: readonly LockHandle[]): void {
  for (const handle of handles) handle.release();
}

export function withLockHandles<A, E, R>(
  handles: readonly LockHandle[],
  use: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.acquireUseRelease(
    Effect.succeed(handles),
    () => use,
    (owned) => Effect.sync(() => releaseHandles(owned)),
  );
}

/**
 * Resolve the chain containing `branch` and acquire the per-slug lock of
 * EVERY member, waiting briefly for live holders to finish. This is the
 * restack serialization boundary, scoped to one chain: two restacks of
 * disjoint chains run concurrently, while two writers touching the same
 * worktrees (a CLI `wt restack` racing the TUI's `R`, or a destroy racing
 * a replay — destroys take the same per-slug lock) still exclude each
 * other. Both restack mutators go through this — reconcile and replay
 * each do read-records → async git/gh work → write-records-back, so two
 * unserialized same-chain writers would silently lose whichever write
 * lands first.
 *
 * Deadlock-free by construction: slugs are acquired in sorted order,
 * all-or-nothing — any refusal releases everything acquired and the
 * whole set retries until the deadline.
 *
 * Chain membership is re-resolved AFTER the locks are held (records can
 * be rewritten between the unlocked resolve and the acquire — a
 * concurrent destroy's reparent, a `wt base` edit) and must map inside
 * the locked slug set; a chain that grew a member retries against the
 * new shape. The returned chain is the under-lock resolve — callers
 * operate on it directly rather than re-resolving.
 *
 * Known non-participant (audited, accepted): `wt base` / the `b` picker
 * write fork-base records via `setSlugBase` without taking the slug
 * lock, so a base edit landing mid-restack can still race the record
 * writes. Replay's anchor advance is compare-and-set and skips on a
 * moved record; reconcile's reparent is a plain overwrite — worst case
 * a hand edit issued during the seconds a reconcile runs is clobbered
 * by (or clobbers) the reconcile's own reparent, both of which the next
 * reconcile re-derives. The wtstate file itself stays consistent via
 * its own `__wtstate__` flock.
 */
/**
 * One acquire attempt: resolve the chain, take every member's per-slug
 * lock in sorted order, then re-verify membership under lock. Everything
 * between the first acquire and a successful return runs under
 * `Effect.ensuring`: a throw (an I/O error in `tryAcquireLock`, a
 * transient git failure in the verification resolve) with locks already
 * held would otherwise leak them for the life of the process — flock
 * only drops on fd close — wedging those slugs' restack/destroy until a
 * restart. Fails with `ChainLockContention` (retried by `lockChain`) when
 * a member's lock is held elsewhere or membership grew under us; any
 * other failure is a genuine `StackLockError` and propagates uncaught.
 */
const attemptChainLock = Effect.fnUntraced(function* (
  branch: string,
  phase: string,
): Effect.fn.Return<
  { status: "gone" } | { status: "ok"; chain: RestackChain; handles: readonly LockHandle[] },
  StackLockError | ChainLockContention
> {
  const probe = yield* resolveChain(branch).pipe(
    Effect.mapError((cause) => new StackLockError({ cause })),
  );
  if (!probe) return { status: "gone" } as const;
  const slugs = [...new Set(probe.steps.map((s) => s.slug))].sort();
  const handles: LockHandle[] = [];
  let keep = false;
  return yield* Effect.gen(function* () {
    let refused = false;
    for (const slug of slugs) {
      const h = yield* Effect.try({
        try: () => tryAcquireLock(slug, "restack", { phase }),
        catch: (cause) => new StackLockError({ cause }),
      });
      if (!h) {
        refused = true;
        break;
      }
      handles.push(h);
    }
    if (!refused) {
      const chain = yield* resolveChain(branch).pipe(
        Effect.mapError((cause) => new StackLockError({ cause })),
      );
      if (!chain) {
        return { status: "gone" } as const;
      }
      const locked = new Set(slugs);
      if (chain.steps.every((s) => locked.has(s.slug))) {
        keep = true;
        return { status: "ok", chain, handles } as const;
      }
      // Membership grew under us — release and retry against the new shape.
    }
    return yield* new ChainLockContention({});
  }).pipe(
    Effect.ensuring(Effect.sync(() => {
      if (!keep) releaseHandles(handles);
    })),
  );
});

export const lockChain = Effect.fn("lockChain")(function* (
  branch: string,
  phase: string,
): Effect.fn.Return<ChainLockResult, StackLockError> {
  return yield* attemptChainLock(branch, phase).pipe(
    // Jitter so two chains repeatedly colliding on a shared member (a
    // stack-on-stack boundary) don't retry in lockstep for the whole
    // deadline (same rationale as the engine's lockBackoff).
    Effect.retry({
      schedule: Schedule.spaced("250 millis").pipe(Schedule.jittered, Schedule.upTo({ duration: "5 seconds" })),
      while: (e) => e._tag === "ChainLockContention",
    }),
    Effect.catchTag("ChainLockContention", () => Effect.succeed({ status: "busy" } as const)),
  );
});

export function lockChainPromise(
  branch: string,
  phase: string,
): Promise<ChainLockResult> {
  return Effect.runPromise(lockChain(branch, phase));
}

export function withLockedChain<A, E, R>(
  branch: string,
  phase: string,
  use: (locked: ChainLockResult) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | StackLockError, R> {
  return Effect.acquireUseRelease(
    lockChain(branch, phase),
    use,
    (locked) => Effect.sync(() => {
      if (locked.status === "ok") releaseHandles(locked.handles);
    }),
  );
}

/** Retarget a branch's PR base to `expectedBase` when GitHub disagrees.
 *  The PR is resolved live (no cached number exists anymore); a branch
 *  with no PR, or a PR that already left OPEN, is left alone — EXCEPT
 *  the one recoverable-by-human case below, which gets an attention
 *  line instead of silence. */
export const retargetIfNeeded = Effect.fn("retargetIfNeeded")(function* (
  branch: string,
  expectedBase: string,
  onLog: Logger,
): Effect.fn.Return<void, never> {
  const live = yield* viewPrInfo(branch);
  if (!live) return;
  // Deleting a merged parent's branch via the API (`gh pr merge
  // --delete-branch`) makes GitHub CLOSE the child PRs that target it,
  // unrecoverably — a closed PR can neither change base nor reopen once
  // its base ref is gone. (The repo-level "automatically delete head
  // branches" setting retargets children instead; see
  // docs/stacked-prs.md.) The branch itself is fine — this replay just
  // restacked it — so tell the human the one thing only they can do:
  // open a fresh PR. Two guards keep this from crying wolf: the close
  // is only attributed to base deletion when the base ref is actually
  // GONE from origin (an ordinarily-closed PR whose record later
  // reparents would otherwise match), and each PR warns once per
  // process (this runs on every replay pass of an active chain).
  if (live.state === "CLOSED" && live.baseRefName !== expectedBase) {
    if (warnedClosedPrs.has(live.number)) return;
    // A probe that cannot run is not evidence the ref is gone: skip the
    // warning this pass rather than send the human to open a PR on a guess.
    const baseStillExists = yield* gitQuiet(
      ["rev-parse", "--verify", "--quiet", `origin/${live.baseRefName}`],
      config.paths.mainClone,
    ).pipe(Effect.catch(() => Effect.succeed(true)));
    if (baseStillExists) return;
    warnedClosedPrs.add(live.number);
    log.attention.warn(
      `${branch}: PR #${live.number} was closed by GitHub when its base branch was deleted — ` +
        `the branch is restacked onto ${expectedBase}; open a fresh PR for it ` +
        `(avoid \`gh pr merge --delete-branch\`; use the repo's auto-delete setting instead)`,
    );
    return;
  }
  if (live.state !== "OPEN" || live.baseRefName === expectedBase) return;
  const r = yield* retargetPrBase(live.number, expectedBase);
  if (r.ok) onLog(`  retargeted PR #${live.number} base → ${expectedBase}`);
  else onLog(`  warn: retarget PR #${live.number} base: ${r.error}`);
});

export function retargetIfNeededPromise(
  branch: string,
  expectedBase: string,
  onLog: Logger,
): Promise<void> {
  return Effect.runPromise(retargetIfNeeded(branch, expectedBase, onLog));
}
