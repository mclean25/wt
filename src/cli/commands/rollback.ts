/**
 * `wt rollback` — reset the wt source clone to a previously-run
 * version — plus the two automatic offers wired into main.ts: the
 * crash offer (the process just died on a version that never booted
 * healthy) and the stale-sentinel offer (a previous boot of this
 * version started but never finished). Everything on this path is
 * config-free (see core/update.ts): a rollback offer is most valuable
 * precisely when the new code can't even load the config.
 */
import { Effect } from "effect";

import {
  gitSync,
  listRunningWtInstancesEffect,
  performRollbackEffect,
  readUpdateMemory,
  repoUpdateStateEffect,
  shortSha,
  spawnFreshWt,
  wtVersion,
  WT_REPO_ROOT,
} from "../../core/update.ts";
import { firstUnknownFlag, hasHelpFlag } from "../args.ts";
import { bold, cyan, dim, green, red, yellow } from "../colors.ts";
import { confirmEffect, isInteractive } from "../prompt.ts";

const USAGE = `usage: wt rollback [<ref>]

Reset the wt source clone to a previous version. With no <ref>, targets
the last version that completed a healthy boot (see \`wt update log\`).
The version rolled away from is skipped by the startup check until new
commits land on origin; \`wt update\` can always re-apply it explicitly.

Refuses to touch a clone with local changes or unpushed commits.`;

/**
 * The default rollback target: last good boot, else the last update's
 * from-sha, else the from-sha of an update that died mid-apply (the
 * `applying` marker — no journal entry ever landed for it).
 */
function defaultTarget(): string | null {
  const mem = readUpdateMemory();
  if (mem.lastGoodSha) return mem.lastGoodSha;
  const lastUpdate = [...mem.journal].reverse().find((e) => e.kind === "update");
  return lastUpdate?.fromSha ?? mem.applying?.fromSha ?? null;
}

/** Guards shared by the command and the offers. Null = fine to roll back. */
const rollbackBlocker: Effect.Effect<string | null> = Effect.gen(function* () {
  const state = yield* repoUpdateStateEffect;
  if (!state) return `${WT_REPO_ROOT} is not a git checkout (or git is missing)`;
  if (state.dirty) return "the wt clone has local changes — roll back by hand with git";
  if (state.ahead > 0) return `the wt clone is ${state.ahead} commit(s) ahead of ${state.upstream} — roll back by hand with git`;
  return null;
});

function rollBackTo(target: string): Effect.Effect<number> {
  return Effect.gen(function* () {
    const result = yield* performRollbackEffect(target, Date.now());
    if (!result.ok) {
      console.error(red(`rollback failed: ${result.detail}`));
      return 1;
    }
    if (result.depsWarning) console.error(yellow(`⚠ ${result.depsWarning}`));
    console.log(green(`✓ rolled back ${shortSha(result.fromSha)} → ${wtVersion()}`));
    console.log(
      dim(
        `${shortSha(result.fromSha)} is skipped until new commits land on origin (wt update can still re-apply it)`,
      ),
    );
    const pids = yield* listRunningWtInstancesEffect;
    if (pids.length > 0) {
      console.log(
        yellow(
          `${pids.length} running wt instance(s) (pid ${pids.join(", ")}) still on the rolled-back-from code — restart them`,
        ),
      );
    }
    return 0;
  });
}

export function run(argv: string[]): Effect.Effect<number> {
  return Effect.gen(function* () {
    if (hasHelpFlag(argv)) {
      console.log(USAGE);
      return 0;
    }
    const unknown = firstUnknownFlag(argv, new Set());
    if (unknown) {
      console.error(red(`unknown flag: ${unknown}\n`));
      console.error(USAGE);
      return 2;
    }
    const refArg = argv.find((a) => !a.startsWith("-")) ?? null;

    const blocker = yield* rollbackBlocker;
    if (blocker) {
      console.error(yellow(blocker));
      return 1;
    }
    const target = refArg
      ? gitSync(["rev-parse", "--verify", `${refArg}^{commit}`])
      : defaultTarget();
    if (!target) {
      console.error(
        refArg
          ? red(`cannot resolve ${refArg} to a commit in the wt clone`)
          : red(
              "no rollback target on record (no healthy boot or update in the journal) — pass a <ref>",
            ),
      );
      return 1;
    }
    const head = gitSync(["rev-parse", "HEAD"]);
    if (head === target) {
      console.log(dim(`already on ${shortSha(target)} — nothing to roll back`));
      return 0;
    }
    const code = yield* rollBackTo(target);
    if (code === 0 && refArg) {
      // Default targets earned trust by booting; an arbitrary ref hasn't.
      console.log(
        dim(
          "(explicit target — it was never boot-probed; if it misbehaves, `wt update` re-applies forward)",
        ),
      );
    }
    return code;
  });
}

