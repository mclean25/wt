import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("[logs]");

/**
 * The slug a destroy-log filename belongs to, or null if the name isn't
 * one. `<slug>-<iso>.log`, where the stamp is `YYYY-MM-DDTHH-MM-SS-mmmZ`
 * per `spawnBackgroundRemove`, so the slug is everything before the
 * first `-YYYY-…` chunk.
 *
 * Matching the stamp explicitly is what makes this EXACT, and exact is
 * required rather than tidy: `-` is legal inside a slug and separates
 * the slug from the stamp, so a `startsWith(`${slug}-`)` test also
 * matches every longer slug beginning with this one. That is not a
 * hypothetical population — slugs derived from the same issue id are
 * routinely prefixes of each other (`coz-1691` and
 * `coz-1691-domestic-bovid`), and the reader can't tell it got a
 * neighbour's log.
 */
export function destroyLogSlug(name: string): string | null {
  if (!name.endsWith(".log")) return null;
  return /^(.+)-\d{4}-\d{2}-\d{2}T/.exec(name)?.[1] ?? null;
}

/**
 * Newest `<slug>-*.log` under `config.paths.logDir` by mtime, or null
 * if none. Used to find the tail target for a worktree without needing
 * the lock meta to record the log path — the log file may outlive the
 * lock.
 */
export function latestLogFor(slug: string): string | null {
  const dir = config.paths.logDir;
  if (!existsSync(dir)) return null;
  let best: { path: string; mtime: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (destroyLogSlug(name) !== slug) continue;
    const path = join(dir, name);
    // The file can vanish between readdir and stat (startup reap, manual
    // cleanup) — this runs on a polling path, so skip rather than throw.
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best?.path ?? null;
}

/**
 * Drop `<slug>-*.log` destroy-log files whose slug isn't in `liveSlugs`.
 * Called from startup reap so the dir doesn't accumulate ghosts from
 * worktrees the user removed long ago. Live-slug logs are kept
 * regardless of age — the user might be tailing them via `wt logs
 * <slug>` while a destroy is in flight.
 *
 * Errors are swallowed: a missing dir, a permission glitch, or a
 * filename that doesn't match the expected shape are all best-effort
 * skips. An accumulated log is a worse outcome than blocking startup.
 */
export function reapDestroyLogs(liveSlugs: ReadonlySet<string>): void {
  const dir = config.paths.logDir;
  if (!existsSync(dir)) return;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  let removed = 0;
  for (const name of names) {
    const slug = destroyLogSlug(name);
    if (slug === null || liveSlugs.has(slug)) continue;
    const path = join(dir, name);
    try {
      rmSync(path, { force: true });
      removed++;
    } catch (err) {
      log.warn("destroy log reap failed", {
        path,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (removed > 0) log.info("reaped destroy logs", { removed });
}
