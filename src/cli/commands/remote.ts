import { Effect } from "effect";

import { config } from "../../core/config.ts";
import { type RemoteRunError, runRemoteWt } from "../../core/remote.ts";
import { setWezTermTabTitle, type WezTermError } from "../../core/wezterm.ts";
import { NF } from "../../tui/icons.ts";
import { red } from "../colors.ts";

const titleEffect = (title: string) => setWezTermTabTitle(title, config.paths.weztermCli);

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
        titleEffect(`${NF.remote} ${remote.label} · wt`),
        () => command,
        () => titleEffect("wt").pipe(Effect.orElseSucceed(() => undefined)),
      )
    : command;
});
