import { config } from "../../core/config.ts";
import {
  DEV_QUEUE_FIRST,
  DEV_WAIT_DEFAULT_TIMEOUT_MS,
  DevSlotFullError,
  devServerStatus,
  devSlotReport,
  DEV_READY_DEFAULT_TIMEOUT_MS,
  devHealth,
  readDevCrashLog,
  readDevWaiters,
  resetDevServer,
  setDevWaiterPriority,
  startDevServer,
  stopDevServer,
  waitForDevReady,
  type DevSlotHolder,
} from "../../core/dev-server.ts";
import { sessionName, TMUX_SOCKET } from "../../core/tmux.ts";
import { run as runProc } from "../../core/proc.ts";
import type { Worktree } from "../../core/types.ts";
import { listWorktrees, worktreeAtCwd } from "../../core/worktree.ts";
import { agentIdentity } from "../../core/agent-identity.ts";
import { hasHelpFlag } from "../args.ts";
import { bold, cyan, dim, green, red, yellow } from "../colors.ts";

/**
 * Exit status for "no dev-server slot is free right now". Deliberately
 * distinct from 1: an agent looping until a slot opens has to be able
 * to tell a temporary refusal from a real failure, and a generic
 * failure exit reads as "the dev server is broken" — which is what sent
 * one agent to the human instead of back around the loop. 75 is
 * sysexits' EX_TEMPFAIL, whose whole meaning is "try again later".
 */
const EXIT_NO_SLOT = 75;

/**
 * How long after a start an unhealthy answer is read as "still coming
 * up" rather than "broken". Sized off the observed case: a migration
 * replay that read 29 of 35 applied and settled at 35 about a minute
 * later, plus room for a slower machine.
 */
const SETTLING_GRACE_MS = 5 * 60_000;

