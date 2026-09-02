import { Data, Effect } from "effect";

import { config } from "../../core/config.ts";
import { runRemoteWtPromise } from "../../core/remote.ts";
import { setWezTermTabTitlePromise } from "../../core/wezterm.ts";
import { NF } from "../../tui/icons.ts";
import { red } from "../colors.ts";

class RemoteCommandError extends Data.TaggedError("RemoteCommandError")<{
  readonly operation: "title" | "run";
  readonly cause: unknown;
}> {}

const titleEffect = (title: string) =>
  Effect.tryPromise({
    try: () => setWezTermTabTitlePromise(title, config.paths.weztermCli),
    catch: (cause) => new RemoteCommandError({ operation: "title", cause }),
  });

export function run(argv: string[]): Effect.Effect<number, RemoteCommandError> {
  const remote = config.remote;
  if (!remote) {
    return Effect.sync(() => {
      console.error(red("[remote] is not configured in config.toml"));
      return 1;
    });
  }
  if (argv.length === 0 && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    return Effect.sync(() => {
      console.error(red("interactive remote wt requires a TTY"));
      return 2;
    });
  }
  const interactive = argv.length === 0;
  const command = Effect.tryPromise({
    try: () =>
      runRemoteWtPromise(remote, argv, {
        interactive,
        onLine: interactive ? undefined : (line) => console.log(line),
      }),
    catch: (cause) => new RemoteCommandError({ operation: "run", cause }),
  });
  return interactive
    ? Effect.acquireUseRelease(
        titleEffect(`${NF.remote} ${remote.label} · wt`),
        () => command,
        () => titleEffect("wt").pipe(Effect.orElseSucceed(() => undefined)),
      )
    : command;
}
