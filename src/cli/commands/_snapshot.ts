import { config } from "../../core/config.ts";
import { collectWorkerSnapshot } from "../../core/worktree-snapshot.ts";
import { Data, Effect } from "effect";

export class SnapshotCommandError extends Data.TaggedError(
  "SnapshotCommandError",
)<{
  cause: unknown;
}> {}

/** Versioned machine contract consumed by a controller over SSH. */
export function run(
  argv: string[],
): Effect.Effect<number, SnapshotCommandError> {
  return Effect.gen(function* () {
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
    const snapshot = yield* Effect.tryPromise({
      try: () => collectWorkerSnapshot(),
      catch: (cause) => new SnapshotCommandError({ cause }),
    });
    console.log(JSON.stringify(snapshot));
    return 0;
  });
}
