import { config } from "./config.ts";

/**
 * Forward an external `AbortSignal` to a local handler. Returns a
 * cleanup function that removes the listener; the listener itself is
 * `{ once: true }`, so this is a belt-and-suspenders cleanup for the
 * non-aborted-yet case. When `signal` is already aborted on entry the
 * handler fires synchronously and no listener is registered.
 *
 * Exported so callers that chain external signals into per-call
 * controllers (query cancellation, subprocess kill) share one
 * implementation. Without it, the same five-line dance was repeated
 * in two files with subtly different semantics.
 */
export function chainSignal(
  signal: AbortSignal,
  onAbort: () => void,
): () => void {
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * The `timeoutMs` budget fired and the process was SIGKILLed.
   *
   * Whatever had been captured is still returned, and for a command
   * that buffers its output that is NOTHING — which parses as a clean
   * empty result, indistinguishable from a completed scan that found
   * nothing. So any caller reading a command's output as an answer
   * ABOUT THE WORLD has to check this: a timeout on our own clock is
   * not evidence about anything out there. Measured on the destroy
   * reaper's `lsof`, which takes 76ms on an idle box against an 8000ms
   * budget: when the box was loaded enough to blow it, the reaper read
   * the empty stdout as "nothing is listening" and skipped the reap.
   */
  timedOut?: boolean;
};

export type RunOptions = {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /**
   * Optional cancellation signal. When the signal aborts the spawned
   * process is SIGTERM'd; the awaited stdout/stderr drains then unwind
   * and the function resolves with whatever was captured plus the
   * signal-induced exit code. Pass the queryFn's `signal` so a
   * superseded query (worktree list re-keyed, observer unmounted) stops
   * burning a `gh`/`git` invocation in the background.
   */
  signal?: AbortSignal;
};

/**
 * How many `run()` subprocesses may be in flight at once.
 *
 * This is a RENDER-THREAD budget, not a machine one. `Bun.spawn` does
 * its `posix_spawn` synchronously on the calling thread — ~1ms under
 * load — so a burst that issues N spawns in one turn blocks the TUI for
 * N milliseconds before any of them has done any work. Bursts of that
 * size are routine: one `invalidateQueries(["wt"])` fans out to
 * `worktrees × 10` git probes, which was ~280 spawns (and 30% of
 * main-thread self time) in the profile behind the post-sweep stall.
 *
 * With a cap, a waiter resumes on a microtask when a slot frees, so the
 * spawns spread across turns instead of landing in one: the worst
 * synchronous run is the cap, and the render loop gets a turn between
 * waves. The cost is wall-clock on huge bursts, which is the right
 * trade — nobody is watching 280 git probes, they're watching the
 * cursor move. It also stops wt from putting 280 concurrent gits on the
 * disk, which was never a good idea either.
 *
 * There is no deadlock hazard as long as nothing holds a slot while
 * awaiting another `run()`: a slot is held only INSIDE this function,
 * and callers that chain probes await them from outside it.
 */
const RUN_CONCURRENCY = 8;

let runsInFlight = 0;
const runWaiters: Array<() => void> = [];

function acquireRunSlot(): Promise<void> | null {
  if (runsInFlight < RUN_CONCURRENCY) {
    runsInFlight++;
    return null;
  }
  return new Promise<void>((resolve) => runWaiters.push(resolve));
}

/** Hand the slot to the next waiter, or give it back to the pool. */
function releaseRunSlot(): void {
  const next = runWaiters.shift();
  if (next) next();
  else runsInFlight--;
}

/**
 * Run a subprocess, capture stdout/stderr, never throw. Missing
 * binaries and timeouts surface as `exitCode < 0`.
 *
 * Queued behind `RUN_CONCURRENCY`. A call whose signal aborts while it's
 * still waiting never spawns at all — a superseded query stops costing a
 * subprocess instead of spawning one just to SIGTERM it.
 */
export async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { cwd = config.paths.mainClone, input, timeoutMs, env, signal } = opts;
  const queued = acquireRunSlot();
  if (queued) {
    await queued;
    if (signal?.aborted) {
      releaseRunSlot();
      return { stdout: "", stderr: "aborted", exitCode: -1 };
    }
  }
  let proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(argv, {
      cwd,
      stdin: input !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: env ? { ...process.env, ...env } : process.env,
    });
  } catch (err) {
    // Bun.spawn throws SYNCHRONOUSLY on a missing binary / bad cwd; in
    // this async body that becomes a rejected promise, and fire-and-
    // forget callers would die on the unhandled rejection (Bun kills
    // the process). Honor the documented contract instead.
    releaseRunSlot();
    return {
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      exitCode: -1,
    };
  }
  if (input !== undefined && proc.stdin) {
    proc.stdin.write(input);
    proc.stdin.end();
  }

  let timer: Timer | undefined;
  let timedOut = false;
  if (timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
  }

  // Abort plumbing: SIGTERM on signal, but let the drains complete so
  // the caller still gets a structured RunResult instead of an
  // uncaught rejection. If the signal is already aborted, kill
  // immediately (the spawn race window is small but real).
  const cleanupAbort = signal
    ? chainSignal(signal, () => {
        try {
          proc.kill("SIGTERM");
        } catch {
          // proc may already have exited
        }
      })
    : noop;

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, timedOut };
  } finally {
    if (timer) clearTimeout(timer);
    cleanupAbort();
    releaseRunSlot();
  }
}

