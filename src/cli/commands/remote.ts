import { Effect } from "effect";

import { config } from "../../core/config.ts";
import { type RemoteRunError, runRemoteWt } from "../../core/remote.ts";
import { setWezTermTabTitle, type WezTermError } from "../../core/wezterm.ts";
import { NF } from "../../tui/icons.ts";
import { red } from "../colors.ts";

const setTitle = (title: string) => setWezTermTabTitle(title, config.paths.weztermCli);

export const run = Effect.fn("wt remote")(function* (
  argv: string[],
): Effect.fn.Return<number, RemoteRunError | WezTermError> {
  const remote = config.remote;
  if (!remote) {
    console.error(red("[remote] is not configured in config.toml"));
    return 1;
  }
  if (argv.length === 0 && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    console.error(red("interactive remote wt requires a TTY"));
    return 2;
  }
  const interactive = argv.length === 0;
  const command = runRemoteWt(remote, argv, {
    interactive,
    onLine: interactive ? undefined : (line) => console.log(line),
  });
  return yield* interactive
    ? Effect.acquireUseRelease(
        // Tab naming is cosmetic: a failed title must not cost the session.
        setTitle(`${NF.remote} ${remote.label} · wt`).pipe(Effect.orElseSucceed(() => undefined)),
        () => command,
        () => setTitle("wt").pipe(Effect.orElseSucceed(() => undefined)),
      )
    : command;
});
