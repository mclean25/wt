import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Data, Effect } from "effect";

import { git, gitQuiet } from "../git.ts";
import { createLogger } from "../logger.ts";
import { run } from "../proc.ts";
import type {
  BackendCreateInput,
  BackendRemoveInput,
  BackendRemoveResult,
  WorktreeBackend,
} from "./types.ts";

const log = createLogger("[backend:rift]");

export class RiftBackendError extends Data.TaggedError("RiftBackendError")<{
  readonly operation: "resolve" | "init" | "create" | "materialize" | "remove";
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string { return this.detail; }
}

/** True when the `rift` binary is on the process PATH. */
function riftAvailable(): boolean {
  return Bun.which("rift") !== null;
}

/**
 * Resolved rift executable, memoized for the process lifetime. `null`
 * caches "not found" too — PATH doesn't change under a running wt.
 */
let cachedRiftBin: string | null | undefined;

/**
 * Locate the rift executable. The process PATH wins; when wt was
 * spawned from a lean environment (launchd, an editor task, an agent
 * harness) that PATH often misses user-level bins like `~/.bun/bin`, so
 * fall back to asking the user's login shell. `whence -p` (zsh) /
 * `type -P` (bash) are tried before `command -v` so a shell *function*
 * named rift (a common wrapper) can't shadow the real binary with an
 * un-execable answer; any non-absolute result is discarded for the same
 * reason.
 */
export function resolveRiftBin(): Effect.Effect<string | null> {
  if (cachedRiftBin !== undefined) return Effect.succeed(cachedRiftBin);
  if (riftAvailable()) {
    cachedRiftBin = "rift";
    return Effect.succeed(cachedRiftBin);
  }
  const shell = process.env.SHELL || "/bin/bash";
  const probe =
    "whence -p rift 2>/dev/null || type -P rift 2>/dev/null || command -v rift 2>/dev/null";
  // Bounded: a login shell sources the user's full profile, which can
  // legitimately block (an ssh-add prompt, a slow hook) — never let the
  // probe hang a worktree create/remove.
  return run([shell, "-lc", probe], { timeoutMs: 10_000 }).pipe(
    Effect.tapError((err) => Effect.sync(() => log.warn("rift login-shell probe failed", { shell, err: err.message }))),
    Effect.option,
    Effect.map((result) => {
      const out = result._tag === "Some" ? result.value.stdout.trim().split("\n").pop()?.trim() ?? "" : "";
      cachedRiftBin = out.startsWith("/") && existsSync(out) ? out : null;
      if (cachedRiftBin) log.info("resolved rift via login shell", { path: cachedRiftBin, shell });
      return cachedRiftBin;
    }),
  );
}

function requireRiftBinEffect(): Effect.Effect<string, RiftBackendError> {
  return resolveRiftBin().pipe(Effect.flatMap((bin) => {
    if (bin) return Effect.succeed(bin);
    const shell = process.env.SHELL || "/bin/bash";
    return Effect.fail(new RiftBackendError({ operation: "resolve", detail:
    "rift backend selected but the `rift` executable was not found — searched " +
      `PATH (${process.env.PATH ?? "unset"}) and \`${shell} -lc 'command -v rift'\`. ` +
      "Install it (`npm i -g rift-snapshot`) or set `[backend] kind = \"git-worktree\"` " +
      "in your wt config. (The lookup result is cached; restart wt after installing.)" }));
  }));
}

/** A rift-managed checkout carries a `.rift` marker file at its root. */
export function isRiftWorktree(path: string): boolean {
  return existsSync(join(path, ".rift"));
}

/**
 * Rift checkouts are independent clones, so they never appear in
 * `git worktree list`. Discovery scans the worktree root for immediate
 * children carrying a `.rift` marker. Cheap: one readdir + a stat per
 * entry, no subprocess (branch resolution happens in the caller from
 * `.git/HEAD`). Returns absolute paths.
 */
