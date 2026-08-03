import { config } from "../../core/config.ts";
import {
  devServerStatus,
  startDevServer,
  stopDevServer,
} from "../../core/dev-server.ts";
import { sessionName, TMUX_SOCKET } from "../../core/tmux/naming.ts";
import { run as runProc } from "../../core/proc.ts";
import type { Worktree } from "../../core/types.ts";
import { listWorktrees } from "../../core/worktree.ts";
import { cyan, dim, green, red, yellow } from "../colors.ts";

const USAGE =
  "usage: wt dev <start|stop|status|logs> [slug]\n" +
  "  start    start (or restart) the worktree's dev server\n" +
  "  stop     stop it (the port stays reserved for the slug)\n" +
  "  status   print state, port, and URL\n" +
  "  logs     print the supervisor pane's recent output\n" +
  "slug defaults to the worktree containing the current directory.";

/** The target worktree: explicit slug arg, else the one containing cwd. */
async function resolveWorktree(slugArg: string | undefined): Promise<Worktree | null> {
  const all = (await listWorktrees()).filter((w) => !w.isMain);
  if (slugArg) return all.find((w) => w.slug === slugArg) ?? null;
  const cwd = process.cwd();
  return all.find((w) => cwd === w.path || cwd.startsWith(`${w.path}/`)) ?? null;
}

export async function run(argv: string[]): Promise<number> {
  const [sub, slugArg, ...extra] = argv;
  if (!sub || sub === "--help" || sub === "-h" || extra.length > 0) {
    console.log(USAGE);
    return 2;
  }
  if (!config.devServer) {
    console.error(red("[dev_server] is not configured in config.toml"));
    return 1;
  }
  const wt = await resolveWorktree(slugArg);
  if (!wt) {
    console.error(
      red(slugArg ? `no worktree with slug ${slugArg}` : "not inside a worktree (pass a slug)"),
    );
    return 1;
  }

  switch (sub) {
    case "start": {
      const { port, url } = await startDevServer(wt);
      console.log(green(`✓ dev server starting for ${cyan(wt.slug)}`));
      console.log(`  ${dim("port:")} ${port}`);
      console.log(`  ${dim("url:")}  ${url}`);
      return 0;
    }
    case "stop": {
      await stopDevServer(wt.slug);
      console.log(green(`✓ dev server stopped for ${cyan(wt.slug)}`));
      return 0;
    }
    case "status": {
      const st = await devServerStatus(wt.slug);
      const state = st.running
        ? green("running")
        : st.starting
          ? yellow("starting")
          : st.crashed
            ? red("crashed (see `wt dev logs`)")
            : dim("not running");
      console.log(`${cyan(wt.slug)}: ${state}`);
      if (st.port !== null) console.log(`  ${dim("port:")} ${st.port}`);
      if (st.url) console.log(`  ${dim("url:")}  ${st.url}`);
      return st.crashed ? 1 : 0;
    }
    case "logs": {
      // The tmux pane (alive or remained-on-exit) IS the log store.
      const r = await runProc([
        "tmux",
        "-L",
        TMUX_SOCKET,
        "capture-pane",
        "-p",
        // Trailing ":" = exact-session + active window; capture-pane
        // resolves a PANE target, where the bare `=name` form errors
        // (same quirk send-keys has — see closeHarnessSessionGracefully).
        "-t",
        `=${sessionName(wt.slug, "dev")}:`,
        "-S",
        "-200",
      ]);
      if (r.exitCode !== 0) {
        console.error(red("no dev server session (never started, or already cleaned up)"));
        return 1;
      }
      console.log(r.stdout.trimEnd());
      return 0;
    }
    default:
      console.log(USAGE);
      return 2;
  }
}
