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
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { constants as osConstants, homedir } from "node:os";
import { join, resolve } from "node:path";

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
    // Known gap: this SIGKILLs only the direct child, not its process
    // group — a timed-out `bun install`'s own children survive. Bun's
    // spawn API exposes no detached/setsid control to close it.
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
    // Bounded: this runs on the unconditional interactive boot path
    // (sentinel arm), where a hung git must not hang every launch.
    const r = Bun.spawnSync(["git", "-C", WT_REPO_ROOT, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 10_000,
    });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

const UPDATE_LOG_FILE = join(homedir(), ".cache", "wt", "logs", "update.log");

/**
 * Best-effort file logging to a FIXED path, deliberately not the app
 * logger: `core/logger.ts` loads the user config at module init, and
 * in the crash path the config loader may be the very thing that's
 * broken — worse, it `process.exit(1)`s on a bad config, which would
 * kill the rollback offer from a fire-and-forget import. Losing a log
 * line is always preferable to that.
 */
export function logSafe(level: "warn" | "error", msg: string): void {
  try {
    mkdirSync(join(homedir(), ".cache", "wt", "logs"), { recursive: true });
    appendFileSync(UPDATE_LOG_FILE, `${new Date().toISOString()} ${level.toUpperCase()} [update] ${msg}\n`);
  } catch {
    // Nothing — logging must never take down an update/rollback path.
  }
}

/**
 * Replace this process's role with a fresh wt: spawn `src/main.ts`
 * with inherited stdio and block until it exits. Used after an
 * accepted update or rollback, where the current process's loaded
 * modules are stale. Signal deaths map to the conventional 128+N so a
 * Ctrl-C in the child doesn't read as a generic failure.
 */
export function spawnFreshWt(): number {
  const child = Bun.spawnSync({
    cmd: [process.execPath, join(WT_REPO_ROOT, "src", "main.ts")],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (typeof child.exitCode === "number") return child.exitCode;
  const signum = child.signalCode
    ? osConstants.signals[child.signalCode as keyof typeof osConstants.signals]
    : undefined;
  return signum ? 128 + signum : 1;
}

const GIT_LOCK_DIR = join(homedir(), ".cache", "wt", "update-git.lock");

/**
 * Cross-process mutual exclusion for the destructive git operations
 * (merge/reset on the ONE shared source clone). `core/locks.ts` is
 * off-limits here (config chain + FFI), so this is a plain mkdir
 * lock: atomic on every filesystem, config-free, and a dead holder is
 * detected by pid-liveness (EPERM still means alive) or age. Waits
 * briefly rather than long — the holder may legitimately run `bun
 * install` for minutes, and "another update is in progress, retry" is
 * a better answer than a silent multi-minute block.
 */
export async function acquireUpdateGitLock(): Promise<(() => void) | null> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      mkdirSync(GIT_LOCK_DIR, { recursive: false });
      writeFileSync(join(GIT_LOCK_DIR, "pid"), String(process.pid));
      return () => {
        try {
          rmSync(GIT_LOCK_DIR, { recursive: true, force: true });
        } catch {
          // Releasing best-effort; staleness detection reclaims it.
        }
      };
    } catch {
      let stale = false;
      try {
        const pid = parseInt(readFileSync(join(GIT_LOCK_DIR, "pid"), "utf8"), 10);
        let alive = false;
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            alive = true;
          } catch (err) {
            alive = (err as NodeJS.ErrnoException).code === "EPERM";
          }
        }
        const age = Date.now() - statSync(GIT_LOCK_DIR).mtimeMs;
        stale = !alive || age > 15 * 60_000;
      } catch {
        // Half-created lock (mkdir landed, pid write didn't): only the
        // age test applies, and statSync failing means it's gone.
        try {
          stale = Date.now() - statSync(GIT_LOCK_DIR).mtimeMs > 60_000;
        } catch {
          stale = false;
        }
      }
      if (stale) {
        try {
          rmSync(GIT_LOCK_DIR, { recursive: true, force: true });
        } catch {
          // Someone else reclaimed it first — loop and retry.
        }
        continue;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return null;
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