export function listRiftWorktreePaths(worktreeRoot: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(worktreeRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // Root doesn't exist yet (no worktrees created) — nothing to scan.
    return [];
  }
  const paths: string[] = [];
  for (const name of entries) {
    const p = join(worktreeRoot, name);
    if (isRiftWorktree(p)) paths.push(p);
  }
  return paths;
}

/**
 * Idempotently register the main clone with rift. `rift init` is a
 * no-op once a `.rift` marker exists, but we guard on the marker first
 * to avoid spawning the binary on the common already-initialized path.
 * Done lazily at first create rather than at TUI startup so wt never
 * pays a rift subprocess just to launch.
 */
function ensureRiftInitEffect(
  rift: string,
  mainClone: string,
  onLog?: (line: string) => void,
): Effect.Effect<void, RiftBackendError> {
  if (isRiftWorktree(mainClone)) return Effect.void;
  return Effect.sync(() => onLog?.("rift init (registering main clone)")).pipe(
    Effect.andThen(run([rift, "init", "--here"], { cwd: mainClone })),
    Effect.flatMap((r) => {
      if (r.exitCode === 0 || isRiftWorktree(mainClone)) return Effect.void;
    // Two first-ever creates can pass the marker check above before either
    // writes it, then race `rift init` — the loser exits non-zero with a
    // UNIQUE-constraint collision. The desired end state (main clone
    // registered) is already reached by the winner, so tolerate it.
      return Effect.fail(new RiftBackendError({ operation: "init", detail:
        `rift init failed: ${(r.stderr || r.stdout || `exit ${r.exitCode}`).trim()}` }));
    }),
    Effect.mapError((cause) => cause instanceof RiftBackendError ? cause :
      new RiftBackendError({ operation: "init", detail: cause.message, cause })),
  );
}

/**
 * Switch a freshly-cloned rift checkout onto its target branch. rift
 * copies at a detached HEAD on the main clone's current commit, so:
 *  - existing branch (`baseRef === null`): `git switch` it (DWIM creates a
 *    local tracking branch when it exists only on origin);
 *  - new branch: resolve a start commit that actually exists in this
 *    independent clone. When a sibling worktree OWNS the base (a stacked
 *    parent, `baseSourcePath` set), fetch the AUTHORITATIVE live tip from
 *    it — never trust a same-named branch the CoW clone may have copied
 *    from the main clone, which can be a stale leftover. Only when the
 *    fetch can't run (e.g. a linked git-worktree parent sharing main's db,
 *    which the clone already copied) fall back to the ref in the clone.
 *    With no owning worktree (trunk/origin base), the ref must resolve in
 *    the clone directly.
 */
