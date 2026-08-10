import { createLogger } from "../logger.ts";
import { readWtState, withWtStateLock, writeWtState } from "./io.ts";
import type { RemovedWorktree } from "./types.ts";

/** Bounds on the removed-worktrees history, enforced at write time. */
const REMOVED_MAX_ENTRIES = 30;
const REMOVED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Window within which a destroyed worktree still shows on fleet
 * surfaces (`wt ls`, `wt status --all --json`, the empty-state
 * messages) as "recently merged/archived". Long enough that a manager
 * scanning once a day still sees what landed; short enough that the
 * section stays news, not history (`h` keeps the full 14-day record).
 */
export const RECENT_REMOVED_WINDOW_MS = 48 * 60 * 60 * 1000;

/** True when the removed entry's PR snapshot says the branch landed. */
export function isMergedRemoval(e: RemovedWorktree): boolean {
  return e.prState === "MERGED";
}

/**
 * Removed-history entries inside the recent window whose slug isn't
 * live again, newest first. This is the derivation fleet surfaces use
 * to distinguish "everything merged" from "no worktrees exist" — no
 * new store, just a view over the existing removed history.
 */
export function recentlyRemovedWorktrees(
  liveSlugs: ReadonlySet<string>,
  nowMs: number = Date.now(),
): RemovedWorktree[] {
  const cutoff = nowMs - RECENT_REMOVED_WINDOW_MS;
  return readWtState()
    .removed.filter(
      (e) => !liveSlugs.has(e.slug) && (Date.parse(e.removedAt) || 0) >= cutoff,
    )
    .sort((a, b) => b.removedAt.localeCompare(a.removedAt));
}

/**
 * One-line summary of recent removals for empty states ("2 archived
 * today: eng-1, eng-2"). Null when there's nothing recent — callers
 * fall back to their plain empty message.
 */
export function recentRemovalsSummary(
  entries: readonly RemovedWorktree[],
  nowMs: number = Date.now(),
): string | null {
  if (entries.length === 0) return null;
  const dayCutoff = nowMs - 24 * 60 * 60 * 1000;
  const today = entries.every((e) => (Date.parse(e.removedAt) || 0) >= dayCutoff);
  const named = entries.slice(0, 4).map((e) => e.slug);
  const more = entries.length - named.length;
  const list = named.join(", ") + (more > 0 ? `, +${more} more` : "");
  return `${entries.length} archived ${today ? "today" : "in the last 2 days"}: ${list}`;
}

/**
 * Record destroyed worktrees into the removed history. Upserts by slug:
 * defined fields of the incoming entry win, existing rich fields (title,
 * PR snapshot) survive a later minimal write — so the TUI's dispatch-time
 * snapshot and `removeWorktree`'s on-success confirmation compose in
 * either order. Prunes by age and caps the list, newest first.
 */
export function recordRemovedWorktrees(
  entries: readonly RemovedWorktree[],
): void {
  if (entries.length === 0) return;
  withWtStateLock(() => {
    const state = readWtState();
    const bySlug = new Map(state.removed.map((e) => [e.slug, e]));
    for (const e of entries) {
      const prev = bySlug.get(e.slug);
      bySlug.set(e.slug, {
        ...prev,
        slug: e.slug,
        branch: e.branch,
        removedAt: e.removedAt,
        ...(e.title !== undefined ? { title: e.title } : {}),
        ...(e.prNumber !== undefined ? { prNumber: e.prNumber } : {}),
        ...(e.prUrl !== undefined ? { prUrl: e.prUrl } : {}),
        ...(e.prState !== undefined ? { prState: e.prState } : {}),
      });
    }
    const cutoff = Date.now() - REMOVED_MAX_AGE_MS;
    const removed = [...bySlug.values()]
      .filter((e) => (Date.parse(e.removedAt) || 0) >= cutoff)
      .sort((a, b) => b.removedAt.localeCompare(a.removedAt))
      .slice(0, REMOVED_MAX_ENTRIES);
    writeWtState({ ...state, removed });
  });
  // A merged worktree leaving the active list is the "this task fully
  // landed" moment — attention-worthy (and it toasts by default per the
  // logger contract). Only the rich dispatch-time snapshot carries
  // `prState`, so the later minimal confirm from `removeWorktree` never
  // re-emits; non-merged removals stay on the event feed, where the
  // destroy flows already narrate them.
  for (const e of entries) {
    if (!isMergedRemoval(e)) continue;
    const pr = e.prNumber !== undefined ? ` (#${e.prNumber})` : "";
    // Source carries the slug (feed convention) — don't repeat it in
    // the text.
    createLogger(e.slug).attention.ok(`merged${pr} — worktree archived`);
  }
}

/**
 * Drop a slug from the removed history. Called by `createWorktree` so a
 * restored / re-created slug stops appearing as removed. No-op when absent.
 */
export function clearRemovedWorktree(slug: string): void {
  withWtStateLock(() => {
    const state = readWtState();
    if (!state.removed.some((e) => e.slug === slug)) return;
    writeWtState({
      ...state,
      removed: state.removed.filter((e) => e.slug !== slug),
    });
  });
}

/**
 * The recently-removed JSON shape shared by `wt ls --json` and
 * `wt status --all --json`. `kind` (not `state`) discriminates these
 * from live rows: status --all's live rows already use `state` for the
 * WORK-state vocabulary, and overloading one key with two value
 * domains silently broke consumers filtering on it.
 */
export function removedJsonEntry(e: RemovedWorktree): {
  slug: string;
  branch: string;
  kind: "merged" | "removed";
  pr: number | null;
  pr_url: string | null;
  title: string | null;
  archived_at: string;
} {
  return {
    slug: e.slug,
    branch: e.branch,
    kind: isMergedRemoval(e) ? "merged" : "removed",
    pr: e.prNumber ?? null,
    pr_url: e.prUrl ?? null,
    title: e.title ?? null,
    archived_at: e.removedAt,
  };
}
