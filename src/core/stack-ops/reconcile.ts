import { Data, Effect } from "effect";

import { branchExists } from "../git.ts";
import { viewPrInfo } from "../github/mutations.ts";
import type { ProcError } from "../proc.ts";
import { setSlugBase } from "../wtstate.ts";
import { type ChainStep, type RestackChain } from "./chain.ts";
import { STACK_BUSY, type Logger, withLockedChain } from "./shared.ts";
import { causeMessage } from "../errors.ts";

export class StackReconcileError extends Data.TaggedError("StackReconcileError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return causeMessage(this.cause);
  }
}

/**
 * Reconcile the fork-base records of the stack containing `branch`
 * against landed reality: a member whose recorded parent has MERGED (or,
 * for a parent with no live worktree, whose branch is gone everywhere)
 * is reparented onto the nearest surviving ancestor — the landed
 * parent's own recorded parent, walking up through consecutive landings,
 * falling to trunk. The member's `baseSha` anchor is PRESERVED across
 * the reparent: the landed parent's commits sit below the anchor and are
 * excluded from the next replay by construction, which is exactly what
 * makes the squash-merge case safe. Record bookkeeping only — reads
 * GitHub/git state but never rewrites branches — so `/restack` can run
 * it on its own before deciding to replay.
 */
export function reconcileStack(
  branch: string,
  trunk: string,
  onLog: Logger,
): Effect.Effect<Set<string>, StackReconcileError> {
  return withLockedChain(branch, "reconcile", (locked) => {
  if (locked.status === "busy") {
    onLog(`skipped reconcile of ${branch} — ${STACK_BUSY}`);
    return Effect.succeed(new Set<string>());
  }
  if (locked.status === "gone") return Effect.succeed(new Set<string>());
  return reconcileStackLocked(locked.chain, trunk, onLog);
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof StackReconcileError ? cause : new StackReconcileError({ cause }),
    ),
  );
}

export function reconcileStackPromise(
  branch: string,
  trunk: string,
  onLog: Logger,
): Promise<Set<string>> {
  return Effect.runPromise(reconcileStack(branch, trunk, onLog));
}

const reconcileStackLocked = Effect.fnUntraced(function* (
  chain: RestackChain,
  trunk: string,
  onLog: Logger,
): Effect.fn.Return<Set<string>, ProcError> {
  const stepByBranch = new Map<string, ChainStep>(
    chain.steps.map((s) => [s.branch, s]),
  );

  // Probe every distinct non-trunk parent's PR state in parallel.
  const parents = [
    ...new Set(
      chain.steps
        .map((s) => s.parentBranch)
        .filter((p): p is string => p !== null),
    ),
  ];
  const probed = yield* Effect.forEach(
    parents,
    (p) => viewPrInfo(p).pipe(Effect.map((live) => ({ parent: p, live }))),
    { concurrency: 4 },
  );

  const landed = new Set<string>();
  for (const { parent, live } of probed) {
    if (live?.state === "MERGED") {
      landed.add(parent);
      onLog(`parent ${parent} merged (#${live.number})`);
      continue;
    }
    // A parent that IS a live worktree obviously still exists; the
    // gone-branch case only applies to external parents. No PR and no
    // branch anywhere — the parent is gone. (A CLOSED PR or a still-open
    // parent leaves the link alone.) The `branchExists` corroboration is
    // LOAD-BEARING, not belt-and-braces: `viewPrInfo` returns null for a
    // transient gh failure exactly as it does for "no PR", and without
    // the second check a gh hiccup would reparent a member whose parent
    // is alive.
    if (!live && !stepByBranch.has(parent) && !(yield* branchExists(parent))) {
      landed.add(parent);
      onLog(`parent ${parent} is gone`);
    }
  }
  if (landed.size === 0) return landed;

  for (const s of chain.steps) {
    if (s.parentBranch === null || !landed.has(s.parentBranch)) continue;
    // A member that itself landed will be cleaned; don't bother
    // rewriting its record.
    if (landed.has(s.branch)) continue;
    // Walk up through consecutively-landed ancestors: the new parent is
    // the first survivor (an in-chain parent's own recorded parent), or
    // trunk when the walk runs off the chain (external parents can't be
    // walked past — their records live in another checkout, if anywhere).
    let candidate: string | null = s.parentBranch;
    while (candidate !== null && landed.has(candidate)) {
      candidate = stepByBranch.get(candidate)?.parentBranch ?? null;
    }
    const newParent = candidate ?? trunk;
    // Reparent the RECORD, preserving the anchor. `baseSha` stays valid:
    // it still names the tip this member's own commits sit on, which is
    // what keeps the subsequent replay squash-safe.
    setSlugBase(s.slug, {
      branch: newParent,
      ...(s.baseSha ? { sha: s.baseSha } : {}),
    });
    onLog(`reparented ${s.branch} onto ${newParent}`);
  }
  return landed;
}, Effect.mapError((cause) =>
  cause instanceof StackReconcileError ? cause : new StackReconcileError({ cause }),
));
