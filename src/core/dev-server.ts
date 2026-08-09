/**
 * Per-worktree dev server (`[dev_server]`) — start/stop/status for one
 * supervised long-running process per worktree.
 *
 * Process model: the command runs inside a tmux session on the
 * wt-private server (`<slug>-dev`), under a small POSIX-sh supervisor
 * loop written to `~/.cache/wt/dev/<slug>.sh`. That buys the three
 * properties the feature needs for free:
 *
 *  - survives wt restarts (tmux outlives the TUI; wt just observes);
 *  - restarts on crash without thrashing — an exit within
 *    `RAPID_CRASH_SECONDS` of start counts as a rapid failure, and
 *    `GIVE_UP_AFTER` consecutive rapid failures parks the supervisor
 *    (state `crashed`, pane kept via remain-on-exit so the logs stay
 *    readable); a SIGINT/SIGTERM exit is treated as an intentional stop;
 *  - cleaned up with the worktree — the `-dev` suffix is a registered
 *    session kind, so `killAllSessionsFor` (destroy) and the startup
 *    orphan reaper sweep it like every other kind.
 *
 * Port ownership: wt allocates each slug a stable port from
 * `[port_base, port_base + port_range)`, persisted in wtstate
 * (`devPort`, freed with `clearSlugState`). The command template pins
 * the server to it via `{{port}}` — auto-picking servers (vite's
 * port-increment) are exactly what this exists to avoid, since a
 * drifted port breaks recorded URLs and hardcoded HMR sockets.
 *
 * The supervisor writes a one-word marker file
 * (`~/.cache/wt/dev/<slug>.state`: running | stopped | crashed) that
 * `devServerStatus` combines with "does the session exist" and "is the
 * port accepting connections" into the level-derived state the row and
 * bolt render.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

import { config, type DevServerConfig } from "./config.ts";
import { createLogger } from "./logger.ts";
import { run } from "./proc.ts";
import { sessionName, shQuote, TMUX_SOCKET } from "./tmux/naming.ts";
import { killByName } from "./tmux/process.ts";
import { claimDevPort, readWtState, WT_STATE_DIR } from "./wtstate.ts";

const log = createLogger("[dev-server]");

const DEV_DIR = join(WT_STATE_DIR, "dev");
/** An exit this soon after start counts as a rapid failure. */
const RAPID_CRASH_SECONDS = 10;
/** Consecutive rapid failures before the supervisor parks. */
const GIVE_UP_AFTER = 3;

export type DevServerStatus = {
  /** Session exists and the recorded port accepts connections. */
  running: boolean;
  /** Session exists, port not (yet) accepting, supervisor not parked. */
  starting: boolean;
  /** Supervisor gave up after repeated rapid crashes; logs kept in the dead pane. */
  crashed: boolean;
  /** The slug's recorded port, if one was ever allocated. */
  port: number | null;
  /** Resolved URL when running, else null. */
  url: string | null;
};

export const DEV_SERVER_STOPPED: DevServerStatus = {
  running: false,
  starting: false,
  crashed: false,
  port: null,
  url: null,
};

function requireDevServer(): DevServerConfig {
  if (!config.devServer) {
    throw new Error("[dev_server] is not configured in config.toml");
  }
  return config.devServer;
}

function markerPath(slug: string): string {
  return join(DEV_DIR, `${slug}.state`);
}

function scriptPath(slug: string): string {
  return join(DEV_DIR, `${slug}.sh`);
}

function readMarker(slug: string): "running" | "stopped" | "crashed" | null {
  try {
    const raw = readFileSync(markerPath(slug), "utf8").trim();
    return raw === "running" || raw === "stopped" || raw === "crashed" ? raw : null;
  } catch {
    return null;
  }
}

export function devUrl(port: number): string {
  return requireDevServer().urlTemplate.replaceAll("{{port}}", String(port));
}

/**
 * True when something accepts TCP connections on the port (loopback —
 * the server may bind wider, but loopback is always reachable when it
 * is up). Connection refused/timeout ⇒ free.
 */
