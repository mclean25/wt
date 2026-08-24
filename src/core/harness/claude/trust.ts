import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { listRiftWorktreePaths } from "../../backend.ts";
import { createLogger } from "../../logger.ts";

const log = createLogger("[claude:trust]");
const CLAUDE_JSON = join(homedir(), ".claude.json");

/**
 * How many times to re-apply after reading back a write that did not
 * survive. Three covers the observed shape (a sibling Claude flushing
 * one stale snapshot); past that something durable is wrong and another
 * pass would just spin.
 */
const ATTEMPTS = 3;
const BACKOFF_MS = [0, 60, 200];

type Projects = Record<string, Record<string, unknown>>;

/** Paths in `wanted` that the parsed file does not (yet) mark trusted. */
function untrusted(projects: Projects, wanted: readonly string[]): string[] {
  return wanted.filter((p) => projects[p]?.hasTrustDialogAccepted !== true);
}

/**
 * Ensure every path in `wanted` is trusted in the Claude config at
 * `jsonPath`, and RE-READ to confirm the write survived.
 *
 * The verification is the point. `renameSync` returning tells you the
 * bytes landed, not that they are still there — `~/.claude.json` is one
 * shared blob that Claude Code itself read-modify-writes, and its window
 * between reading at startup and flushing its snapshot back is seconds,
 * against the ~2.3ms this function spends. So a write can be complete,
 * atomic, and gone. Logging success off the rename reported our own
 * argument back, the same way an unverified store did in
 * `setSlugWorkStatus`: the log said trusted eight times while Michael
 * answered the dialog on three of six worktrees.
 *
 * Returns the paths still untrusted after the last attempt.
 *
 * `opts.afterWrite` fires between the rename and the read-back, and is
 * how the tests stand in for the foreign flush — the race is the entire
 * contract here, so a suite that cannot reproduce it is only testing
 * that JSON round-trips.
 */
export function ensureTrustInFile(
  jsonPath: string,
  wanted: readonly string[],
  opts: { afterWrite?: (jsonPath: string) => void } = {},
): string[] {
  let backedUp = false;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) Bun.sleepSync(BACKOFF_MS[attempt] ?? 200);
    const raw = readFileSync(jsonPath, "utf8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (typeof data !== "object" || data === null) return [...wanted];
    const projects = (data.projects ??= {}) as Projects;

    const missing = untrusted(projects, wanted);
    // Steady state: everything already trusted, so no write at all. That
    // is what keeps this from being a clobber source in its own right.
    if (missing.length === 0) return [];
    for (const p of missing) {
      const entry = (projects[p] ??= {});
      entry.hasTrustDialogAccepted = true;
    }

    // The backup is written from the bytes we just READ, not copied off
    // disk. copyFileSync ran after the read, so a concurrent write in
    // between made `.bak` a snapshot NEWER than the one being replaced —
    // a backup of the wrong thing, which is worse than none because it
    // reads as a safety net. Once per call: a later attempt must not
    // overwrite the good backup with an already-clobbered file.
    if (!backedUp) {
      try {
        writeFileSync(`${jsonPath}.bak`, raw);
        backedUp = true;
      } catch {
        // A locked or unwritable backup target must not abort the trust write.
      }
    }
    const tmp = `${jsonPath}.wt-${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    renameSync(tmp, jsonPath);
    opts.afterWrite?.(jsonPath);

    const after = JSON.parse(readFileSync(jsonPath, "utf8")) as { projects?: Projects };
    const lost = untrusted(after.projects ?? {}, wanted);
    if (lost.length === 0) return [];
  }
  const raw = readFileSync(jsonPath, "utf8");
  return untrusted((JSON.parse(raw) as { projects?: Projects }).projects ?? {}, wanted);
}

/**
 * Mark `wtPath` as trusted in Claude Code's `~/.claude.json` so opening a
 * session there doesn't hit the "Do you trust this folder?" prompt (which
 * also drops the worktree's `.claude/settings.json` allow rules until
 * accepted).
 *
 * Only rift worktrees need this: they're independent clones, so Claude
 * sees each as a brand-new project, whereas a git worktree resolves to
 * the already-trusted main repo.
 *
 * It also REPAIRS its siblings, and that is what makes it hold up under a
 * fan-out. Claude does not clobber one key, it writes a whole snapshot
 * back, so a single stale flush takes out every trust flag wt has set. A
 * per-path seed then heals exactly one worktree per spawn and leaves the
 * rest to be answered by hand — six starts inside 90 seconds produced
 * three dialogs. Re-asserting every rift sibling on each spawn makes the
 * Nth start heal the first N-1, so a batch converges instead of decaying.
 *
 * The sibling set is derived from disk (`listRiftWorktreePaths` on the
 * shared parent) and filtered to entries Claude already knows about, so
 * there is no list to maintain and a destroyed worktree drops out on its
 * own. Every error is swallowed; trust bookkeeping must never block a
 * session spawn (worst case, Claude shows its prompt once, as before).
 */
export function trustClaudeWorkspace(wtPath: string): void {
  try {
    // Claude seeds this file itself on first run; if it's absent, there's
    // nothing to edit and Claude will create + prompt on its own.
    if (!existsSync(CLAUDE_JSON)) return;
    const known = (
      JSON.parse(readFileSync(CLAUDE_JSON, "utf8")) as { projects?: Projects }
    ).projects;

    // Siblings are repaired, never introduced: only paths Claude has an
    // entry for, so wt cannot pre-trust a directory nobody has opened.
    const siblings = listRiftWorktreePaths(dirname(wtPath)).filter(
      (p) => p !== wtPath && known?.[p] !== undefined,
    );
    const wanted = [wtPath, ...siblings];

    const lost = ensureTrustInFile(CLAUDE_JSON, wanted);
    if (lost.length === 0) {
      log.debug("trusted rift workspaces in ~/.claude.json", { wtPath, count: wanted.length });
      return;
    }
    // Worth interrupting a scan: the next thing that happens is a trust
    // dialog the user has to answer, and without this the only signal is
    // the dialog itself.
    log.attention.warn(
      `claude trust did not stick for ${lost.length} of ${wanted.length} worktree(s) — expect the trust dialog on ${lost
        .map((p) => p.split("/").pop())
        .join(", ")}`,
    );
  } catch (err) {
    log.warn("could not set claude workspace trust", {
      wtPath,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
