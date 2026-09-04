/**
 * Which harness a message aimed at a worktree should go to.
 *
 * `readPrimaryHarness` answers a different question than it looks like
 * it answers. It is one repository-level setting — `<cacheRoot>/harness.json`
 * with `[harness].primary` as its fallback,
 * cycled by Shift+Tab in the TUI — so it says "what F12 would spawn
 * next", not "what is working on this branch". Routing `wt agent send`
 * through it meant a worktree whose Codex session wt had itself
 * launched minutes earlier received nothing: three fleet messages went
 * to a Claude session that `send` cold-started for the occasion, and
 * were lost when that session was closed. `send` cold-starts, so the
 * failure CREATES a plausible-looking session rather than erroring,
 * and every send reported success.
 *
 * The TUI has always resolved this correctly — `f12Target` prefers a
 * live session and falls back to the primary. This is that rule for
 * callers with no React around them.
 *
 * The answer is three-valued on purpose. `probeSessionNames` returns
 * null when tmux could not be asked (spawn refused, socket
 * unreachable) as opposed to "no server running", and an unanswerable
 * question must not read as "nothing is live" — that is precisely the
 * mistake that routes a message to a fresh session while the real one
 * is sitting there.
 */
import { probeSessionNames } from "../tmux/process.ts";
import { Effect } from "effect";
import { CLAUDE_NAMED_SEP, sessionName, type SessionKind } from "../tmux/naming.ts";

import { readPrimaryHarness } from "./primary.ts";
import { VISIBLE_HARNESSES } from "./registry.ts";
import type { HarnessId } from "./types.ts";

export type HarnessChoice = {
  harnessId: HarnessId;
  /**
   * How it was chosen. Callers print this: "delivered to the Codex
   * session" is falsifiable from the caller side where "delivered to
   * the configured primary agent" is not, and that unfalsifiability is
   * what let three misrouted sends look identical to three good ones.
   */
  source: "live" | "primary" | "primary-unknown";
};


/**
 * Harnesses with a live tmux session for `slug`, in registry order.
 *
 * `knownSlugs` guards the one ambiguity in the naming scheme: a
 * harness session is `<slug>-codex`, but a worktree literally named
 * `foo-codex` has a CLAUDE session called `foo-codex`. Without the
 * guard, slug `foo` would read its neighbour's session as its own
 * Codex — the same strict-prefix trap that has bitten the destroy
 * filters and the log tailer. Claude's own named sessions are matched
 * on `<slug>~`, which is safe unguarded because `~` cannot occur in a
 * slug.
 */
function liveHarnesses(
  slug: string,
  names: ReadonlySet<string>,
  knownSlugs: ReadonlySet<string>,
): HarnessId[] {
  const out: HarnessId[] = [];
  for (const h of VISIBLE_HARNESSES) {
    const primaryName = sessionName(slug, h.id as SessionKind);
    // A name that IS another worktree's slug belongs to that worktree's
    // primary claude session, never to this slug's harness.
    const ownsName = primaryName === slug || !knownSlugs.has(primaryName);
    if (ownsName && names.has(primaryName)) {
      out.push(h.id);
      continue;
    }
    if (h.id === "claude") {
      const prefix = `${slug}${CLAUDE_NAMED_SEP}`;
      for (const n of names) {
        if (n.startsWith(prefix)) {
          out.push(h.id);
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Resolve the harness to address for `slug`.
 *
 * Prefers a live session; among several, prefers the primary, because
 * that is the one the human's own F12 would land on. Falls back to the
 * primary setting when nothing is live — which is the right answer
 * there, since `send` is about to cold-start something and the primary
 * is exactly "what to start".
 */
export function resolveWorktreeHarness(
  slug: string,
  knownSlugs: ReadonlySet<string>,
): Effect.Effect<HarnessChoice> {
  // The probe is three-valued and never fails (an unreachable tmux reads
  // as "no sessions known"), so there is no error channel to wrap.
  return probeSessionNames().pipe(
    Effect.map((names) => chooseHarness(slug, names, knownSlugs, readPrimaryHarness())),
  );
}

/** The rule itself, with the tmux probe already done — the tested half. */
export function chooseHarness(
  slug: string,
  names: ReadonlySet<string> | null,
  knownSlugs: ReadonlySet<string>,
  primary: HarnessId,
): HarnessChoice {
  if (names === null) return { harnessId: primary, source: "primary-unknown" };
  const live = liveHarnesses(slug, names, knownSlugs);
  if (live.length === 0) return { harnessId: primary, source: "primary" };
  if (live.includes(primary)) return { harnessId: primary, source: "live" };
  return { harnessId: live[0]!, source: "live" };
}
