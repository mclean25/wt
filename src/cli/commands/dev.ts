import { config } from "../../core/config.ts";
import {
  DEV_WAIT_DEFAULT_TIMEOUT_MS,
  DevSlotFullError,
  devServerStatus,
  devSlotReport,
  readDevCrashLog,
  startDevServer,
  stopDevServer,
  type DevSlotHolder,
} from "../../core/dev-server.ts";
import { sessionName, TMUX_SOCKET } from "../../core/tmux.ts";
import { run as runProc } from "../../core/proc.ts";
import type { Worktree } from "../../core/types.ts";
import { listWorktrees, worktreeAtCwd } from "../../core/worktree.ts";
import { hasHelpFlag } from "../args.ts";
import { cyan, dim, green, red, yellow } from "../colors.ts";

/**
 * Exit status for "no dev-server slot is free right now". Deliberately
 * distinct from 1: an agent looping until a slot opens has to be able
 * to tell a temporary refusal from a real failure, and a generic
 * failure exit reads as "the dev server is broken" — which is what sent
 * one agent to the human instead of back around the loop. 75 is
 * sysexits' EX_TEMPFAIL, whose whole meaning is "try again later".
 */
const EXIT_NO_SLOT = 75;

const USAGE =
  "usage: wt dev <start|stop|status|logs> [slug] [flags]\n" +
  "  start    start (or restart) the worktree's dev server\n" +
  "             --wait            queue until a slot frees instead of refusing\n" +
  "             --timeout <secs>  give up waiting after this long (default 1800)\n" +
  "  stop     stop it (the port stays reserved for the slug)\n" +
  "  status   print state, port, and URL\n" +
  "             --all             every dev server, the slot count and the queue\n" +
  "             --json            machine-readable form of either view\n" +
  "  logs     print the supervisor pane's recent output\n" +
  "slug defaults to the worktree containing the current directory.\n" +
  `exit ${EXIT_NO_SLOT} from \`start\` means the concurrency cap is full — retry later.`;

/** The target worktree: explicit slug arg, else the one containing cwd. */
async function resolveWorktree(slugArg: string | undefined): Promise<Worktree | null> {
  const all = (await listWorktrees()).filter((w) => !w.isMain);
  if (slugArg) return all.find((w) => w.slug === slugArg) ?? null;
  return worktreeAtCwd(all);
}

function humanAge(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 90) return `${secs}s`;
  const mins = Math.round(secs / 60);
  return mins < 90 ? `${mins}m` : `${Math.round(mins / 60)}h`;
}

/** `slug`, `slug (crashed)`, … — the holder list a refusal or the queue prints. */
function describeHolders(holders: readonly DevSlotHolder[]): string {
  return holders
    .map((h) => (h.state === "crashed" ? `${h.slug} (crashed)` : h.slug))
    .join(", ");
}

/**
 * What to do about a full fleet, printed once on refusal. A crashed
 * holder is the cheap slot to reclaim and the one nobody is using, so
 * name it specifically rather than leaving the reader to compare two
 * lists.
 */
function reclaimHint(holders: readonly DevSlotHolder[]): string | null {
  const parked = holders.filter((h) => h.state === "crashed").map((h) => h.slug);
  if (parked.length === 0) return null;
  const s = parked.length === 1 ? "" : "s";
  return `${parked.length} crashed server${s} hold${parked.length === 1 ? "s" : ""} a slot: ${parked.join(", ")}`;
}

async function runStart(wt: Worktree, argv: readonly string[]): Promise<number> {
  const wait = argv.includes("--wait");
  const timeoutIdx = argv.indexOf("--timeout");
  let timeoutMs = DEV_WAIT_DEFAULT_TIMEOUT_MS;
  if (timeoutIdx >= 0) {
    const raw = Number(argv[timeoutIdx + 1]);
    if (!Number.isFinite(raw) || raw <= 0) {
      console.error(red("--timeout takes a positive number of seconds"));
      return 2;
    }
    timeoutMs = raw * 1000;
  }

  if (wait) {
    // Imported lazily so a plain start never pays for the queue module
    // graph, and so a broken one can't take `wt dev start` with it.
    const { waitForDevSlot } = await import("../../core/dev-server.ts");
    let announced = false;
    const got = await waitForDevSlot(wt.slug, {
      timeoutMs,
      onWait: ({ rank, holders, waited }) => {
        // First tick names who has the slots; after that just the
        // position, so a half-hour wait doesn't bury a terminal.
        if (!announced) {
          announced = true;
          console.error(
            yellow(`waiting for a dev-server slot — held by ${describeHolders(holders)}`),
          );
          const hint = reclaimHint(holders);
          if (hint) console.error(dim(`  ${hint}`));
        }
        console.error(dim(`  queued #${rank + 1} (${humanAge(waited)})`));
      },
    });
    if (!got) {
      console.error(
        red(`no dev-server slot after ${humanAge(timeoutMs)} — nothing freed up`),
      );
      return EXIT_NO_SLOT;
    }
  }

  try {
    const { port, url } = await startDevServer(wt);
    console.log(green(`✓ dev server starting for ${cyan(wt.slug)}`));
    console.log(`  ${dim("port:")} ${port}`);
    console.log(`  ${dim("url:")}  ${url}`);
    return 0;
  } catch (err) {
    if (!(err instanceof DevSlotFullError)) throw err;
    console.error(
      red(
        `dev-server slots full (${err.holders.length}/${err.limit}): ${describeHolders(err.holders)}`,
      ),
    );
    const hint = reclaimHint(err.holders);
    if (hint) console.error(dim(`  ${hint}`));
    console.error(
      dim("  retry with `wt dev start --wait` to queue until a slot opens"),
    );
    return EXIT_NO_SLOT;
  }
}

