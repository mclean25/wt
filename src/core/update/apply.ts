/**
 * The mutating half of the self-update system: fast-forward to a
 * target, smoke-check the result (reverting on failure), and roll
 * back. Config-free (see exec.ts).
 */
import { Clock, Effect, Scope } from "effect";

import {
  gitOkEffect,
  resetWtVersionCache,
  runInResultEffect,
  shortSha,
  updateGitLockEffect,
  WT_REPO_ROOT,
  type RunResult,
} from "./exec.ts";
import { clearApplying, markApplying, recordRollback } from "./memory.ts";

/** `bun install` iff the dependency manifest changed between two shas. */
export type ApplyDependencies = {
  readonly gitOk: (args: string[], timeoutMs?: number) => Effect.Effect<string | null>;
  readonly runIn: (argv: string[], opts: { cwd: string; timeoutMs?: number }) => Effect.Effect<RunResult>;
  readonly lock: Effect.Effect<boolean, never, Scope.Scope>;
  readonly now: Effect.Effect<number>;
  readonly resetVersionCache: () => void;
  readonly markApplying: typeof markApplying;
  readonly clearApplying: typeof clearApplying;
  readonly recordRollback: typeof recordRollback;
};

const productionDependencies: ApplyDependencies = {
  gitOk: gitOkEffect,
  runIn: runInResultEffect,
  lock: updateGitLockEffect,
  now: Clock.currentTimeMillis,
  resetVersionCache: resetWtVersionCache,
  markApplying,
  clearApplying,
  recordRollback,
};

function syncDepsAcrossEffect(
  fromSha: string,
  toSha: string,
  dependencies: ApplyDependencies,
): Effect.Effect<{ ran: boolean; ok: boolean; detail: string }> {
  return Effect.gen(function* () {
    const changed = yield* dependencies.gitOk([
      "diff", "--name-only", `${fromSha}..${toSha}`, "--",
      "package.json", "bun.lock", "bun.lockb",
    ]);
    if (!changed) return { ran: false, ok: true, detail: "" };
    const inst = yield* dependencies.runIn(["bun", "install"], {
      cwd: WT_REPO_ROOT,
      timeoutMs: 180_000,
    });
    return {
      ran: true,
      ok: inst.exitCode === 0,
      detail: inst.exitCode === 0
        ? ""
        : inst.stderr.trim().split("\n").at(-1) ?? `exit ${inst.exitCode}`,
    };
  });
}

/**
 * Boot-probe the checkout as it stands on disk: `version` first (the
 * config-free update/CLI chain — main.ts dispatches it around
 * cli/index.ts), then an import of the full TUI module tree, which
 * pulls `core/config.ts` and therefore catches "new code rejects the
 * user's existing config", the likeliest hot-update break. Runs in a
 * child process, so a syntax error, missing dep, or config rejection
 * surfaces here instead of at the user's next launch.
 */
export function smokeCheckoutEffect(
  dependencies: ApplyDependencies = productionDependencies,
): Effect.Effect<{ ok: true } | { ok: false; detail: string }> {
  return Effect.gen(function* () {
    const version = yield* dependencies.runIn([process.execPath, "src/main.ts", "version"], {
      cwd: WT_REPO_ROOT,
      timeoutMs: 30_000,
    });
    if (version.exitCode !== 0) {
      return { ok: false, detail: lastLines("wt version", version.stderr, version.exitCode) };
    }
    const entry = `${WT_REPO_ROOT}/src/tui/runtime.tsx`;
    const probe = `import(${JSON.stringify(entry)}).then(() => process.exit(0), (e) => { console.error(e?.stack ?? String(e)); process.exit(1); })`;
    const imp = yield* dependencies.runIn([process.execPath, "-e", probe], {
      cwd: WT_REPO_ROOT,
      timeoutMs: 45_000,
    });
    if (imp.exitCode !== 0) {
      return { ok: false, detail: lastLines("TUI import", imp.stderr, imp.exitCode) };
    }
    return { ok: true };
  });
}

function lastLines(stage: string, stderr: string, exitCode: number): string {
  const tail = stderr.trim().split("\n").slice(-4).join("\n").trim();
  return `${stage} probe failed (exit ${exitCode})${tail ? `:\n${tail}` : ""}`;
}

export type ApplyResult =
  | { ok: true; installedDeps: boolean; depsWarning: string | null }
  | {
      ok: false;
      stage: "merge" | "smoke" | "lock";
      detail: string;
      reverted: boolean;
      /** Set when the post-revert deps restore ALSO failed — the reverted-to version may not start until a manual `bun install`. */
      depsRestoreWarning?: string | null;
    };

/**
 * Fast-forward to `targetSha` (objects already local from the fetch —
 * no second network trip), sync deps, then boot-probe. A probe
 * failure reverts code AND deps to the starting sha, so a broken push
 * never becomes the running install; the caller records the decline so
 * the daily check skips the bad version until origin moves. A deps
 * install failure after a PASSING probe is a warning, not a rollback:
 * the code moved, the caller must surface it. Serialized against
 * concurrent updates/rollbacks by the update-git lock, and bracketed
 * by the `applying` marker so a kill mid-sequence still leaves the
 * offers a rollback target.
 */
