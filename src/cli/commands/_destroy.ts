import { Effect } from "effect";

import { removeWorktree } from "../../core/lifecycle.ts";
import { killAllSessionsFor } from "../../core/tmux.ts";
import { listWorktrees } from "../../core/worktree.ts";

type Parsed = {
  slug: string;
  force: boolean;
  destroyStage: boolean;
  deleteBranch: boolean;
};

function boolArg(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.toLowerCase();
  return s === "true" || s === "1" || s === "yes";
}

function parse(argv: string[]): Parsed | { error: string } {
  let slug: string | undefined;
  let force = false;
  let destroyStage = false;
  let deleteBranch = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--force") force = boolArg(argv[++i]);
    else if (a === "--destroy-stage") destroyStage = boolArg(argv[++i]);
    else if (a === "--delete-branch") deleteBranch = boolArg(argv[++i]);
    else if (!slug) slug = a;
    else return { error: `unexpected arg: ${a}` };
  }
  if (!slug) return { error: "missing slug" };
  return { slug, force, destroyStage, deleteBranch };
}

/**
 * Background destroy entry point. The parent (`spawnBackgroundRemove`)
 * redirects our stdout+stderr to the log file at spawn time, so every
 * `console.log` here — and every grandchild's output — lands in the log
 * automatically. No monkey-patching.
 */
export const run = Effect.fn("wt _destroy")(function* (argv: string[]) {
  const parsed = parse(argv);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 2;
  }

  const wt = (yield* listWorktrees()).find((w) => w.slug === parsed.slug);
  if (!wt) {
    console.error(`No worktree: ${parsed.slug}`);
    return 1;
  }
  console.log(
    `[bg destroy] slug=${parsed.slug} force=${parsed.force} ` +
      `stage=${parsed.destroyStage} branch=${parsed.deleteBranch}`,
  );
  const result = yield* removeWorktree(wt, {
    force: parsed.force,
    destroyStage: parsed.destroyStage,
    deleteBranch: parsed.deleteBranch,
    onLog: (line) => console.log(line),
    onPhase: (phase) => console.log(`· ${phase}`),
  }).pipe(
    // A refused remove (busy lock, guard tripped, ...) is a reported
    // outcome here, not a command failure — fold it into the same
    // ok:false shape a "removeWorktreeProgram said no" result has, so
    // one branch below handles both.
    Effect.catchTag("LifecycleError", (error) =>
      Effect.succeed({
        ok: false as const,
        message: error.message,
        destroyedStage: false,
        deletedBranch: false,
      }),
    ),
  );
  if (!result.ok) {
    console.error(`failed: ${result.message}`);
    return 1;
  }
  yield* killAllSessionsFor(wt.slug);
  console.log(`✓ ${result.message}`);
  if (result.destroyedStage) console.log(`✓ destroyed stage ${wt.stage}`);
  if (result.deletedBranch) console.log(`✓ deleted branch ${wt.branch}`);
  return 0;
});
