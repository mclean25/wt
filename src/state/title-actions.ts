import type { QueryClient } from "@tanstack/react-query";
import { Data, Effect } from "effect";

import type { AiSummary } from "../core/ai.ts";
import { config } from "../core/config.ts";
import type { DiffContext } from "../core/diff/index.ts";
import { operationErrors } from "../core/errors.ts";
import { readWtState, setSlugManualTitle } from "../core/wtstate.ts";
import { qk } from "./keys.ts";
import { aiSummaryQuery, wtDiffContextQuery } from "./queries/ai.ts";
import { worktreesQuery } from "./queries/worktree.ts";

const io = operationErrors("worktree title");

export class TitleEditSuperseded extends Data.TaggedError("TitleEditSuperseded")<{}> {
  override get message(): string {
    return "Title changed while generation was running; kept the newer title";
  }
}

export class MissingGeneratedTitle extends Data.TaggedError("MissingGeneratedTitle")<{}> {
  override get message(): string {
    return "Naming model returned no title; kept the current title";
  }
}

/** Explicit generation must work without an enabled observer or a warm cache. */
export const generateAndSaveTitle = Effect.fn("generateAndSaveTitle")(function* (input: {
  readonly context: Effect.Effect<DiffContext | null, Error>;
  readonly generate: (context: DiffContext) => Effect.Effect<AiSummary, Error>;
  readonly save: (title: string) => Effect.Effect<boolean, Error>;
}) {
  const context = yield* input.context;
  if (!context) return false;
  const summary = yield* input.generate(context);
  if (!summary.title?.trim()) return yield* new MissingGeneratedTitle();
  if (!(yield* input.save(summary.title))) return yield* new TitleEditSuperseded();
  return true;
});

export const regenerateWorktreeTitle = Effect.fn("regenerateWorktreeTitle")(function* (
  qc: QueryClient,
  slug: string,
) {
  // Capture intent before any async inventory/diff/model work. An edit during
  // those preparatory reads is just as authoritative as one during generation.
  const state = yield* io.sync("read title", () => readWtState().slugs[slug]);
  const revision = state?.manualTitleRevision ?? 0;
  const worktrees = yield* io.promise("read inventory", () => qc.fetchQuery(worktreesQuery()));
  const wt = worktrees.find((entry) => entry.slug === slug && !entry.isMain);
  if (!wt) return false;
  const base = state?.baseBranch && state.baseBranch !== config.branch.base && state.baseBranch !== wt.branch
    ? state.baseBranch : null;
  const diffOptions = wtDiffContextQuery(wt, base);
  // fetchQuery runs even with every observer disabled. staleTime: 0 forces an
  // explicit request for this action, while retaining the previous cache data.
  // Bypass disk restoration, but persist the new result. Cancel the exact
  // in-flight fetch first: TanStack otherwise joins it before reading options.
  return yield* generateAndSaveTitle({
    context: io.promise("cancel previous diff read", () => qc.cancelQueries({
      queryKey: diffOptions.queryKey, exact: true,
    })).pipe(Effect.andThen(io.promise("read diff", () => qc.fetchQuery({
      ...diffOptions, staleTime: 0, meta: { forceFresh: true },
    })))),
    generate: (context) => io.promise("cancel previous title generation", () => qc.cancelQueries({
      queryKey: qk.aiSummary(context.hash), exact: true,
    })).pipe(Effect.andThen(io.promise("generate title", () => qc.fetchQuery({
      ...aiSummaryQuery(slug, context), staleTime: 0, meta: { forceFresh: true },
    })))),
    save: (title) => state?.manualTitle
      ? setSlugManualTitle(slug, title, { expectedRevision: revision })
      : io.sync("check title revision", () =>
        (readWtState().slugs[slug]?.manualTitleRevision ?? 0) === revision,
      ),
  }).pipe(Effect.tap(() =>
    io.promise("refresh saved title", () => qc.invalidateQueries({ queryKey: qk.wtState() })),
  ));
});
