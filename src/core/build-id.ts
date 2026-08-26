/**
 * Which build of wt is this process running?
 *
 * Users update hot from main, so two wt processes on one machine are
 * routinely different builds — and one of them, the `wt events` daemon,
 * is a launchd agent that stays up across every update. It hands the TUI
 * a PARSED snapshot, so a daemon started weeks ago answers today's
 * questions with its own build's parsing rules and the TUI has no way to
 * tell. That is not hypothetical: a daemon running Aug-19 code served a
 * red checks badge on a green PR and a stale review-bot badge on a PR the
 * bot had just cleared, on a TUI that held both fixes and never got to
 * use them.
 *
 * The source clone's HEAD is the identity. It is not a perfect one — an
 * UNCOMMITTED edit moves the code without moving the sha, so a daemon
 * started mid-edit still looks current. That gap is deliberate rather
 * than papered over: the check that would close it (a dirty-tree hash) is
 * a `git status` per read, and every observed instance of the bug spanned
 * commits, which is what a long-lived daemon does by construction.
 */
import { WT_REPO_ROOT } from "./update/exec.ts";

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * The source clone's current HEAD, or null when it cannot be read (not a
 * git checkout, no git on PATH). Uncached on purpose: the daemon calls it
 * to notice the tree moving UNDER it, which a memo would hide.
 */
export function currentSourceSha(): string | null {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: WT_REPO_ROOT,
      stdout: "pipe",
      stderr: "ignore",
    });
    if (r.exitCode !== 0) return null;
    const sha = r.stdout.toString().trim();
    return SHA_RE.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

let cached: string | null | undefined;

/**
 * The sha this process was STARTED from — the one that describes the code
 * actually loaded, since bun read every module at boot. Memoized, so a
 * reader on a hot path pays one `git rev-parse` per process.
 */
export function buildSha(): string | null {
  if (cached === undefined) cached = currentSourceSha();
  return cached;
}

/**
 * Should a reader trust an artifact stamped `writerSha`?
 *
 * Fails CLOSED on a MISSING stamp, because only a build older than this
 * one writes an unstamped artifact — absence is the diagnosis, not a
 * missing input. Fails OPEN when the reader cannot identify itself at
 * all, which is a wt that is not a git checkout: there is no version
 * question to answer there, and refusing would disable the daemon
 * permanently for no benefit.
 */
export function sameBuild(writerSha: string | null | undefined): boolean {
  const mine = buildSha();
  if (mine === null) return true;
  if (!writerSha) return false;
  return writerSha === mine;
}
