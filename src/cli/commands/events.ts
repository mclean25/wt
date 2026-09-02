/**
 * `wt events` — manage the optional GitHub webhook daemon.
 *
 * The daemon (`serve`) is a long-lived loopback HTTP server that refreshes
 * the github query on webhook delivery instead of polling. `install`
 * writes a launchd agent; `start`/`stop`/`restart` control it; `status` reports
 * liveness; `secret` mints the HMAC secret you paste into the repo
 * webhook. See `core/events/` for the daemon + on-disk contract.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Data, Duration, Effect, Schedule } from "effect";

import { buildSha, sameBuild } from "../../core/build-id.ts";
import { config } from "../../core/config.ts";
import { resolveWebhookSecret, runDaemonForeground } from "../../core/events/daemon.ts";
import { EVENTS_DIR, ensureEventsDir, isProcessAlive, readSnapshot, readState } from "../../core/events/store.ts";
import { runEffect as shEffect } from "../../core/proc.ts";
import { hasHelpFlag } from "../args.ts";
import { bold, cyan, dim, green, red, yellow } from "../colors.ts";

const LAUNCHD_LABEL = "com.wt.events";

class EventsCommandError extends Data.TaggedError("EventsCommandError")<{
  readonly operation: "serve";
  readonly cause: unknown;
}> {}

const USAGE = `usage: wt events <subcommand>

Manage the optional GitHub webhook daemon. Requires a [github.events]
section in config.toml.

subcommands:
  serve       run the daemon in the foreground (what launchd invokes)
  status      show daemon liveness, last event, snapshot age
  install     write the launchd agent (+ generate a secret if needed)
  uninstall   stop and remove the launchd agent
  start       load the launchd agent (launchctl)
  stop        unload the launchd agent
  restart     unload, reconcile, and reload the launchd agent
  secret      generate + store an HMAC secret, print webhook setup`;

function readFileSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

/**
 * The launcher launchd execs.
 *
 * Deliberately `bin/wt` and NOT `process.execPath`. On Homebrew the running
 * interpreter is a VERSION-SPECIFIC Cellar path
 * (`/opt/homebrew/Cellar/bun/1.3.14/bin/bun`), which `brew upgrade bun`
 * deletes — after which launchd cannot exec the job at all. That failure is
 * invisible in the worst way: `launchctl list` shows exit **78**, and both
 * `StandardOutPath` and `StandardErrorPath` stay EMPTY, because nothing ever
 * ran to write to them. A running daemon survives (it is already exec'd), so
 * the agent looks healthy for as long as nobody restarts it and is dead the
 * first time anybody does. Observed here after an upgrade to bun 1.4.0, on an
 * agent installed 7 days earlier.
 *
 * `bin/wt` resolves `bun` off PATH, which the plist bakes, so it survives any
 * number of interpreter upgrades — and it is the same launcher a human uses,
 * so the daemon inherits the `env -u BUN_INSPECT` scrub for free.
 */
function launcherEntry(): string {
  return join(import.meta.dir, "..", "..", "..", "bin", "wt");
}

/**
 * The program path a plist will try to exec. Exported for tests: it powers
 * the only diagnostic for a job launchd cannot exec, and that failure writes
 * nothing to either daemon log, so a silent parse miss here would leave the
 * failure with no output at all — again.
 */
export function plistProgramOf(xml: string): string | null {
  const arr = xml.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  const first = arr?.[1]?.match(/<string>([^<]*)<\/string>/);
  return first?.[1] ?? null;
}

/** The program path the installed plist will try to exec, or null if unreadable. */
function plistProgram(): string | null {
  const xml = readFileSafe(plistPath());
  return xml === null ? null : plistProgramOf(xml);
}

