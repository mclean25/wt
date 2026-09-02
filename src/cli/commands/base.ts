import { config } from "../../core/config.ts";
import { Effect } from "effect";
import { gitRun, revParse } from "../../core/git.ts";
import { operationErrors } from "../../core/errors.ts";
import { readWtState, setSlugBase } from "../../core/wtstate.ts";
import { listWorktrees } from "../../core/worktree.ts";
import type { Worktree } from "../../core/types.ts";
import { hasHelpFlag } from "../args.ts";
import { dim, green, red, yellow } from "../colors.ts";

const USAGE = `usage: wt base <slug>                show the recorded fork base
       wt base set <slug> <ref>     record <ref> as the fork base
       wt base clear <slug>         forget the recorded fork base

The fork base is what \`wt new --base <ref>\` records: the branch a
worktree is based on. It is THE stack primitive — worktrees whose
records chain into each other render as a stack, diff against their
parent, and replay onto it on \`wt restack\`. \`set\` exists for
backfill — worktrees created before recording existed, or whose base
changed by hand.`;

const io = operationErrors("wt base");

function findWorktree(slug: string) {
  return listWorktrees().pipe(
    Effect.map(
      (wts) => wts.filter((w) => !w.isMain).find((w) => w.slug === slug) ?? null,
    ),
  );
}

const show = Effect.fn("wt base show")(function* (slug: string) {
  const entry = (yield* io.sync("read wt state", readWtState)).slugs[slug];
  if (!entry?.baseBranch) {
    console.log(
      dim(
        `${slug}: no recorded fork base (diffs against ${config.branch.base})`,
      ),
    );
    return 0;
  }
  console.log(
    `${slug}: ${entry.baseBranch}${entry.baseSha ? dim(` @ ${entry.baseSha.slice(0, 12)}`) : ""}`,
  );
  return 0;
});

const set = Effect.fn("wt base set")(function* (slug: string, ref: string) {
  const wt: Worktree | null = yield* findWorktree(slug);
  if (!wt) {
    console.error(red(`no worktree: ${slug}`));
    return 1;
  }
  const branch = ref.replace(/^origin\//, "");
  if (branch === config.branch.base) {
    console.error(
      red(
        `${branch} is trunk — that's the default; use \`wt base clear\` instead`,
      ),
    );
    return 2;
  }
  if (branch === wt.branch) {
    console.error(
      red(
        `${branch} is ${slug}'s own branch — a worktree can't be based on itself`,
      ),
    );
    return 2;
  }
  const localRef = yield* revParse(ref);
  const remoteRef = localRef ? localRef : yield* revParse(`origin/${branch}`);
  if (!remoteRef) {
    console.error(red(`ref does not resolve: ${ref}`));
    return 1;
  }
  // Anchor at the fork point, not the base's current tip — the base may
  // have advanced since the fork. Best-effort; the branch name alone is
  // enough for display/diff.
  const mb = yield* gitRun(["merge-base", wt.branch, ref], wt.path);
  const sha = mb.exitCode === 0 ? mb.stdout.trim() : "";
  yield* io.sync("set fork base", () => setSlugBase(slug, { branch, sha: sha || undefined }));
  console.log(
    green(
      `✓ ${slug} base → ${branch}${sha ? dim(` @ ${sha.slice(0, 12)}`) : ""}`,
    ),
  );
  console.log(
    dim(
      "restart wt (or wait for the next state refresh) to see it in the TUI",
    ),
  );
  return 0;
});

const clear = Effect.fn("wt base clear")(function* (slug: string) {
  const entry = (yield* io.sync("read wt state", readWtState)).slugs[slug];
  if (!entry?.baseBranch) {
    console.log(yellow(`${slug}: nothing recorded`));
    return 0;
  }
  yield* io.sync("clear fork base", () => setSlugBase(slug, null));
  console.log(
    green(`✓ cleared — ${slug} diffs against ${config.branch.base} again`),
  );
  return 0;
});

export const run = Effect.fn("wt base")(function* (argv: string[]) {
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return 0;
  }
  const [first, ...rest] = argv;
  if (!first) {
    console.log(USAGE);
    return 2;
  }
  if (first === "set") {
    const [slug, ref] = rest;
    if (!slug || !ref || rest.length !== 2) {
      console.error(red(USAGE));
      return 2;
    }
    return yield* set(slug, ref);
  }
  if (first === "clear") {
    const [slug] = rest;
    if (!slug || rest.length !== 1) {
      console.error(red(USAGE));
      return 2;
    }
    return yield* clear(slug);
  }
  if (rest.length > 0) {
    console.error(red(USAGE));
    return 2;
  }
  return yield* show(first);
});