function materializeBranchEffect(input: {
  path: string;
  branch: string;
  baseRef: string | null;
  baseSourcePath?: string;
  onLog?: (line: string) => void;
}): Effect.Effect<void, RiftBackendError> {
  const { path, branch, baseRef, baseSourcePath, onLog } = input;
  // --discard-changes: `--copy-all` CoW-copies the main clone's working
  // tree INCLUDING its uncommitted modifications, and a plain switch
  // refuses when those files differ across the jump ("Your local
  // changes... would be overwritten") — which used to abort creation
  // whenever the main clone was dirty (an agent-edited AGENTS.md was
  // enough). The dirt lives only in this throwaway copy; the main
  // clone's working tree is never touched, so discarding is safe and
  // removes the whole clean-main-clone requirement.
  if (baseRef === null) {
    return Effect.sync(() => onLog?.(`switch to ${branch}`)).pipe(
      Effect.andThen(git(["switch", "--discard-changes", branch], path)),
      Effect.asVoid,
      Effect.mapError((cause) => new RiftBackendError({ operation: "materialize", detail: cause.message, cause })),
    );
  }

  const resolvesInClone = gitQuiet(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], path);
  return Effect.gen(function* () {
    let start = baseRef;
    if (baseSourcePath) {
      onLog?.(`fetching base ${baseRef} from ${basename(baseSourcePath)}`);
      const fetched = yield* run(["git", "fetch", "--no-tags", baseSourcePath, `refs/heads/${baseRef}`], { cwd: path });
      if (fetched.exitCode === 0) start = "FETCH_HEAD";
      else if (yield* resolvesInClone) onLog?.(`fetch from ${basename(baseSourcePath)} failed; using base ${baseRef} from the clone`);
      else return yield* new RiftBackendError({ operation: "materialize", detail:
        `could not fetch base ${baseRef} from ${baseSourcePath}: ${(fetched.stderr || fetched.stdout || `exit ${fetched.exitCode}`).trim()}` });
    } else if (!(yield* resolvesInClone)) {
      return yield* new RiftBackendError({ operation: "materialize", detail:
        `base ${baseRef} is not in the new checkout and no source worktree was found to fetch it from` });
    }
    onLog?.(`new branch ${branch} off ${baseRef}`);
    yield* git(["switch", "--discard-changes", "-c", branch, start], path);
  }).pipe(Effect.mapError((cause) => cause instanceof RiftBackendError ? cause :
    new RiftBackendError({ operation: "materialize", detail: cause.message, cause })));
}

/**
 * Copy-on-write checkout via rift. `--copy-all` brings `node_modules`
 * (and other regenerable artifacts rift excludes by default) across for
 * free via the CoW clone, so wt skips its own `pnpm install` for this
 * backend — packages are always present without a fresh install. rift's
 * own `.rift.toml` postcreate hooks (if the repo defines them) still run
 * to sync lockfile state; wt does not pass `--no-hooks`. Note those hooks
 * run during `rift create`, i.e. at the clone-time detached HEAD, BEFORE
 * the branch switch below — a branch-name-sensitive hook sees the main
 * clone's commit, not the target branch (see docs/backends.md).
 */
