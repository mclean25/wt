/**
 * Turns new PR comments from OTHER people into attention-feed lines.
 *
 * Someone commenting on your PR is a "look at me" event with no local
 * signal behind it: nothing in git moves, so no badge flips and the
 * comment lives only in the details pane, one keystroke away from never
 * being read. This diffs the comment list the github source already
 * fetches — bots are filtered upstream in `core/github/parse.ts`, the
 * authenticated user is filtered here — and narrates anything newer
 * than the per-slug mark.
 *
 * Seeding is silent, like `useWtStateEvents`: the first observation
 * is history, not news. Because the github query hydrates from the
 * persisted cache before the live fetch lands, that history is what was
 * on screen last session — so a comment that arrived while wt was down
 * is newer than the seed and still narrates. (First run on a cold cache
 * seeds whatever exists; nothing to be done about that, and it's one
 * quiet startup rather than a wall of replayed conversation.)
 *
 * Inline review-thread comments are deliberately NOT covered: the
 * batched fetch pulls only each thread's opening author (for the
 * unresolved counts), and widening that block multiplies the payload of
 * every fetch for every worktree. The details pane's unresolved-threads
 * count carries them today; worth revisiting if inline review becomes
 * the norm on a repo.
 */
import { useEffect, useRef, useState } from "react";
import { Effect } from "effect";

import { fetchAuthenticatedLogin } from "../../core/github.ts";
import { createLogger } from "../../core/logger.ts";
import type { PrComment } from "../../core/types.ts";
import type { GithubData } from "../../state/queries/github.ts";
import { useEffectFiber } from "./useEffectFiber.ts";
import type { WorktreeRow } from "./useWorktreeRows.ts";

/** Body text kept on a feed line before ellipsis. */
const BODY_CHARS = 100;

/**
 * Above this many new comments at once, the feed gets one summary line
 * instead of a wall. Only reachable after a long gap (a batch landed
 * while wt was down); the normal case is one comment.
 */
const MAX_INDIVIDUAL_LINES = 3;

/** Markdown/newlines collapsed to one scannable line. */
function flatten(body: string): string {
  const s = body.replace(/\s+/g, " ").trim();
  return s.length > BODY_CHARS ? `${s.slice(0, BODY_CHARS - 1)}…` : s;
}

/**
 * Comments authored by someone else after `mark`, oldest-first so the
 * feed reads in conversation order. An empty `mark` (seeded when the PR
 * had no comments yet) is below every ISO timestamp, so the first
 * comment to land counts as new.
 */
export function newCommentsSince(
  comments: readonly PrComment[],
  mark: string,
  me: string,
): PrComment[] {
  return comments
    .filter((c) => c.author !== me && c.createdAt > mark)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

/** The newest comment that isn't yours — the mark this pass leaves behind. */
export function latestForeignAt(comments: readonly PrComment[], me: string): string {
  let latest = "";
  for (const c of comments) {
    if (c.author !== me) if (c.createdAt > latest) latest = c.createdAt;
  }
  return latest;
}

/** Feed text for one pass's new comments. Empty when there are none. */
export function commentLines(fresh: readonly PrComment[]): string[] {
  if (fresh.length === 0) return [];
  if (fresh.length > MAX_INDIVIDUAL_LINES) {
    const who = [...new Set(fresh.map((c) => c.author))].join(", ");
    return [`${fresh.length} new PR comments (${who})`];
  }
  return fresh.map((c) => `${c.author} commented: ${flatten(c.body)}`);
}

export function usePrCommentEvents(
  rows: readonly WorktreeRow[],
  githubData: GithubData | undefined,
): void {
  // Read inside the effect so a row-array identity change doesn't
  // re-run the diff; the github data landing is the real trigger.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // slug → newest foreign comment already accounted for. Absent = not
  // yet seeded for that slug.
  const seenRef = useRef(new Map<string, string>());
  // Your own login. Null until resolved; the diff can't run without it
  // (every `/codex-review` you type would read as news).
  const [me, setMe] = useState<string | null>(null);

  useEffectFiber(() => {
    if (me !== null || !githubData) return null;
    // Retried on each github pass while unresolved: the source memoizes
    // only successes, so a probe that ran before `gh` was usable
    // resolves on a later one.
    return fetchAuthenticatedLogin().pipe(
      Effect.tap((login) =>
        login ? Effect.sync(() => setMe(login)) : Effect.void,
      ),
    );
  }, [me, githubData]);

  useEffect(() => {
    if (!githubData || me === null) return;
    const seen = seenRef.current;
    for (const row of rowsRef.current) {
      if (row.archived || !row.pr) continue;
      const comments = row.pr.comments;
      const slug = row.wt.slug;
      const mark = seen.get(slug);
      if (mark === undefined) {
        seen.set(slug, latestForeignAt(comments, me));
        continue;
      }
      const fresh = newCommentsSince(comments, mark, me);
      if (fresh.length === 0) continue;
      seen.set(slug, fresh[fresh.length - 1]!.createdAt);
      const log = createLogger(slug);
      for (const line of commentLines(fresh)) log.attention.info(line);
    }
  }, [githubData, me]);
}