const noop = (): void => {};

/**
 * Run and return trimmed stdout. Throws on non-zero exit with a
 * message including stderr — matches Python's `subprocess.run(check=True)`.
 */
export async function runOk(argv: string[], opts: RunOptions = {}): Promise<string> {
  const r = await run(argv, opts);
  if (r.exitCode !== 0) {
    const msg = r.stderr.trim() || r.stdout.trim() || `exit ${r.exitCode}`;
    throw new Error(`${argv.join(" ")}: ${msg}`);
  }
  return r.stdout.trimEnd();
}

/** Returns true when the command exits zero. Never throws. */
export async function runQuiet(argv: string[], opts: RunOptions = {}): Promise<boolean> {
  const r = await run(argv, opts);
  return r.exitCode === 0;
}

// Matches CSI (`ESC [ … letter`), OSC (`ESC ] … BEL|ST`), and bare
// two-byte ESC sequences. Enough to scrub the color/cursor noise that
// `pnpm`, `sst`, and friends emit even when stdout isn't a TTY.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/**
 * Strip ANSI escapes, collapse in-place `\r` overwrites to the final
 * visible state, and scrub remaining control characters. Tabs in
 * particular confuse OpenTUI's width calc (it counts 1 cell; the real
 * terminal expands to the next tab stop), which cascades into rows
 * overflowing their allocated height and colliding with siblings.
 */
export function sanitizeLine(line: string): string {
  let s = line.replace(ANSI_RE, "");
  const lastCr = s.lastIndexOf("\r");
  if (lastCr >= 0) s = s.slice(lastCr + 1);
  s = s.replace(/\t/g, " ");
  // Drop remaining C0 / DEL control bytes. LF already split upstream.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return s;
}

/**
 * Drain a ReadableStream of bytes, splitting on newlines and invoking
 * `onLine` for each complete line. Trailing partial-line content is
 * flushed at end-of-stream.
 */
export async function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        onLine(sanitizeLine(buf.slice(0, nl)));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    }
    const tail = buf + decoder.decode();
    if (tail) onLine(sanitizeLine(tail));
  } finally {
    try {
      reader.releaseLock();
    } catch (err) {
      // Lock may already be released if the reader errored out. Safe
      // to ignore — the stream is owned by this function.
      void err;
    }
  }
}

/**
 * Spawn a subprocess, stream stdout+stderr line-by-line through the
 * callback, resolve with the exit code. Lets long-running output surface
 * in the TUI without blocking on `inherit`.
 *
 * `killAfterMs` is the ONE opt-in bound (see the note inside about why
 * `timeoutMs` is otherwise ignored). Absent — every caller but the
 * `[lifecycle] destroy_command` — keeps the original wait-forever
 * behavior exactly.
 */
export async function runStreaming(
  argv: string[],
  opts: RunOptions & { onLine?: (line: string) => void; killAfterMs?: number } = {},
): Promise<number> {
  // Deliberately NOT behind `RUN_CONCURRENCY` either: these run for
  // minutes (pnpm install, sst remove), so a slot held here would starve
  // the short probes the cap exists to keep responsive — the exact
  // inversion of what it's for. One spawn, once, is not the burst
  // problem.
  //
  // Deliberately ignores `timeoutMs`/`signal` from RunOptions: callers
  // are long-running lifecycle ops (pnpm install, sst remove) where a
  // mid-flight kill leaves worse state than waiting. A caller that needs
  // cancellation asks for it explicitly via `killAfterMs` — don't assume
  // the other options work just because the type accepts them.
  const { cwd, env, onLine, killAfterMs } = opts;
  const proc = Bun.spawn(argv, {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: env ? { ...process.env, ...env } : process.env,
  });
  const emit = onLine ?? (() => {});
  // Kill on the deadline rather than abandoning the wait: resolving
  // early would leave the child streaming into a callback whose caller
  // has moved on (for destroy, into a worktree it is about to delete).
  const timer =
    killAfterMs !== undefined && killAfterMs > 0
      ? setTimeout(() => {
          emit(`timed out after ${Math.round(killAfterMs / 1000)}s — killing`);
          proc.kill("SIGKILL");
        }, killAfterMs)
      : null;
  try {
    await Promise.all([
      streamLines(proc.stdout, emit),
      streamLines(proc.stderr, emit),
    ]);
    return await proc.exited;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