function ago(ts: number | null | undefined): string {
  if (!ts) return "never";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function plistContents(): string {
  const argv = [launcherEntry(), "events", "serve"];
  const env: Record<string, string> = {
    // launchd starts with a minimal PATH; bake the install-time PATH (which
    // has gh + git) plus bun's own dir so `bin/wt` finds an interpreter and
    // `fetchGithub` can shell out. bun's dir goes LAST: it is a versioned
    // Cellar path on Homebrew and will be deleted by the next upgrade, so it
    // is a fallback for a bun that is not on PATH, never the primary.
    PATH: `${process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"}:${dirname(process.execPath)}`,
    HOME: homedir(),
  };
  // Carry config overrides so the daemon loads the same config.toml the TUI does.
  if (process.env.WT_CONFIG) env.WT_CONFIG = process.env.WT_CONFIG;
  if (process.env.XDG_CONFIG_HOME) env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;

  const argLines = argv.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const envLines = Object.entries(env)
    .map(([k, v]) => `    <key>${xmlEscape(k)}</key>\n    <string>${xmlEscape(v)}</string>`)
    .join("\n");
  const outLog = join(EVENTS_DIR, "daemon.out.log");
  const errLog = join(EVENTS_DIR, "daemon.err.log");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argLines}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envLines}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errLog)}</string>
</dict>
</plist>
`;
}

/** Print the values to paste into the repo's GitHub webhook settings. */
function printWebhookSetup(host: string, port: number, secretLine: string): void {
  console.log(`\n${bold("GitHub webhook settings")} (repo → Settings → Webhooks → Add webhook):`);
  console.log(
    `  ${dim("Payload URL")}    https://<your-domain>/webhook   ${dim(`(forward → ${host}:${port}/webhook)`)}`,
  );
  console.log(`  ${dim("Content type")}   application/json`);
  console.log(`  ${dim("Secret")}         ${secretLine}`);
  console.log(`  ${dim("SSL")}            enabled`);
  console.log(`  ${dim("Events")}         pull_request, pull_request_review,`);
  console.log(`                 pull_request_review_thread, issue_comment, check_suite,`);
  console.log(`                 check_run, status, merge_group, push`);
  console.log(dim('\nAfter saving, use the webhook\'s "Recent Deliveries" → Redeliver to test.'));
}

type SecretInfo = {
  secret: string;
  alreadyConfigured: boolean;
  statusLine: string;
};

function ensureSecret(): SecretInfo | null {
  const events = config.github.events;
  if (!events) return null;
  const existing = resolveWebhookSecret(events);
  if (existing) {
    return {
      secret: existing,
      alreadyConfigured: true,
      statusLine: dim("(already configured)"),
    };
  }
  const secret = randomBytes(32).toString("hex");
  if (events.secretFile) {
    mkdirSync(dirname(events.secretFile), { recursive: true });
    // Create restricted from the start (mode applies on create) AND chmod
    // for the overwrite case (mode is ignored when the file already exists),
    // so the secret is never briefly world-readable.
    writeFileSync(events.secretFile, `${secret}\n`, { mode: 0o600 });
    chmodSync(events.secretFile, 0o600);
    return {
      secret,
      alreadyConfigured: false,
      statusLine: `${green("written")} ${dim(`→ ${events.secretFile}`)}`,
    };
  }
  // No secret_file configured — print it for the user to wire in manually.
  console.log(yellow("\nNo [github.events].secret_file configured. Add this to config.toml under [github.events]:"));
  console.log(`  secret = "${secret}"`);
  return { secret, alreadyConfigured: false, statusLine: dim("(shown above)") };
}

/** What to show on the "Secret" line of the webhook setup block. */
function secretDisplay(info: SecretInfo): string {
  return info.alreadyConfigured ? dim("(your existing secret)") : info.secret;
}

