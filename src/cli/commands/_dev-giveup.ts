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
import { handleDevGiveUp } from "../../core/dev-server.ts";

export async function run(argv: string[]): Promise<number> {
  const slug = argv[0];
  if (!slug) {
    console.error("usage: wt _dev-giveup <slug>");
    return 2;
  }
  try {
    await handleDevGiveUp(slug);
  } catch (err) {
    // Never fail the supervisor's exit path over cleanup: the marker is
    // already written, so the row reads `crashed` regardless, and a
    // thrown error here would only replace a useful pane with a stack.
    console.error(`wt: dev give-up cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return 0;
}
