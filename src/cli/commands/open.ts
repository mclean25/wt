import { Data, Effect } from "effect";

import { listWorktrees } from "../../core/worktree.ts";
import { hasHelpFlag } from "../args.ts";
import { red, yellow } from "../colors.ts";
import { isInteractive, pickIndexEffect, type PromptError } from "../prompt.ts";
import { openInEditor } from "../../core/editor.ts";

const USAGE = `usage: wt open [<slug-or-query>]

Open a worktree in your editor ([editor] command; default is Zed).
Exact slug or case-insensitive substring; no query ⇒ interactive picker.`;

export class OpenCommandError extends Data.TaggedError("OpenCommandError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

function commandPromise<A>(
  operation: string,
  f: () => Promise<A>,
): Effect.Effect<A, OpenCommandError> {
  return Effect.tryPromise({
    try: f,
    catch: (cause) => new OpenCommandError({ operation, cause }),
  });
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function run(
  argv: string[],
): Effect.Effect<number, OpenCommandError | PromptError> {
  return Effect.gen(function* () {
    if (hasHelpFlag(argv)) {
      console.log(USAGE);
      return 0;
    }
    const query = argv.find((a) => !a.startsWith("-")) ?? null;
    const wts = (yield* commandPromise("list worktrees", listWorktrees)).filter(
      (w) => !w.isMain,
    );
    if (wts.length === 0) {
      console.log(yellow("No worktrees."));
      return 1;
    }
    let target = query
      ? (wts.find((w) => w.slug === query) ??
        wts.find((w) => w.slug.toLowerCase().includes(query.toLowerCase())))
      : undefined;
    if (!target && !query) {
      if (!isInteractive()) {
        console.error(red("A slug is required in non-interactive mode."));
        return 2;
      }
      const idx = yield* pickIndexEffect(
        wts.map((w) => w.slug),
        "Open which worktree?",
      );
      if (idx === null) return 0;
      target = wts[idx];
    }
    if (!target) {
      console.error(red(`No worktree matching: ${query}`));
      return 1;
    }
    const opened = yield* Effect.result(
      commandPromise("open editor", () => openInEditor(target.path)),
    );
    if (opened._tag === "Failure") {
      console.error(red(causeMessage(opened.failure.cause)));
      return 1;
    }
    return 0;
  });
}