function portInUse(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port });
    const done = (used: boolean) => {
      sock.destroy();
      resolve(used);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/**
 * The slug's stable dev port. Reuses the persisted assignment when it's
 * still inside the configured range, unclaimed by another slug, and not
 * currently in use by a foreign process; otherwise scans the range for
 * the first free port and persists the new assignment. Callers must
 * have stopped this slug's own server first — a port our own session
 * holds would otherwise read as foreign and force a pointless
 * reallocation.
 */
export async function allocateDevPort(slug: string): Promise<number> {
  const dev = requireDevServer();
  const state = readWtState();
  const claimed = new Set<number>();
  for (const [s, rec] of Object.entries(state.slugs)) {
    if (s !== slug && rec.devPort !== undefined) claimed.add(rec.devPort);
  }
  const inRange = (p: number) => p >= dev.portBase && p < dev.portBase + dev.portRange;
  const recorded = state.slugs[slug]?.devPort;
  if (
    recorded !== undefined &&
    inRange(recorded) &&
    !claimed.has(recorded) &&
    !(await portInUse(recorded))
  ) {
    return recorded;
  }
  // Probe (async, unlocked) for a handful of OS-level-free candidates,
  // then claim atomically: `claimDevPort` re-checks the wtstate record
  // under the state-file lock, so two processes allocating concurrently
  // can't both persist the same port — the loser lands on the next
  // candidate. Several candidates so one lost race doesn't force a
  // rescan.
  const candidates: number[] = [];
  for (let p = dev.portBase; p < dev.portBase + dev.portRange; p++) {
    if (claimed.has(p)) continue;
    if (await portInUse(p)) continue;
    candidates.push(p);
    if (candidates.length >= 8) break;
  }
  const port = claimDevPort(slug, candidates);
  if (port === null) {
    throw new Error(
      `no free dev-server port in ${dev.portBase}-${dev.portBase + dev.portRange - 1}; ` +
        "stop something or widen [dev_server] port_range",
    );
  }
  if (recorded !== undefined && recorded !== port) {
    log.info("reallocated dev port", { slug, from: recorded, to: port });
  }
  return port;
}

/**
 * The supervisor script. POSIX sh (runs under /bin/sh); the user's
 * command is spliced in verbatim — it's trusted config, the same
 * standing as `[[actions]]` shell strings. `$PORT` is exported for
 * commands that read the environment instead of `{{port}}`.
 */
function supervisorScript(slug: string, command: string, port: number): string {
  const session = sessionName(slug, "dev");
  return `#!/bin/sh
# Generated by wt — [dev_server] supervisor for ${slug}. Regenerated on
# every start; do not edit.
STATE=${shQuote(markerPath(slug))}
PORT=${port}
export PORT
# Survive the signals that kill the (un-trapped) child: Ctrl-C in an
# attached pane delivers SIGINT to the whole foreground group, and
# without this trap the supervisor itself dies before it can observe
# the child's exit code — the intentional-stop branch below would be
# unreachable and the marker would stay "running" forever.
trap : INT TERM
fails=0
while :; do
  printf running > "$STATE"
  started=$(date +%s)
  ${command}
  code=$?
  # SIGINT/SIGTERM = someone stopped it on purpose (Ctrl-C in an
  # attached pane, a stray kill). Don't fight them — end the session.
  if [ "$code" -eq 130 ] || [ "$code" -eq 143 ]; then
    printf stopped > "$STATE"
    echo "wt: dev server stopped (exit $code)"
    exec tmux -L ${TMUX_SOCKET} kill-session -t ${shQuote(`=${session}`)}
  fi
  if [ $(($(date +%s) - started)) -lt ${RAPID_CRASH_SECONDS} ]; then
    fails=$((fails + 1))
  else
    fails=0
  fi
  if [ "$fails" -ge ${GIVE_UP_AFTER} ]; then
    printf crashed > "$STATE"
    echo "wt: dev server crashed ${GIVE_UP_AFTER} times in a row (last exit $code) — giving up."
    # Single quotes: backticks in a double-quoted sh string would run as
    # command substitution.
    echo 'wt: fix the cause, then start it again from the ! menu or "wt dev start".'
    exit 1
  fi
  echo "wt: dev server exited ($code) — restarting in 2s"
  sleep 2
done
`;
}

/**
 * Start — or restart — the slug's dev server. Idempotent by design:
 * any existing session is killed first, the port re-resolved, the
 * supervisor script rewritten (so config edits take effect), and a
 * fresh session spawned in the worktree. `remain-on-exit` keeps a
 * crashed supervisor's pane (and therefore the crash logs) readable;
 * intentional stops self-kill the session instead.
 */
export async function startDevServer(wt: {
  slug: string;
  path: string;
}): Promise<{ port: number; url: string }> {
  const dev = requireDevServer();
  const session = sessionName(wt.slug, "dev");
  await killByName(session);
  // A just-killed server takes a beat to release its socket; wait for
  // the recorded port to actually close so the allocator doesn't
  // mistake our own dying process for a foreign one and churn the slug
  // to a new port on every restart. Bounded — a port that stays busy
  // past the wait really is foreign, and reallocation is then correct.
  const recorded = readWtState().slugs[wt.slug]?.devPort;
  if (recorded !== undefined) {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && (await portInUse(recorded))) {
      await Bun.sleep(150);
    }
  }
  const port = await allocateDevPort(wt.slug);
  mkdirSync(DEV_DIR, { recursive: true });
  const command = dev.command.replaceAll("{{port}}", String(port));
  const script = scriptPath(wt.slug);
  writeFileSync(script, supervisorScript(wt.slug, command, port), { mode: 0o755 });

  const userShell = process.env.SHELL || "/bin/bash";
  // Outer login shell loads the user's PATH/env (npm, nvm, direnv…);
  // /bin/sh then runs the generated POSIX script with that env.
  const spawn = await run([
    "tmux",
    "-L",
    TMUX_SOCKET,
    "new-session",
    "-d",
    "-s",
    session,
    "-c",
    wt.path,
    userShell,
    "-lc",
    `exec /bin/sh ${shQuote(script)}`,
  ]);
  if (spawn.exitCode !== 0) {
    throw new Error(
      `could not start dev server session: ${(spawn.stderr || spawn.stdout || `tmux exit ${spawn.exitCode}`).trim()}`,
    );
  }
  // Keep the pane after the supervisor parks on a crash — the scrollback
  // IS the crash report. `remain-on-exit` is a WINDOW option, so it needs
  // `-w` and a window-resolving target (the trailing `:` = exact session,
  // active window; the bare `=name` form only resolves sessions).
  // Best-effort; a failure just loses that nicety.
  const remain = await run([
    "tmux",
    "-L",
    TMUX_SOCKET,
    "set-option",
    "-w",
    "-t",
    `=${session}:`,
    "remain-on-exit",
    "on",
  ]);
  if (remain.exitCode !== 0) {
    log.warn("could not set remain-on-exit on dev session", {
      slug: wt.slug,
      stderr: remain.stderr.slice(0, 200),
    });
  }
  log.event.info(`dev server starting on port ${port} (${wt.slug})`);
  return { port, url: devUrl(port) };
}

