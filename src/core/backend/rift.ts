import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

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
export async function resolveRiftBin(): Promise<string | null> {
  if (cachedRiftBin !== undefined) return cachedRiftBin;
  if (riftAvailable()) {
    cachedRiftBin = "rift";
    return cachedRiftBin;
  }
  const shell = process.env.SHELL || "/bin/bash";
  const probe =
    "whence -p rift 2>/dev/null || type -P rift 2>/dev/null || command -v rift 2>/dev/null";
  // Bounded: a login shell sources the user's full profile, which can
  // legitimately block (an ssh-add prompt, a slow hook) — never let the
  // probe hang a worktree create/remove.
  const r = await run([shell, "-lc", probe], { timeoutMs: 10_000 }).catch((err) => {
    log.warn("rift login-shell probe failed", {
      shell,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  });
  const out = r?.stdout.trim().split("\n").pop()?.trim() ?? "";
  cachedRiftBin = out.startsWith("/") && existsSync(out) ? out : null;
  if (cachedRiftBin) {
    log.info("resolved rift via login shell", { path: cachedRiftBin, shell });
  }
  return cachedRiftBin;
}

async function requireRiftBin(): Promise<string> {
  const bin = await resolveRiftBin();
  if (bin) return bin;
  const shell = process.env.SHELL || "/bin/bash";
  throw new Error(
    "rift backend selected but the `rift` executable was not found — searched " +
      `PATH (${process.env.PATH ?? "unset"}) and \`${shell} -lc 'command -v rift'\`. ` +
      "Install it (`npm i -g rift-snapshot`) or set `[backend] kind = \"git-worktree\"` " +
      "in your wt config. (The lookup result is cached; restart wt after installing.)",
  );
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
async function ensureRiftInit(
  rift: string,
  mainClone: string,
  onLog?: (line: string) => void,
): Promise<void> {
  if (isRiftWorktree(mainClone)) return;
  onLog?.("rift init (registering main clone)");
  const r = await run([rift, "init", "--here"], { cwd: mainClone });
  if (r.exitCode !== 0) {
    // Two first-ever creates can pass the marker check above before either
    // writes it, then race `rift init` — the loser exits non-zero with a
    // UNIQUE-constraint collision. The desired end state (main clone
    // registered) is already reached by the winner, so tolerate it.
    if (isRiftWorktree(mainClone)) return;
    throw new Error(
      `rift init failed: ${(r.stderr || r.stdout || `exit ${r.exitCode}`).trim()}`,
    );
  }
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
async function materializeBranch(input: {
  path: string;
  branch: string;
  baseRef: string | null;
  baseSourcePath?: string;
  onLog?: (line: string) => void;
}): Promise<void> {
  const { path, branch, baseRef, baseSourcePath, onLog } = input;
  // --discard-changes: `--copy-all` CoW-copies the main clone's working
  // tree INCLUDING its uncommitted modifications, and a plain switch
  // refuses when those files differ across the jump ("Your local
  // changes... would be overwritten") — which used to abort creation
  // whenever the main clone was dirty (an agent-edited CLAUDE.md was
  // enough). The dirt lives only in this throwaway copy; the main
  // clone's working tree is never touched, so discarding is safe and
  // removes the whole clean-main-clone requirement.
  if (baseRef === null) {
    onLog?.(`switch to ${branch}`);
    await git(["switch", "--discard-changes", branch], path);
    return;
  }

  const resolvesInClone = (): Promise<boolean> =>
    gitQuiet(["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], path);

  let start = baseRef;
  if (baseSourcePath) {
    onLog?.(`fetching base ${baseRef} from ${basename(baseSourcePath)}`);
    const fetched = await run(
      ["git", "fetch", "--no-tags", baseSourcePath, `refs/heads/${baseRef}`],
      { cwd: path },
    );
    if (fetched.exitCode === 0) {
      start = "FETCH_HEAD";
    } else if (await resolvesInClone()) {
      onLog?.(`fetch from ${basename(baseSourcePath)} failed; using base ${baseRef} from the clone`);
      start = baseRef;
    } else {
      throw new Error(
        `could not fetch base ${baseRef} from ${baseSourcePath}: ` +
          `${(fetched.stderr || fetched.stdout || `exit ${fetched.exitCode}`).trim()}`,
      );
    }
  } else if (!(await resolvesInClone())) {
    throw new Error(
      `base ${baseRef} is not in the new checkout and no source ` +
        `worktree was found to fetch it from`,
    );
  }
  onLog?.(`new branch ${branch} off ${baseRef}`);
  await git(["switch", "--discard-changes", "-c", branch, start], path);
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
export const riftBackend: WorktreeBackend = {
  id: "rift",

  async create(input: BackendCreateInput): Promise<void> {
    const { path, branch, slug, baseRef, baseSourcePath, mainClone, onLog } = input;
    const rift = await requireRiftBin();
    await ensureRiftInit(rift, mainClone, onLog);

    const into = dirname(path);
    const createArgs = [rift, "create", "--name", slug, "--into", into, "--copy-all"];
    onLog?.(`rift create --copy-all → ${basename(path)}`);
    let created = await run(createArgs, { cwd: mainClone });
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
      await run([rift, "gc"], { cwd: mainClone });
      created = await run(createArgs, { cwd: mainClone });
    }
    if (created.exitCode !== 0) {
      throw new Error(
        `rift create failed: ${(created.stderr || created.stdout || `exit ${created.exitCode}`).trim()}`,
      );
    }
    // rift prints the new workspace path to stdout; `--into <root> --name
    // <slug>` places it at exactly `<root>/<slug>` == `path`, but honor
    // the reported path if rift ever normalizes it differently.
    const reported = created.stdout.trim();
    if (reported && reported !== path) {
      log.warn("rift create path differs from expected", { reported, expected: path });
    }
    if (!existsSync(path)) {
      throw new Error(`rift create did not produce ${path} (got: ${reported})`);
    }

    // The workspace now exists on disk with a `.rift` marker. Materializing
    // the branch is a SEPARATE step that can still fail (bad base, a git
    // error) — and a rift checkout that fails here would linger as a
    // blank-branch ghost row (detached HEAD, discovery keeps surfacing it),
    // unlike git-worktree where a failed `add` registers nothing. So roll
    // the clone back on any failure to keep create atomic.
    try {
      await materializeBranch({ path, branch, baseRef, baseSourcePath, onLog });
    } catch (err) {
      onLog?.(`rolling back partial rift checkout ${basename(path)}`);
      await run([rift, "remove", path], { cwd: mainClone }).catch(() => {});
      await run([rift, "gc"], { cwd: mainClone }).catch(() => {});
      throw err;
    }
  },

  async remove(input: BackendRemoveInput): Promise<BackendRemoveResult> {
    const { path, force, mainClone, onLog } = input;
    const rift = await resolveRiftBin();
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
    const r = await run(args, { cwd: mainClone });
    if (r.exitCode !== 0 && existsSync(path)) {
      return { ok: false, message: (r.stderr || r.stdout || "rift remove failed").trim() };
    }
    // `rift remove` only trashes the subtree; reclaim the disk now. gc is
    // best-effort — the checkout is already gone from its path either way.
    const gc = await run([rift, "gc"], { cwd: mainClone });
    if (gc.exitCode !== 0) {
      onLog?.(`rift gc warning: ${(gc.stderr || gc.stdout || "").trim()}`);
    }
    return { ok: true };
  },
};
