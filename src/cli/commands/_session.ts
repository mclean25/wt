import { Data, Effect } from "effect";

import { effectiveBaseOrTrunkEffect } from "../../core/git.ts";
import { HARNESSES, type HarnessId } from "../../core/harness/index.ts";
import { attachOrCreate, type SessionShortcut } from "../../core/tmux.ts";
import { listWorktreesEffect } from "../../core/worktree.ts";
import { readWtState } from "../../core/wtstate.ts";

const TARGETS = new Set<SessionShortcut>(["shell", "diff", "harness"]);

/**
 * Interactive entrypoint used over SSH for one remote worktree. The Mac owns
 * the wt UI; this command owns only the selected row's remote tmux client.
 */
class SessionAttachError extends Data.TaggedError("SessionAttachError")<{
  readonly cause: unknown;
}> {}

export function run(argv: string[]): Effect.Effect<number, SessionAttachError> {
  return Effect.gen(function* () {
    const [slug, rawTarget, rawHarness] = argv;
    if (!slug || !rawTarget || argv.length > 3 || !TARGETS.has(rawTarget as SessionShortcut)) {
      console.error("usage: wt _session <slug> <shell|diff|harness> [harness]");
      return 2;
    }
    const harnessId = (rawHarness ?? "codex") as HarnessId;
    if (!HARNESSES.some((h) => h.id === harnessId)) {
      console.error(`unknown harness: ${rawHarness}`);
      return 2;
    }
    const worktree = (yield* listWorktreesEffect()).find((wt) => !wt.isMain && wt.slug === slug);
    if (!worktree) {
      console.error(`remote worktree not found: ${slug}`);
      return 1;
    }
    const recordedBase = readWtState().slugs[slug]?.baseBranch;
    const diffBase = yield* effectiveBaseOrTrunkEffect(worktree.path, recordedBase);

    let target = rawTarget as SessionShortcut;
    for (;;) {
      const kind = target === "harness" ? harnessId : target;
      const result = yield* Effect.tryPromise({
        try: () => attachOrCreate({ slug, cwd: worktree.path, kind, base: diffBase }),
        catch: (cause) => new SessionAttachError({ cause }),
      });
      if (result.kind === "switch") {
        target = result.target;
        continue;
      }
      if (result.kind === "spawn-failed") {
        console.error(result.reason);
        return 1;
      }
      if (result.kind === "exited" && result.stderr) console.error(result.stderr);
      return 0;
    }
  }).pipe(Effect.mapError((cause) => new SessionAttachError({ cause })));
}
