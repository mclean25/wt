/**
 * Tracker-id flow (`#`): attach a tracker issue to the selected
 * worktree by hand, or clear one.
 *
 * The id is normally PARSED from the slug (`coz-2185-sick-lamprey` →
 * COZ-2185) and needs nothing stored. This exists for the population
 * that parse cannot serve — a worktree named for the work rather than
 * the ticket, or one whose ticket was filed after the branch — which
 * is not a rare corner: 0 of 6 live rows carried a slug id on
 * 2026-08-21, and every one of them silently skipped the tracker
 * automation because `{{issue_id}}` rendered empty.
 *
 * What it writes is an OVERRIDE, never a cache of the parse: readers
 * go through `resolveIssueId`, which prefers the stored value and
 * falls back to the slug.
 *
 * Three states, because two could not say everything. Absent means
 * "use the slug"; a value means "use this"; and the EMPTY string means
 * "this worktree has no ticket" — which the prompt writes when you
 * clear the field. Without that third state the prompt was a no-op on
 * precisely the rows you would want to detach: a slug carrying an id
 * re-supplied it the moment the override went away. `wt issue <slug>
 * --clear-id` is the way back to the derived answer.
 */
import { ISSUE_ID_RE, resolveIssueId } from "../../core/issue-tracker.ts";
import type { WorktreeRow } from "../hooks/useWorktreeRows.ts";
import type { FooterMode } from "../panels/footer.tsx";
import { makeEdit } from "../text-edit.tsx";
import { theme } from "../theme.ts";
import { Data, Effect } from "effect";

class IssueIdFlowError extends Data.TaggedError("IssueIdFlowError")<{
  cause: unknown;
}> {}

export type IssueIdFlowCtx = {
  current: WorktreeRow | undefined;
  setFooter: (f: FooterMode) => void;
  setPendingIssueSlug: (v: string | null) => void;
  setIssueId: (slug: string, id: string | null) => Promise<void>;
  isSlugLive: (slug: string) => boolean;
  toast: (message: string, color?: string, ms?: number) => void;
};

export function useIssueIdFlow(ctx: IssueIdFlowCtx) {
  const {
    current,
    setFooter,
    setPendingIssueSlug,
    setIssueId,
    isSlugLive,
    toast,
  } = ctx;

  /** Open the footer prompt, seeded with whatever the row resolves to today. */
  function openIssueIdPrompt(): void {
    if (!current) return;
    const slug = current.wt.slug;
    // Seeded with the CURRENT answer whatever its source, so editing a
    // slug-derived id is one keystroke rather than retyping it, and the
    // prompt doubles as "what does this row think it is".
    const seed = resolveIssueId(slug, current.issueId) ?? "";
    setPendingIssueSlug(slug);
    setFooter({
      kind: "input",
      prompt: `tracker id for ${slug} (empty = no issue):`,
      edit: makeEdit(seed),
      purpose: "issue-id",
    });
  }

  /** Footer-input Enter. Empty clears; anything else must look like an id. */
  function commitIssueId(slug: string, raw: string): void {
    // Human-paced typing, so the row can be gone by now — the same
    // ghost-entry guard the status flow takes, and for the same reason.
    if (!isSlugLive(slug)) {
      toast(`${slug} is gone — tracker id not written`, theme.warn, 2500);
      return;
    }
    const trimmed = raw.trim();
    if (trimmed === "") {
      // Emptying a field that was SEEDED with the current answer means
      // "this row has no ticket" — so it writes the asserted none
      // rather than dropping the override. Falling back to the slug
      // here was the old behaviour and it made the prompt a no-op on
      // exactly the rows whose id you would want to remove: the ones
      // carrying it in the slug. `wt issue <slug> --clear-id` is the
      // way back to the derived value.
      Effect.runFork(
        Effect.tryPromise({
          try: () => setIssueId(slug, ""),
          catch: (cause) => new IssueIdFlowError({ cause }),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              const parsed = resolveIssueId(slug, null);
              toast(
                parsed
                  ? `${slug} has no tracker id (was ${parsed} from slug)`
                  : `${slug} has no tracker id`,
                theme.info,
                2500,
              );
            }),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              const message =
                error.cause instanceof Error
                  ? error.cause.message
                  : String(error.cause);
              toast(`clear issue id failed: ${message}`, theme.err, 3000);
            }),
          ),
        ),
      );
      return;
    }
    const id = trimmed.toUpperCase();
    // Validated at the boundary so the store holds one shape and
    // `{{issue_id}}` cannot render a typo into someone else's tracker.
    if (!ISSUE_ID_RE.test(id)) {
      toast(
        `"${trimmed}" is not an issue id (expected e.g. COZ-2185)`,
        theme.err,
        3000,
      );
      return;
    }
    Effect.runFork(
      Effect.tryPromise({
        try: () => setIssueId(slug, id),
        catch: (cause) => new IssueIdFlowError({ cause }),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => toast(`${slug} → ${id}`, theme.info, 2000)),
        ),
        Effect.catch((error) =>
          Effect.sync(() => {
            const message =
              error.cause instanceof Error
                ? error.cause.message
                : String(error.cause);
            toast(`set issue id failed: ${message}`, theme.err, 3000);
          }),
        ),
      ),
    );
  }

  return { openIssueIdPrompt, commitIssueId };
}
