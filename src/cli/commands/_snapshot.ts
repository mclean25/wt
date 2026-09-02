import { config } from "../../core/config.ts";
import { collectWorkerSnapshot, type WorktreeSnapshotError } from "../../core/worktree-snapshot.ts";
import { Effect } from "effect";

/** Versioned machine contract consumed by a controller over SSH. */
export const run = Effect.fn("wt _snapshot")(function* (
  argv: string[],
): Effect.fn.Return<number, WorktreeSnapshotError> {
  if (argv.length > 0) {
    console.error("usage: wt _snapshot");
    return 2;
  }
  if (config.instance.role !== "worker") {
    console.error(
      'worker snapshot requires [instance] role = "worker" on this host',
    );
    return 1;
  }
  const snapshot = yield* collectWorkerSnapshot();
  console.log(JSON.stringify(snapshot));
  return 0;
});
