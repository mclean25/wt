import { Data, Effect } from "effect";

import { decodeRemoteArgs } from "../../core/remote-protocol.ts";

class RemoteCommandError extends Data.TaggedError("RemoteCommandError")<{
  readonly operation: "load config" | "load dispatcher";
  readonly cause: unknown;
}> {}

/** Decode SSH-safe argv and re-enter the normal CLI dispatcher remotely. */
export function run(argv: string[]): Effect.Effect<number, Error> {
  if (argv.length !== 1) {
    return Effect.sync(() => {
      console.error("usage: wt _remote <encoded-argv>");
      return 2;
    });
  }
  let decoded: string[];
  try {
    decoded = decodeRemoteArgs(argv[0]!);
  } catch (err) {
    return Effect.sync(() => {
      console.error(err instanceof Error ? err.message : String(err));
      return 2;
    });
  }
  return Effect.gen(function* () {
    if (decoded[0] !== "_hello") {
      const { config } = yield* Effect.tryPromise({
        try: () => import("../../core/config.ts"),
        catch: (cause) => new RemoteCommandError({ operation: "load config", cause }),
      });
      if (config.instance.role !== "worker") {
        yield* Effect.sync(() =>
          console.error(
            'remote execution requires [instance] role = "worker" on this host',
          ),
        );
        return 1;
      }
    }
    const { dispatch } = yield* Effect.tryPromise({
      try: () => import("../index.ts"),
      catch: (cause) => new RemoteCommandError({ operation: "load dispatcher", cause }),
    });
    return yield* dispatch(decoded);
  });
}