function launchctlEffect(action: "load" | "unload", opts: { ignoreFailure?: boolean } = {}): Effect.Effect<number> {
  return Effect.gen(function* () {
    const plist = plistPath();
    if (!existsSync(plist)) {
      console.error(red(`no launchd agent at ${plist} — run \`wt events install\` first`));
      return 1;
    }
    // Reconcile before loading, never only at install. Every value in the
    // plist is derived from the current environment (interpreter, PATH, repo
    // location), so a stored plist is a snapshot of a machine that may have
    // moved on — and the failure it produces has no output anywhere to read:
    // launchd cannot exec, so it writes nothing to either log and reports
    // exit 78. A source fix cannot heal a plist a previous version wrote;
    // only a pass that rewrites it can.
    if (action === "load") {
      const want = plistContents();
      if (readFileSafe(plist) !== want) {
        const before = plistProgram();
        writeFileSync(plist, want);
        const stale = before && !existsSync(before) ? ` (its program was gone: ${before})` : "";
        console.log(`${yellow("↻")} refreshed the launchd agent${stale}`);
      }
    }
    const r = yield* shEffect(["launchctl", action, "-w", plist]).pipe(
      Effect.orElseSucceed(() => ({
        stdout: "",
        stderr: "",
        exitCode: 1,
        timedOut: false,
      })),
    );
    if (r.stderr.trim() && !(opts.ignoreFailure && r.exitCode !== 0)) {
      process.stderr.write(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
    }
    if (r.exitCode !== 0) {
      if (opts.ignoreFailure) return 1;
      console.error(red(`launchctl ${action} failed (exit ${r.exitCode})`));
      return 1;
    }
    console.log(`${green("✓")} ${action === "load" ? "started" : "stopped"} ${LAUNCHD_LABEL}`);
    return 0;
  });
}

/**
 * Restart an installed agent, starting it even when it was not currently
 * loaded. `launchctl unload` returns nonzero for that harmless case, so the
 * load is authoritative: if the old job really could not be unloaded, the
 * load will fail rather than falsely reporting a restart.
 */
type RestartLaunchdDeps = {
  control?: (action: "load" | "unload", opts?: { ignoreFailure?: boolean }) => Effect.Effect<number>;
  waitUntilRunning?: (previousPid: number | null) => Effect.Effect<boolean>;
};

class DaemonNotReady extends Data.TaggedError("DaemonNotReady") {}

export function waitForRestartedDaemonEffect(
  previousPid: number | null,
  ready: () => boolean = () => {
    const state = readState();
    return Boolean(state && state.pid !== previousPid && isProcessAlive(state.pid));
  },
): Effect.Effect<boolean> {
  const probe = Effect.suspend(() => {
    return ready() ? Effect.succeed(true) : Effect.fail(new DaemonNotReady());
  });
  return probe.pipe(
    Effect.retry(Schedule.spaced(Duration.millis(100)).pipe(Schedule.intersect(Schedule.recurs(99)))),
    Effect.orElseSucceed(() => false),
  );
}

export function restartLaunchdAgentEffect(deps: RestartLaunchdDeps = {}): Effect.Effect<number> {
  return Effect.gen(function* () {
    const control = deps.control ?? launchctlEffect;
    const previousPid = readState()?.pid ?? null;
    yield* control("unload", { ignoreFailure: true });
    const loaded = yield* control("load");
    if (loaded !== 0) return loaded;
    const running = yield* (deps.waitUntilRunning ?? waitForRestartedDaemonEffect)(previousPid);
    if (running) return 0;
    console.error(red("events daemon did not become ready within 10s after restart"));
    return 1;
  });
}

function requireEventsConfigured(): boolean {
  if (!config.github.events) {
    console.error(red("[github.events] is not configured in config.toml."));
    console.error(dim("Add a [github.events] section (port, secret_file) to enable the daemon."));
    return false;
  }
  return true;
}

function cmdStatus(): number {
  const events = config.github.events;
  if (!events) {
    console.log(dim("[github.events] not configured — daemon disabled, github query polls on the 60s timer."));
    return 0;
  }
  const state = readState();
  const alive = state ? isProcessAlive(state.pid) : false;
  const snap = readSnapshot();
  console.log(bold("wt events"));
  console.log(`  status        ${alive ? green("running") : red("not running")}`);
  console.log(`  bind          ${events.host}:${events.port}`);
  console.log(`  secret        ${resolveWebhookSecret(events) ? green("set") : red("missing")}`);
  if (state) {
    if (alive) console.log(`  pid           ${state.pid}`);
    console.log(`  started       ${ago(state.startedAt)}`);
    console.log(`  events        ${state.eventCount} ${dim(`(last ${ago(state.lastEventAt)})`)}`);
    console.log(`  last fetch    ${ago(state.lastFetchAt)}`);
    if (state.lastError) console.log(`  last error    ${red(state.lastError)}`);
  }
  console.log(
    `  snapshot      ${snap ? `${Object.keys(snap.prs).length} PRs, written ${ago(snap.updatedAt)}` : dim("none")}`,
  );
  // The daemon outlives every hot update, and it hands the TUI PARSED
  // data — so "running" and "up to date" are different questions and only
  // the first one used to be answerable here. A daemon on an older build
  // looks perfectly healthy while feeding the TUI its own build's
  // parsing rules, which is how a red checks badge and a stale
  // review-bot badge both survived on a TUI that had already fixed them.
  if (snap && !sameBuild(snap.writerSha)) {
    const wrote = snap.writerSha ? snap.writerSha.slice(0, 7) : "unstamped";
    console.log(`  build         ${yellow(`stale (wrote ${wrote}, this build ${(buildSha() ?? "?").slice(0, 7)})`)}`);
    console.log(
      dim("                the TUI is ignoring its snapshot and fetching live; it restarts itself on its next fetch"),
    );
    console.log(dim("                — `wt events restart` does it now"));
  }
  const program = plistProgram();
  if (program && !existsSync(program)) {
    // The one failure with no output to read: launchd never execs, so both
    // daemon logs stay empty and `launchctl list` shows a bare exit 78.
    console.log(`  agent         ${red("cannot exec")} ${dim(program)}`);
    console.log(dim("                `wt events start` rewrites the agent and reloads it"));
  }
  if (!alive) console.log(dim("\nStart it with `wt events start` (after `wt events install`)."));
  return 0;
}

function cmdInstall(): number {
  if (!requireEventsConfigured()) return 1;
  const events = config.github.events!;
  ensureEventsDir();
  const secret = ensureSecret();
  const plist = plistPath();
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, plistContents());
  console.log(`${green("✓")} launchd agent ${dim("→")} ${plist}`);
  if (secret) printWebhookSetup(events.host, events.port, secretDisplay(secret));
  console.log(
    `\nNext: ${cyan("wt events start")} to load the daemon, then forward your domain to ${events.host}:${events.port}.`,
  );
  return 0;
}