// ── Automatic offers (main.ts) ─────────────────────────────────────────

/** Is the update system active for this process? Mirrors main.ts's gating. */
function offersEnabled(): boolean {
  return isInteractive() && process.env.WT_UPDATE !== "off";
}

/**
 * Conditions under which an automatic rollback offer makes sense:
 * HEAD is the target of a journaled update, it has never completed a
 * healthy boot, the clone isn't being driven by hand, and there is a
 * target to go back to. Returns null when any of that fails.
 */
function offerContext(): Effect.Effect<{ head: string; target: string } | null> {
  return Effect.gen(function* () {
    if (!offersEnabled()) return null;
    const head = gitSync(["rev-parse", "HEAD"]);
    if (!head) return null;
    const mem = readUpdateMemory();
    if (mem.lastGoodSha === head) return null;
    // "A fresh update landed here": a journal entry, or an `applying`
    // marker from an update that was killed before it could journal.
    const freshUpdate =
      mem.journal.some((e) => e.kind === "update" && e.toSha === head) ||
      mem.applying?.toSha === head;
    if (!freshUpdate) return null;
    if (yield* rollbackBlocker) return null;
    const target = defaultTarget();
    if (!target || target === head) return null;
    // rev-parse prints the sha on success, so gitSync's null-on-failure
    // maps cleanly to "no safe target".
    if (!gitSync(["rev-parse", "--verify", `${target}^{commit}`])) return null;
    return { head, target };
  });
}

/** Re-exec a fresh TUI after a successful offered rollback; never returns. */
const reexecTuiEffect: Effect.Effect<never> = Effect.sync((): void => {
  console.log(dim("restarting wt …"));
  process.exit(spawnFreshWt());
}).pipe(Effect.andThen(Effect.never));

/**
 * Called from main.ts's top-level catch: the process just crashed. If
 * the running version is a fresh update that never booted healthy,
 * offer to roll back to the one that did (default yes — we KNOW it
 * crashed). On acceptance this re-execs and never returns; in every
 * other case it returns so the caller can exit with the original
 * failure. Must never throw: it runs inside a crash handler.
 */
export function maybeOfferCrashRollbackEffect(): Effect.Effect<void> {
  return Effect.gen(function* () {
    const ctx = yield* offerContext();
    if (!ctx) return;
    console.error("");
    console.error(
      bold(`wt crashed on ${shortSha(ctx.head)}, a fresh update that has not booted successfully before.`),
    );
    const yes = yield* confirmEffect(
      `${cyan("•")} Roll back to ${shortSha(ctx.target)} — the last version that worked?`,
      true,
    );
    if (!yes) {
      console.error(dim(`  staying on ${shortSha(ctx.head)} (roll back later with \`wt rollback\`)`));
      return;
    }
    if ((yield* rollBackTo(ctx.target)) === 0) return yield* reexecTuiEffect;
  }).pipe(Effect.catchCause(() => Effect.void));
}

/**
 * Called pre-TUI: a leftover boot sentinel means the last start of
 * this exact version began but never proved healthy — usually a crash
 * the top-level catch couldn't see (native crash, kill). Weaker
 * evidence than a live crash, so the offer defaults to NO; declining
 * just boots normally (and a healthy boot clears the suspicion).
 */
export function maybeOfferStaleBootRollbackEffect(): Effect.Effect<void> {
  return Effect.gen(function* () {
    const mem = readUpdateMemory();
    // Root must match: another clone's sentinel is not our evidence.
    if (!mem.booting || mem.booting.root !== WT_REPO_ROOT) return;
    const ctx = yield* offerContext();
    if (!ctx || mem.booting.sha !== ctx.head) return;
    console.log(
      yellow(`the last start of wt ${shortSha(ctx.head)} (a fresh update) never finished booting — it may have crashed.`),
    );
    const yes = yield* confirmEffect(
      `${cyan("•")} Roll back to ${shortSha(ctx.target)} before starting?`,
      false,
    );
    if (yes && (yield* rollBackTo(ctx.target)) === 0) return yield* reexecTuiEffect;
  }).pipe(Effect.catchCause(() => Effect.void));
}