const USAGE =
  "usage: wt dev <start|stop|status|logs> [slug] [flags]\n" +
  "  start    start (or restart) the worktree's dev server\n" +
  "             --wait            queue for a slot AND block until it is usable\n" +
  "             --timeout <secs>  give up waiting after this long (default 1800)\n" +
  "             --rebuild         drop the environment's state first (see reset)\n" +
  "  reset    stop, run [dev_server] reset_command, start again — the recovery\n" +
  "             when the environment no longer matches the tree (after a rebase)\n" +
  "  stop     stop it (the port stays reserved for the slug)\n" +
  "  status   print state, port, and URL\n" +
  "             --all             every dev server, the slot count and the queue\n" +
  "             --json            machine-readable form of either view\n" +
  "  queue    show the wait queue; move a waiter between tiers\n" +
  "             <slug> --first    put it ahead of every ordinary waiter\n" +
  "             <slug> --normal   give its place back\n" +
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
  const rebuild = argv.includes("--rebuild");
  const timeoutIdx = argv.indexOf("--timeout");
  // One budget covers the whole operation — queueing for a slot and
  // then coming up. Splitting them would make `--timeout` mean
  // different things depending on how busy the fleet happened to be.
  let timeoutMs = Math.max(DEV_WAIT_DEFAULT_TIMEOUT_MS, DEV_READY_DEFAULT_TIMEOUT_MS);
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

  // Read BEFORE starting: the start re-anchors to the current HEAD, so
  // afterwards there is nothing left to compare against. This is the
  // moment the reader is paying attention, and it is the moment they
  // have historically had no reason to suspect anything.
  const priorStale = rebuild ? false : (await devServerStatus(wt.slug, { path: wt.path })).rebasedSince;
  try {
    const { port, url } = rebuild
      ? await resetDevServer(wt, (line) => console.error(dim(`  ${line}`)))
      : await startDevServer(wt);
    if (priorStale) {
      // wt does not know what a volume is, but it knows this slug last
      // ran a server on a commit that is no longer in the history —
      // which is precisely when whatever the environment persisted
      // (a migrated database above all) describes a tree that no longer
      // exists. Loud, and before the URL, because the URL is what makes
      // it look fine.
      console.error(
        yellow(
          `! this worktree's environment last came up before a rebase — it may be stale`,
        ),
      );
      console.error(
        dim(
          `  anything it kept (a migrated database, a cache) predates this history;` +
            ` ${bold(`wt dev reset ${wt.slug}`)} rebuilds it`,
        ),
      );
    }
    if (!wait) {
      // Deliberately not a green tick. Launching is asynchronous — the
      // supervised process is still bringing the environment up, and
      // for a stack that migrates a database that phase can fail
      // minutes from now, in `wt dev logs`, long after this returns 0.
      // A ✓ followed by a working URL reads as "done" and was read
      // that way: two worktrees took these three lines as a healthy
      // environment. So the banner says what is true — launched, not
      // ready — and names the flag that does wait.
      console.log(`${yellow("→")} dev server launching for ${cyan(wt.slug)}`);
      console.log(`  ${dim("port:")} ${port}`);
      console.log(`  ${dim("url:")}  ${url}`);
      console.log(
        dim("  still coming up — `wt dev start --wait` blocks until it is usable,"),
      );
      console.log(dim("  `wt dev status` asks now, `wt dev logs` shows the boot"));
      return 0;
    }
    const outcome = await waitForDevReady(wt, {
      timeoutMs: timeoutMs,
      onTick: ({ waited, state }) => {
        if (state === "checking") {
          console.error(dim(`  serving — waiting for the environment to settle (${humanAge(waited)})`));
        } else {
          console.error(dim(`  starting… (${humanAge(waited)})`));
        }
      },
    });
    if (!outcome.ready) {
      if (outcome.reason === "crashed") {
        console.error(red(`dev server crashed while starting (${wt.slug})`));
        console.error(dim(`  ${bold(`wt dev logs ${wt.slug}`)} has the boot output`));
        return 1;
      }
      if (outcome.reason === "timeout") {
        console.error(
          red(`dev server still not serving after ${humanAge(timeoutMs)} (${wt.slug})`),
        );
        console.error(dim(`  ${bold(`wt dev logs ${wt.slug}`)} has the boot output`));
        return 1;
      }
      console.error(
        red(`dev server is serving but its environment never settled (${humanAge(timeoutMs)})`),
      );
      console.error(`  ${red(outcome.health.message)}`);
      console.error(
        dim(`  ${bold(`wt dev reset ${wt.slug}`)} rebuilds it from scratch`),
      );
      return 1;
    }
    console.log(green(`✓ dev server ready for ${cyan(wt.slug)}`));
    console.log(`  ${dim("port:")} ${port}`);
    console.log(`  ${dim("url:")}  ${url}`);
    if (outcome.health) console.log(`  ${dim("health:")} ${outcome.health.message}`);
    return 0;
  } catch (err) {
    if (!(err instanceof DevSlotFullError)) throw err;
    if (err.yieldingTo.length > 0) {
      // A slot IS free — saying "full" here would send the reader
      // looking for a holder to free, which is the wrong action and
      // the wrong worktree.
      console.error(
        red(
          `a dev-server slot is free but held for ${err.yieldingTo.map((w) => w.slug).join(", ")}`,
        ),
      );
      console.error(dim("  that worktree was moved to the front of the queue deliberately"));
      console.error(dim("  queue behind it with `wt dev start --wait`"));
      return EXIT_NO_SLOT;
    }
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

/**
 * `wt dev queue [<slug> --first|--normal]`.
 *
 * Promotion edits an already-queued waiter, so it needs nothing from
 * the promoted agent — its own poll re-reads the queue and finds itself
 * at the front. That is what removes the race: a slot frees instantly
 * and a message asking an agent to act does not, so the only orderings
 * that survive are the ones already written down when the slot opens.
 */
async function runQueue(
  slugArg: string | undefined,
  flags: readonly string[],
  json: boolean,
): Promise<number> {
  const first = flags.includes("--first");
  const normal = flags.includes("--normal");
  if (first && normal) {
    console.error(red("--first and --normal are opposites — pick one"));
    return 2;
  }
  if (!slugArg) {
    if (first || normal) {
      console.error(red("which worktree? `wt dev queue <slug> --first`"));
      return 2;
    }
    return printQueue(json);
  }
  if (!first && !normal) {
    console.error(red("`wt dev queue <slug>` needs --first or --normal"));
    return 2;
  }
  // Relative urgency across a fleet is not knowable from inside one
  // worktree — every task looks urgent to the agent doing it, and a
  // tier anyone can claim for themselves is a tier everyone claims. The
  // knowledge lives with whoever can see the other worktrees, so the
  // refusal points there rather than at a permission. A human's shell
  // carries no WT_AGENT and is never caught by this.
  if (first && agentIdentity() === slugArg) {
    console.error(red(`${slugArg} can't move itself to the front of the queue`));
    console.error(
      dim("  whether one task outranks another is a fleet call — ask for it:"),
    );
    console.error(dim(`  wt manager send "dev slot: <why ${slugArg} should jump>"`));
    return 2;
  }
  const updated = setDevWaiterPriority(slugArg, first ? DEV_QUEUE_FIRST : 0);
  if (!updated) {
    console.error(red(`${slugArg} is not in the dev-server queue`));
    console.error(
      dim("  only a waiting worktree can be moved — it queues with `wt dev start --wait`"),
    );
    return 1;
  }
  console.log(
    green(
      first
        ? `✓ ${cyan(slugArg)} moved to the front of the queue`
        : `✓ ${cyan(slugArg)} returned to its place in the queue`,
    ),
  );
  return printQueue(json);
}

function printQueue(json: boolean): number {
  const waiters = readDevWaiters();
  const now = Date.now();
  if (json) {
    console.log(
      JSON.stringify(
        waiters.map((w) => ({ ...w, waitingMs: now - w.since })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (waiters.length === 0) {
    console.log(dim("nothing queued for a dev-server slot"));
    return 0;
  }
  waiters.forEach((w, i) => {
    const tier = w.priority > 0 ? yellow(" first") : "";
    console.log(`  ${i + 1}. ${cyan(w.slug)}${tier} ${dim(`waiting ${humanAge(now - w.since)}`)}`);
  });
  return 0;
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
          // `priority` rides along: a manager filtering this surface for
          // "who is next" must see a deliberate promotion, not just an
          // order it would have to trust blindly.
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
      const tier = w.priority > 0 ? yellow(" first") : "";
      console.log(
        `  ${i + 1}. ${cyan(w.slug)}${tier} ${dim(`waiting ${humanAge(now - w.since)}`)}`,
      );
    });
  }
  return 0;
}

async function runStatusOne(wt: Worktree, json: boolean): Promise<number> {
  const st = await devServerStatus(wt.slug, { path: wt.path });
  // Only worth asking a running server, and only here: this is the
  // on-demand surface, where a slow-but-exact answer is the point. It
  // never rides a poll.
  const health = st.running ? await devHealth(wt) : null;
  const now = Date.now();
  if (json) {
    console.log(JSON.stringify({ slug: wt.slug, ...st, health }, null, 2));
    return st.crashed || health?.ok === false ? 1 : 0;
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
  // The free signal, and the one that needs no project cooperation:
  // this server came up on commits that are no longer in the tree's
  // history, so anything it derived from the tree describes a version
  // that no longer exists.
  if (st.rebasedSince) {
    // Said for a STOPPED server too, and that is the point of saying it
    // here: "not running" reads as a clean slate, so nobody expects the
    // next start to come up on an old schema. A stopped server's
    // environment is still on disk; only its processes are gone.
    console.log(
      st.running
        ? `  ${yellow("stale:")} started before a rebase — its environment predates this history`
        : `  ${yellow("stale:")} last ran before a rebase — whatever it kept on disk predates this history`,
    );
    console.log(dim(`  ${bold(`wt dev reset ${wt.slug}`)} rebuilds it from the current tree`));
  }
  if (health) {
    console.log(
      `  ${dim("health:")} ${health.ok ? green(health.message) : red(health.message)}`,
    );
    if (!health.ok) {
      // A one-shot check cannot tell "not yet" from "wrong", and a
      // young server is usually the former: a migration replay in
      // progress reads exactly like a stale one stuck at the same
      // count. Say so rather than sending someone to rebuild a stack
      // that was about to be fine.
      const age = st.since === null ? null : now - st.since;
      if (age !== null && age < SETTLING_GRACE_MS) {
        console.log(
          dim(
            `  it started ${humanAge(age)} ago — this may just be unfinished startup;` +
              " `wt dev start --wait` blocks until it settles",
          ),
        );
      } else {
        console.log(dim(`  ${bold(`wt dev reset ${wt.slug}`)} rebuilds it from scratch`));
      }
    }
  }
  return st.crashed || health?.ok === false ? 1 : 0;
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
  const known = new Set([
    "--wait",
    "--timeout",
    "--all",
    "--json",
    "--first",
    "--normal",
    "--rebuild",
  ]);
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
  // Also subject-less: promoting names its target explicitly, and the
  // manager runs this from wherever it happens to be.
  if (sub === "queue") return runQueue(slugArg, flags, json);

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
    case "reset":
      // Same code path as `start --rebuild`; a name of its own because
      // "rebuild this environment from the tree" is what someone
      // reaches for, and they will not find it under `start`.
      return runStart(wt, [...argv, "--rebuild"]);
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
