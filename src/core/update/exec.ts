/**
 * Process/git plumbing for the self-update system, plus the version
 * string. EVERYTHING under `core/update/` must stay config-free: the
 * crash-rollback path (main.ts catch → cli/commands/rollback.ts) has
 * to work when `core/config.ts` is exactly what the broken update
 * can't load — so no imports of config, proc, locks, or logger (all of
 * which pull the config chain in at module init). `runIn` is a local
 * copy of proc.ts's `run` minus config defaults and signal plumbing;
 * `logSafe` is a best-effort lazy logger that silently no-ops when the
 * logging chain itself can't load.
 */
import { resolve } from "node:path";

/** Repo root of the wt source tree (this file is `<root>/src/core/update/exec.ts`). */
export const WT_REPO_ROOT: string = resolve(import.meta.dir, "..", "..", "..");

export type RunResult = { stdout: string; stderr: string; exitCode: number };

/** Spawn, capture, never throw. Missing binaries / timeouts → exitCode < 0. */
export async function runIn(
  argv: string[],
  opts: { cwd: string; timeoutMs?: number },
): Promise<RunResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
    };
  }
  let timer: Timer | undefined;
  if (opts.timeoutMs) {
    timer = setTimeout(() => proc.kill("SIGKILL"), opts.timeoutMs);
  }
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run git in the source clone; trimmed stdout, or null on any failure. */
export async function gitOk(args: string[], timeoutMs = 10_000): Promise<string | null> {
  const r = await runIn(["git", ...args], { cwd: WT_REPO_ROOT, timeoutMs });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export function gitSync(args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", WT_REPO_ROOT, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort file logging. The logger module transitively loads the
 * user config; in the crash path that may be the very thing that's
 * broken, and losing a log line is preferable to losing the rollback
 * offer. Fire-and-forget by design.
 */
export function logSafe(level: "warn" | "error", msg: string): void {
  void import("../logger.ts")
    .then((m) => {
      const log = m.createLogger("[update]");
      log[level](msg);
    })
    .catch(() => {});
}

/** Display form of a full sha. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// ── Version ────────────────────────────────────────────────────────────

let _version: string | null = null;

/**
 * The running version: `<short-sha> (<commit-date>)`, with a `-dirty`
 * suffix on the sha when the clone has local modifications. Sync and
 * cached for the process lifetime — callers are the help overlay title
 * and `wt version`, both fine paying one ~5ms git call once. The cache
 * is reset by apply/rollback so a post-mutation read shows the new HEAD.
 */
export function wtVersion(): string {
  if (_version !== null) return _version;
  const head = gitSync(["log", "-1", "--format=%h %cs"]);
  if (!head) return (_version = "unknown");
  const [sha, date] = head.split(" ");
  const dirty = gitSync(["status", "--porcelain"]);
  _version = `${sha}${dirty ? "-dirty" : ""}${date ? ` (${date})` : ""}`;
  return _version;
}

export function resetWtVersionCache(): void {
  _version = null;
}