/**
 * Remove the slug's on-disk supervisor artifacts (marker + script).
 * Called from `createWorktree`'s stale-state reset so a re-created slug
 * can't inherit a dead predecessor's `crashed` marker — the same
 * fresh-start guarantee `clearSlugState` gives the wtstate record.
 */
export function clearDevServerFiles(slug: string): void {
  for (const p of [markerPath(slug), scriptPath(slug)]) {
    try {
      rmSync(p, { force: true });
    } catch {
      // Advisory files; a failed cleanup surfaces as a stale marker at worst.
    }
  }
}

/**
 * Startup sweep: drop marker/script files for slugs that no longer
 * exist, mirroring `reapWtState`/`reapShellLogs` — a destroyed slug's
 * files are otherwise orphaned forever (`clearDevServerFiles` only
 * covers same-slug re-creates). Best-effort.
 */
export function reapDevServerFiles(liveSlugs: ReadonlySet<string>): void {
  let entries: string[];
  try {
    entries = readdirSync(DEV_DIR);
  } catch {
    return; // Dir doesn't exist until the first start — nothing to sweep.
  }
  for (const name of entries) {
    const slug = name.replace(/\.(state|sh)$/, "");
    if (slug === name || liveSlugs.has(slug)) continue;
    try {
      rmSync(join(DEV_DIR, name), { force: true });
    } catch {
      // Best-effort; a leftover file is cosmetic.
    }
  }
}

/** Stop the slug's dev server. Idempotent; the port stays reserved. */
export async function stopDevServer(slug: string): Promise<void> {
  await killByName(sessionName(slug, "dev"));
  try {
    mkdirSync(DEV_DIR, { recursive: true });
    writeFileSync(markerPath(slug), "stopped");
  } catch {
    // Marker is advisory; the killed session already means "not running".
  }
  log.event.info(`dev server stopped (${slug})`);
}

/**
 * Level-derived state: session existence (tmux) + recorded-port
 * liveness (TCP probe) + the supervisor's marker. Cheap and local —
 * safe to poll from a query.
 *
 * `opts.sessionExists`, when provided, skips the per-slug
 * `tmux has-session` spawn — the caller already knows (from the
 * batched `tmuxSessionsQuery`'s `dev` set) whether the session is
 * live. Omit it (CLI callers with no query cache to read) to fall
 * back to the direct tmux check.
 */
export async function devServerStatus(
  slug: string,
  opts: { sessionExists?: boolean } = {},
): Promise<DevServerStatus> {
  if (!config.devServer) return DEV_SERVER_STOPPED;
  const port = readWtState().slugs[slug]?.devPort ?? null;
  const session = sessionName(slug, "dev");
  const has =
    opts.sessionExists !== undefined
      ? opts.sessionExists
      : (await run(["tmux", "-L", TMUX_SOCKET, "has-session", "-t", `=${session}`]))
          .exitCode === 0;
  if (!has) {
    // No session, but a crashed marker survives (e.g. the pane was lost
    // to a tmux server restart): "it crashed the last time it ran" is
    // still the honest state until a start/stop rewrites it.
    if (readMarker(slug) === "crashed") {
      return { running: false, starting: false, crashed: true, port, url: null };
    }
    return { ...DEV_SERVER_STOPPED, port };
  }
  const listening = port !== null && (await portInUse(port));
  if (listening) {
    return { running: true, starting: false, crashed: false, port, url: devUrl(port!) };
  }
  const marker = readMarker(slug);
  if (marker === "crashed") {
    return { running: false, starting: false, crashed: true, port, url: null };
  }
  // Session up, port not answering, not parked: either still booting or
  // a stopped-but-remained pane. The marker disambiguates.
  return {
    running: false,
    starting: marker === "running",
    crashed: false,
    port,
    url: null,
  };
}