export function createRiftWorktree(input: BackendCreateInput): Effect.Effect<void, RiftBackendError> {
  return Effect.gen(function* () {
    const { path, branch, slug, baseRef, baseSourcePath, mainClone, onLog } = input;
    const rift = yield* requireRiftBinEffect();
    yield* ensureRiftInitEffect(rift, mainClone, onLog);

    const into = dirname(path);
    const createArgs = [rift, "create", "--name", slug, "--into", into, "--copy-all"];
    onLog?.(`rift create --copy-all → ${basename(path)}`);
    let created = yield* run(createArgs, { cwd: mainClone });
    // rift's registry is global and outlives the directory: a checkout
    // deleted out-of-band (a hand `rm -rf`, an aborted create) leaves a
    // record that collides here as "UNIQUE constraint failed: rift.path".
    // The path is already absent (createWorktree guards existsSync), so
    // gc-prune the dangling record and retry once — self-healing rather
    // than making the user run `rift gc` by hand.
    if (
      created.exitCode !== 0 &&
      /UNIQUE constraint|already (registered|exists)/i.test(
        `${created.stderr}${created.stdout}`,
      ) &&
      !existsSync(path)
    ) {
      onLog?.("pruning stale rift registry entry, retrying");
      yield* run([rift, "gc"], { cwd: mainClone });
      created = yield* run(createArgs, { cwd: mainClone });
    }
    if (created.exitCode !== 0) {
      return yield* new RiftBackendError({ operation: "create", detail:
        `rift create failed: ${(created.stderr || created.stdout || `exit ${created.exitCode}`).trim()}` });
    }
    // rift prints the new workspace path to stdout; `--into <root> --name
    // <slug>` places it at exactly `<root>/<slug>` == `path`, but honor
    // the reported path if rift ever normalizes it differently.
    const reported = created.stdout.trim();
    if (reported && reported !== path) {
      log.warn("rift create path differs from expected", { reported, expected: path });
    }
    if (!existsSync(path)) {
      return yield* new RiftBackendError({ operation: "create", detail: `rift create did not produce ${path} (got: ${reported})` });
    }

    // The workspace now exists on disk with a `.rift` marker. Materializing
    // the branch is a SEPARATE step that can still fail (bad base, a git
    // error) — and a rift checkout that fails here would linger as a
    // blank-branch ghost row (detached HEAD, discovery keeps surfacing it),
    // unlike git-worktree where a failed `add` registers nothing. So roll
    // the clone back on any failure to keep create atomic.
    yield* materializeBranchEffect({ path, branch, baseRef, baseSourcePath, onLog }).pipe(
      Effect.onExit((exit) => exit._tag === "Success" ? Effect.void : Effect.gen(function* () {
      onLog?.(`rolling back partial rift checkout ${basename(path)}`);
      // A failed rollback leaves an orphaned checkout + rift registry
      // entry; the next create for this slug then hits a bare "path
      // already exists". Log it so the daily log names the orphan.
      const rb1 = yield* run([rift, "remove", path], { cwd: mainClone }).pipe(Effect.orElseSucceed(() => ({ stdout: "", stderr: "rollback spawn failed", exitCode: -1 })));
      if (rb1.exitCode !== 0) {
        log.warn(`rollback rift remove failed for ${path}: ${rb1.stderr.trim() || rb1.exitCode}`);
      }
      const rb2 = yield* run([rift, "gc"], { cwd: mainClone }).pipe(Effect.orElseSucceed(() => ({ stdout: "", stderr: "rollback spawn failed", exitCode: -1 })));
      if (rb2.exitCode !== 0) {
        log.warn(`rollback rift gc failed: ${rb2.stderr.trim() || rb2.exitCode}`);
      }
      })),
    );
  }).pipe(Effect.mapError((cause) => cause instanceof RiftBackendError ? cause :
    new RiftBackendError({ operation: "create", detail: cause.message, cause })));
}

export function removeRiftWorktree(input: BackendRemoveInput): Effect.Effect<BackendRemoveResult, RiftBackendError> {
  return Effect.gen(function* () {
    const { path, force, mainClone, onLog } = input;
    const rift = yield* resolveRiftBin();
    if (!rift) {
      return {
        ok: false,
        message: "rift executable not found (searched process PATH and the login shell)",
      };
    }
    // Mirror the git-worktree backend's force plumbing: when wt has already
    // cleared its own dirty/unpushed guard (a forced `wt rm`), pass rift's
    // `--force` too. rift trashes a dirty created checkout without it today,
    // but this keeps the two backends symmetric and future-proofs against a
    // rift version that refuses a dirty checkout. Harmless on a clean one.
    const args = force ? [rift, "remove", "--force", path] : [rift, "remove", path];
    onLog?.(`rift remove${force ? " --force" : ""} ${basename(path)}`);
    const r = yield* run(args, { cwd: mainClone });
    if (r.exitCode !== 0 && existsSync(path)) {
      return { ok: false, message: (r.stderr || r.stdout || "rift remove failed").trim() };
    }
    // `rift remove` only trashes the subtree; reclaim the disk now. gc is
    // best-effort — the checkout is already gone from its path either way.
    const gc = yield* run([rift, "gc"], { cwd: mainClone });
    if (gc.exitCode !== 0) {
      onLog?.(`rift gc warning: ${(gc.stderr || gc.stdout || "").trim()}`);
    }
    return { ok: true };
  }).pipe(Effect.mapError((cause) => new RiftBackendError({ operation: "remove", detail: cause.message, cause })));
}

export const riftBackend: WorktreeBackend = {
  id: "rift",
  create: (input) => Effect.runPromise(createRiftWorktree(input)),
  remove: (input) => Effect.runPromise(removeRiftWorktree(input)),
};
