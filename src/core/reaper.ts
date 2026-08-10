/**
 * Destroy-time process reaper — the leak stopper for servers agents
 * start by hand.
 *
 * wt manages exactly one long-lived process per worktree (the
 * `[dev_server]`); everything else an agent runs — `pnpm preview`, a
 * watch-mode test runner, a tunnel — is deliberately unmanaged, scoped
 * to the agent's session by convention. The leak happens when that
 * convention fails: a backgrounded preview server survives its session,
 * outlives the worktree, and sits on a port for hours after the branch
 * merged (observed in the wild: a vite server still serving an archived
 * worktree five hours later).
 *
 * Rather than teach agents a prefix ritual for every process, destroy
 * sweeps for them: any process HOLDING A LISTENING TCP SOCKET whose cwd
 * is inside the worktree dies with it. The listening-socket filter is
 * the safety boundary — an editor, a shell, or a stopped build sitting
 * in the directory holds no socket and is never touched. Killing only
 * the listener is also enough for the common `pnpm preview` shape: the
 * pnpm parent is just waiting on the vite child and exits when it dies.
 *
 * Best-effort throughout, like `core/browser.ts`: no lsof, an lsof
 * hiccup, or nothing listening (the common case) all mean "nothing to
 * reap", never a failed destroy.
 */
import { config } from "./config.ts";
import { createLogger } from "./logger.ts";
import { run } from "./proc.ts";

const log = createLogger("[reaper]");

export type ReapedProcess = {
  pid: number;
  command: string;
  /** Listening ports, for the destroy-log line. */
  ports: number[];
};

/**
 * Parse `lsof -Fpcn` LISTEN output into one record per pid. Field
 * lines: `p<pid>` starts a process, `c<command>` names it, `n<addr>`
 * is one listening socket (`*:4199`, `127.0.0.1:8103`, `[::1]:3000`).
 */
export function parseListeners(out: string): ReapedProcess[] {
  const byPid = new Map<number, ReapedProcess>();
  let current: ReapedProcess | null = null;
  for (const line of out.split("\n")) {
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === "p") {
      const pid = Number(rest);
      if (!Number.isInteger(pid) || pid <= 0) {
        current = null;
        continue;
      }
      current = byPid.get(pid) ?? { pid, command: "", ports: [] };
      byPid.set(pid, current);
    } else if (tag === "c" && current) {
      current.command = rest;
    } else if (tag === "n" && current) {
      const port = Number(rest.slice(rest.lastIndexOf(":") + 1));
      if (Number.isInteger(port) && port > 0 && !current.ports.includes(port)) {
        current.ports.push(port);
      }
    }
  }
  return [...byPid.values()];
}

/** Parse `lsof -a -p … -d cwd -Fpn` output into pid → cwd. */
export function parseCwdMap(out: string): Map<number, string> {
  const map = new Map<number, string>();
  let pid: number | null = null;
  for (const line of out.split("\n")) {
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === "p") {
      const n = Number(rest);
      pid = Number.isInteger(n) && n > 0 ? n : null;
    } else if (tag === "n" && pid !== null) {
      map.set(pid, rest);
    }
  }
  return map;
}

/** Path containment with a component boundary: `/wt/foo` never claims `/wt/foobar`. */
export function isUnderPath(cwd: string, root: string): boolean {
  const r = root.endsWith("/") ? root.slice(0, -1) : root;
  return cwd === r || cwd.startsWith(`${r}/`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill every process listening on a TCP port from inside `wtPath`.
 * SIGTERM first (vite/node shut down cleanly and release the port),
 * SIGKILL whatever ignores it. Returns what was reaped, for the
 * destroy log; empty on any failure.
 */
export async function reapWorktreeListeners(wtPath: string): Promise<ReapedProcess[]> {
  try {
    // A killer keyed on path containment earns paranoia about its root:
    // never sweep from the main clone (a preview server there is the
    // human's), and never from a path short enough to be a mistake.
    if (wtPath === config.paths.mainClone || wtPath.split("/").length < 3) return [];
    if (!Bun.which("lsof")) return [];

    // Explicit cwd: `run()` defaults to the main clone, and a destroy
    // must not depend on that directory existing (it also doesn't on
    // CI's synthetic config, where the default cwd made this spawn
    // throw and the reaper silently no-op).
    const listeners = await run(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], {
      cwd: "/",
      timeoutMs: 8000,
    });
    // lsof exits 1 for "no matches" (and for harmless per-fd warnings)
    // while still printing what it found — parse stdout, ignore the code.
    const all = parseListeners(listeners.stdout).filter(
      (p) => p.pid !== process.pid && p.pid !== process.ppid,
    );
    if (all.length === 0) return [];

    const cwds = await run(
      ["lsof", "-a", "-p", all.map((p) => p.pid).join(","), "-d", "cwd", "-Fpn"],
      { cwd: "/", timeoutMs: 8000 },
    );
    const cwdByPid = parseCwdMap(cwds.stdout);
    const mine = all.filter((p) => {
      const cwd = cwdByPid.get(p.pid);
      return cwd !== undefined && isUnderPath(cwd, wtPath);
    });
    if (mine.length === 0) return [];

    for (const p of mine) {
      try {
        process.kill(p.pid, "SIGTERM");
      } catch {
        // Already gone between the scan and now — fine.
      }
    }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && mine.some((p) => alive(p.pid))) {
      await Bun.sleep(100);
    }
    for (const p of mine) {
      if (alive(p.pid)) {
        try {
          process.kill(p.pid, "SIGKILL");
        } catch {
          // Raced its own exit; the goal state is reached either way.
        }
      }
    }
    log.info("reaped worktree listeners", {
      path: wtPath,
      reaped: mine.map((p) => `${p.command}:${p.pid} [${p.ports.join(",")}]`),
    });
    return mine;
  } catch (err) {
    log.debug("listener reap skipped", {
      path: wtPath,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
