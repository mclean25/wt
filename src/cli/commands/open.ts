import { Effect } from "effect";

import { openInEditor } from "../../core/editor.ts";
import { causeMessage } from "../../core/errors.ts";
import { listWorktrees } from "../../core/worktree.ts";
import { hasHelpFlag } from "../args.ts";
import { red, yellow } from "../colors.ts";
import { isInteractive, pickIndex } from "../prompt.ts";

const USAGE = `usage: wt open [<slug-or-query>]

Open a worktree in your editor ([editor] command; default is Zed).
Exact slug or case-insensitive substring; no query ⇒ interactive picker.`;

export const run = Effect.fn("wt open")(function* (argv: string[]) {
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return 0;
  }
  const query = argv.find((a) => !a.startsWith("-")) ?? null;
  const wts = (yield* listWorktrees()).filter((w) => !w.isMain);
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
    const idx = yield* pickIndex(
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
  const opened = yield* Effect.result(openInEditor(target.path));
  if (opened._tag === "Failure") {
    console.error(red(causeMessage(opened.failure.cause)));
    return 1;
  }
  return 0;
});