function cmdUninstallEffect(): Effect.Effect<number> {
  return Effect.gen(function* () {
    const plist = plistPath();
    if (existsSync(plist)) {
      // Best-effort unload before removing so launchd drops the live job.
      yield* shEffect(["launchctl", "unload", "-w", plist]).pipe(Effect.ignore);
      rmSync(plist, { force: true });
      console.log(`${green("✓")} removed ${plist}`);
    } else {
      console.log(dim("no launchd agent to remove"));
    }
    return 0;
  });
}

function cmdSecret(): number {
  if (!requireEventsConfigured()) return 1;
  const events = config.github.events!;
  ensureEventsDir();
  const secret = ensureSecret();
  if (!secret) return 1;
  console.log(`${green("✓")} webhook secret ${secret.statusLine}`);
  printWebhookSetup(events.host, events.port, secretDisplay(secret));
  return 0;
}

export function run(argv: string[]): Effect.Effect<number, EventsCommandError> {
  const [sub, ...rest] = argv;
  if (hasHelpFlag(argv)) {
    return Effect.sync(() => {
      console.log(USAGE);
      return 0;
    });
  }
  if (rest.length > 0) {
    return Effect.sync(() => {
      console.error(red(`unexpected argument: ${rest[0]}\n`));
      console.error(USAGE);
      return 2;
    });
  }
  switch (sub) {
    case "serve":
      return Effect.tryPromise({
        try: runDaemonForeground,
        catch: (cause) => new EventsCommandError({ operation: "serve", cause }),
      });
    case "status":
      return Effect.sync(cmdStatus);
    case "install":
      return Effect.sync(cmdInstall);
    case "uninstall":
      return cmdUninstallEffect();
    case "start":
      return requireEventsConfigured() ? launchctlEffect("load") : Effect.succeed(1);
    case "stop":
      return launchctlEffect("unload");
    case "restart":
      return requireEventsConfigured() ? restartLaunchdAgentEffect() : Effect.succeed(1);
    case "secret":
      return Effect.sync(cmdSecret);
    case undefined:
      return Effect.sync(() => {
        console.log(USAGE);
        return 2;
      });
    default:
      return Effect.sync(() => {
        console.error(red(`unknown events subcommand: ${sub}\n`));
        console.error(USAGE);
        return 2;
      });
  }
}
