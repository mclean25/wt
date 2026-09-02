import { Effect } from "effect";

import { operationErrors } from "../../core/errors.ts";
import { decodeRemoteArgs } from "../../core/remote-protocol.ts";

const io = operationErrors("wt _remote");

function decodeOrError(raw: string): { decoded: string[] } | { error: string } {
  try {
    return { decoded: decodeRemoteArgs(raw) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const runDecoded = Effect.fn("wt _remote")(function* (decoded: string[]) {
  if (decoded[0] !== "_hello") {
    const { config } = yield* io.promise("load config", () => import("../../core/config.ts"));
    if (config.instance.role !== "worker") {
      console.error('remote execution requires [instance] role = "worker" on this host');
      return 1;
    }
  }
  const { dispatch } = yield* io.promise("load dispatcher", () => import("../index.ts"));
  return yield* dispatch(decoded);
});

/** Decode SSH-safe argv and re-enter the normal CLI dispatcher remotely. */
export function run(argv: string[]): Effect.Effect<number, Error> {
  if (argv.length !== 1) {
    return Effect.sync(() => {
      console.error("usage: wt _remote <encoded-argv>");
      return 2;
    });
  }
  const parsed = decodeOrError(argv[0]!);
  if ("error" in parsed) {
    return Effect.sync(() => {
      console.error(parsed.error);
      return 2;
    });
  }
  return runDecoded(parsed.decoded);
}