async function runStatusAll(json: boolean): Promise<number> {
  const report = await devSlotReport();
  const now = Date.now();
  if (json) {
    console.log(
      JSON.stringify(
        {
          limit: report.limit,
          free: report.free,
          holders: report.holders,
          waiting: report.waiters.map((w) => ({ ...w, waitingMs: now - w.since })),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const cap = report.limit === null ? "uncapped" : `${report.holders.length}/${report.limit}`;
  console.log(`${dim("dev servers:")} ${cap}`);
  for (const h of report.holders) {
    const st = h.state === "crashed" ? red("crashed") : green("up");
    console.log(`  ${cyan(h.slug)} ${st}`);
  }
  if (report.holders.length === 0) console.log(dim("  (none running)"));
  if (report.waiters.length > 0) {
    console.log(`${dim("queued:")}`);
    report.waiters.forEach((w, i) => {
      console.log(`  ${i + 1}. ${cyan(w.slug)} ${dim(`waiting ${humanAge(now - w.since)}`)}`);
    });
  }
  return 0;
}

async function runStatusOne(wt: Worktree, json: boolean): Promise<number> {
  const st = await devServerStatus(wt.slug);
  const now = Date.now();
  if (json) {
    console.log(JSON.stringify({ slug: wt.slug, ...st }, null, 2));
    return st.crashed ? 1 : 0;
  }
  // The elapsed time is the whole value of the `starting` line: a stack
  // that has to bring docker up legitimately takes minutes, so the word
  // alone can't distinguish "booting" from "wedged".
  const age = st.since === null ? "" : dim(` (${humanAge(now - st.since)})`);
  const state = st.running
    ? green("running")
    : st.starting
      ? yellow("starting") + age
      : st.crashed
        ? red("crashed (see `wt dev logs`)")
        : st.waiting
          ? yellow(
              `queued #${st.waiting.rank + 1} for a slot (${humanAge(now - st.waiting.since)})`,
            )
          : dim("not running");
  console.log(`${cyan(wt.slug)}: ${state}`);
  if (st.port !== null) console.log(`  ${dim("port:")} ${st.port}`);
  if (st.url) console.log(`  ${dim("url:")}  ${st.url}`);
  return st.crashed ? 1 : 0;
}

export async function run(argv: string[]): Promise<number> {
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return 0;
  }
  const flags = argv.filter((a) => a.startsWith("--"));
  const timeoutIdx = argv.indexOf("--timeout");
  const positional = argv.filter(
    (a, i) => !a.startsWith("--") && !(timeoutIdx >= 0 && i === timeoutIdx + 1),
  );
  const [sub, slugArg, ...extra] = positional;
  if (!sub || extra.length > 0) {
    console.log(USAGE);
    return 2;
  }
  const known = new Set(["--wait", "--timeout", "--all", "--json"]);
  const unknown = flags.find((f) => !known.has(f));
  if (unknown) {
    console.error(red(`unknown flag: ${unknown}`));
    console.log(USAGE);
    return 2;
  }
  if (!config.devServer) {
    console.error(red("[dev_server] is not configured in config.toml"));
    return 1;
  }

  const json = flags.includes("--json");
  // The fleet view has no subject worktree, so it resolves before the
  // "not inside a worktree" bail — `wt dev status --all` has to work
  // from anywhere, which is where a manager or a queued agent runs it.
  if (sub === "status" && flags.includes("--all")) return runStatusAll(json);

  const wt = await resolveWorktree(slugArg);
  if (!wt) {
    console.error(
      red(slugArg ? `no worktree with slug ${slugArg}` : "not inside a worktree (pass a slug)"),
    );
    return 1;
  }

  switch (sub) {
    case "start":
      return runStart(wt, argv);
    case "stop": {
      await stopDevServer(wt);
      console.log(green(`✓ dev server stopped for ${cyan(wt.slug)}`));
      return 0;
    }
    case "status":
      return runStatusOne(wt, json);
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
      if (r.exitCode === 0) {
        console.log(r.stdout.trimEnd());
        return 0;
      }
      // No pane. A parked supervisor's scrollback is saved off before
      // anything reclaims its session, precisely so the crash report
      // outlives the pane that held it.
      const saved = readDevCrashLog(wt.slug);
      if (saved) {
        console.log(dim("(session gone — saved crash log)"));
        console.log(saved.trimEnd());
        return 0;
      }
      console.error(red("no dev server session (never started, or already cleaned up)"));
      return 1;
    }
    default:
      console.log(USAGE);
      return 2;
  }
}