export function applyWtUpdateEffect(
  targetSha: string,
  dependencies: ApplyDependencies = productionDependencies,
): Effect.Effect<ApplyResult> {
  return Effect.scoped(Effect.gen(function* () {
    const locked = yield* dependencies.lock;
    if (!locked) {
      return {
        ok: false,
        stage: "lock",
        detail: "another wt update/rollback appears to be in progress — retry shortly",
        reverted: false,
      } as const;
    }
    let before = yield* dependencies.gitOk(["rev-parse", "HEAD"]);
    if (before) {
      const now = yield* dependencies.now;
      yield* Effect.sync(() => dependencies.markApplying(before!, targetSha, now));
    }
    const merge = yield* dependencies.runIn(["git", "merge", "--ff-only", "--quiet", targetSha], {
      cwd: WT_REPO_ROOT,
      timeoutMs: 60_000,
    });
    yield* Effect.sync(dependencies.resetVersionCache);
    if (merge.exitCode !== 0) {
      yield* Effect.sync(dependencies.clearApplying);
      return {
        ok: false,
        stage: "merge",
        detail: merge.stderr.trim() || merge.stdout.trim() || `exit ${merge.exitCode}`,
        reverted: false,
      };
    }
    // The one revert anchor: if the pre-merge rev-parse transiently
    // failed, the reflog still knows where the merge moved us from.
    if (!before) before = yield* dependencies.gitOk(["rev-parse", "HEAD@{1}"]);
    const deps = before
      ? yield* syncDepsAcrossEffect(before, targetSha, dependencies)
      : { ran: false, ok: true, detail: "" };
    const smoke = yield* smokeCheckoutEffect(dependencies);
    if (!smoke.ok) {
      const detail = smoke.detail;
      let depsRestoreWarning: string | null = null;
      if (before) {
        const revert = yield* dependencies.runIn(["git", "reset", "--hard", "--quiet", before], {
          cwd: WT_REPO_ROOT,
          timeoutMs: 60_000,
        });
        yield* Effect.sync(dependencies.resetVersionCache);
        if (revert.exitCode !== 0) {
          return {
            ok: false,
            stage: "smoke",
            detail: `${detail}\nAND the revert failed: ${revert.stderr.trim()}`,
            reverted: false,
          };
        }
        yield* Effect.sync(dependencies.clearApplying);
        if (deps.ran) {
          const back = yield* syncDepsAcrossEffect(targetSha, before, dependencies);
          if (!back.ok) {
            depsRestoreWarning = `restoring dependencies failed (${back.detail}) — run bun install in ${WT_REPO_ROOT} or the reverted-to version may not start`;
          }
        }
      }
      return { ok: false, stage: "smoke", detail, reverted: before !== null, depsRestoreWarning };
    }
    return {
      ok: true,
      installedDeps: deps.ran && deps.ok,
      depsWarning: deps.ok
        ? null
        : `dependencies changed but \`bun install\` failed (${deps.detail}) — run it in ${WT_REPO_ROOT} manually`,
    };
  }));
}

/**
 * Reset the clone to `targetSha`, sync deps across the jump, and
 * record the journal entry + decline of the sha we abandoned. Shared
 * by `wt rollback` and the crash offer. No boot probe: the DEFAULT
 * targets (last good boot, last update's from-sha) already proved they
 * boot — an explicit `wt rollback <ref>` target carries no such proof,
 * which the command surfaces to the user rather than probing here.
 */
export function performRollbackEffect(
  targetSha: string,
  now: number,
  dependencies: ApplyDependencies = productionDependencies,
): Effect.Effect<{ ok: true; fromSha: string; depsWarning: string | null } | { ok: false; detail: string }> {
  return Effect.scoped(Effect.gen(function* () {
    const locked = yield* dependencies.lock;
    if (!locked) {
      return { ok: false, detail: "another wt update/rollback appears to be in progress — retry shortly" } as const;
    }
    const fromSha = yield* dependencies.gitOk(["rev-parse", "HEAD"]);
    if (!fromSha) return { ok: false, detail: "cannot resolve HEAD" };
    const reset = yield* dependencies.runIn(["git", "reset", "--hard", "--quiet", targetSha], {
      cwd: WT_REPO_ROOT,
      timeoutMs: 60_000,
    });
    yield* Effect.sync(dependencies.resetVersionCache);
    if (reset.exitCode !== 0) {
      return { ok: false, detail: reset.stderr.trim() || `git reset exit ${reset.exitCode}` };
    }
    const deps = yield* syncDepsAcrossEffect(fromSha, targetSha, dependencies);
    yield* Effect.sync(() => dependencies.recordRollback({ now, fromSha, toSha: targetSha }));
    return {
      ok: true,
      fromSha,
      depsWarning: deps.ok
        ? null
        : `dependencies differ but \`bun install\` failed (${deps.detail}) — run it in ${WT_REPO_ROOT}; ${shortSha(targetSha)} may not start until then`,
    };
  }));
}
