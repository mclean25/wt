/**
 * Internal entrypoint. The generated `[dev_server]` supervisor calls
 * this when it parks, because the process that gave up is the one that
 * knows it gave up — nothing polling from outside can tell "parked just
 * now" from "parked an hour ago", and the pane it needs to save is
 * being overwritten either way.
 *
 * Not a user command: it is spliced into the supervisor script by path
 * and takes a bare slug. Kept tiny and lazily imported for the usual
 * reason — this runs at the exact moment a project's dev environment is
 * already broken, so it must not be able to fail for a second reason.
 */
import { causeMessage } from "../../core/errors.ts";
import { handleDevGiveUp } from "../../core/dev-server.ts";
import { Effect } from "effect";

export function run(argv: string[]): Effect.Effect<number> {
  const slug = argv[0];
  if (!slug || argv.length !== 1) {
    console.error("usage: wt _dev-giveup <slug>");
    return Effect.succeed(2);
  }
  return handleDevGiveUp(slug).pipe(
    // Never fail the supervisor's exit path over cleanup: the marker is
    // already written, so the row reads `crashed` regardless, and a
    // thrown error here would only replace a useful pane with a stack.
    Effect.catch((cause) =>
      Effect.sync(() => {
        console.error(`wt: dev give-up cleanup failed: ${causeMessage(cause)}`);
      }),
    ),
    Effect.as(0),
  );
}
