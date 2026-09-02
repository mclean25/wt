import { Clock, Effect } from "effect";

import { isRiftWorktree } from "../backend.ts";
import { gitRunEffect } from "../git.ts";
import { listWorktreesEffect } from "../worktree.ts";
import { backupBranchOwner, backupTimestamp } from "./engine.ts";
import type { Logger } from "./shared.ts";

// ---------- backup pruning ----------

export type PruneBackupsResult = { deleted: string[]; kept: string[] };

/** Sweep one object store's `backup/` refs, accumulating into result. */
function pruneBackupsInEffect(
  cwd: string | undefined,
  cutoff: number,
  onLog: Logger,
): Effect.Effect<PruneBackupsResult> {
  return Effect.gen(function* () {
  const out: PruneBackupsResult = { deleted: [], kept: [] };
  const args = ["for-each-ref", "--format=%(refname:short)", "refs/heads/backup/"];
  const r = yield* gitRunEffect(args, cwd).pipe(
    Effect.catchAll(() => Effect.succeed(null)),
  );
  if (r === null || r.exitCode !== 0) return out;
  for (const ref of r.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
    if (backupBranchOwner(ref) === null) {
      out.kept.push(ref);
      continue;
    }
    const ts = backupTimestamp(ref);
    if (ts === null || ts > cutoff) {
      out.kept.push(ref);
      continue;
    }
    const del = yield* gitRunEffect(["branch", "-D", ref], cwd).pipe(
      Effect.catchAll(() => Effect.succeed(null)),
    );
    if (del?.exitCode === 0) {
      out.deleted.push(ref);
      onLog(`  deleted ${ref}${cwd ? ` (in ${cwd})` : ""}`);
    } else {
      out.kept.push(ref);
      onLog(`  could not delete ${ref}: ${(del?.stderr || del?.stdout || "git failed").trim()}`);
    }
  }
  return out;
  });
}

/**
 * Delete restack backup branches (`backup/restack-*` and the retired stack
 * CLI's `backup/stack-sync-*`) older than `olderThanDays` (0 = all of them).
 * Backups exist to recover an in-flight conflict bail; once a branch replays
 * clean the engine prunes its own, but conflict leftovers and pre-pruning
 * history pile up — this is the manual sweep. `git branch -D` doesn't destroy
 * commits; everything stays reachable via the reflog. Refs under `backup/`
 * that don't match a known naming scheme are left alone.
 *
 * The main clone's object db is swept first (it covers every git-worktree
 * backend backup, since those worktrees share it). A rift slice is an
 * INDEPENDENT clone, so its backups live in its own object store and need a
 * per-slice sweep — the engine creates them in the slice cwd
 * (`engine.ts` `replayStep`), so the manual sweep must look there too.
 */
export function pruneStackBackupsEffect(
  olderThanDays: number,
  onLog: Logger,
): Effect.Effect<PruneBackupsResult> {
  return Effect.gen(function* () {
  const cutoff = (yield* Clock.currentTimeMillis) - olderThanDays * 86_400_000;
  const main = yield* pruneBackupsInEffect(undefined, cutoff, onLog);
  // Rift slices carry their own refs; sweep each independent clone too.
  const worktrees = yield* listWorktreesEffect().pipe(
    Effect.catchAll(() => Effect.succeed([])),
  );
  const rift = yield* Effect.forEach(
    worktrees.filter((w) => !w.isMain && isRiftWorktree(w.path)),
    (w) => pruneBackupsInEffect(w.path, cutoff, onLog),
    { concurrency: 4 },
  );
  return rift.reduce(
    (result, next) => ({
      deleted: [...result.deleted, ...next.deleted],
      kept: [...result.kept, ...next.kept],
    }),
    main,
  );
  });
}

export function pruneStackBackups(
  olderThanDays: number,
  onLog: Logger,
): Promise<PruneBackupsResult> {
  return Effect.runPromise(pruneStackBackupsEffect(olderThanDays, onLog));
}
