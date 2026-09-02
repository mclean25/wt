import { Data, Effect, Exit, Ref, Scope, Semaphore } from "effect";

import { config } from "./config.ts";

/** Forward an external AbortSignal to a local handler. */
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
  /** The `timeoutMs` budget fired and the process was SIGKILLed. */
  timedOut?: boolean;
};

export type RunOptions = {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /** Compatibility cancellation for Promise/TanStack callers. */
  signal?: AbortSignal;
};

/** Streaming deliberately has no `signal` or `timeoutMs` compatibility fields. */
export type RunStreamingOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  onLine?: (line: string) => void;
  /** Opt-in lifecycle deadline. The child is killed and fully joined. */
  killAfterMs?: number;
};

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export class ProcSpawnError extends Data.TaggedError("ProcSpawnError")<{
  readonly argv: readonly string[];
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.argv.join(" ")}: ${errorMessage(this.cause)}`;
  }
}

export class ProcReadError extends Data.TaggedError("ProcReadError")<{
  readonly argv: readonly string[];
  readonly stream: "stdout" | "stderr" | "stdin";
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.argv.join(" ")} (${this.stream}): ${errorMessage(this.cause)}`;
  }
}

export class ProcNonZeroExitError extends Data.TaggedError(
  "ProcNonZeroExitError",
)<{
  readonly argv: readonly string[];
  readonly result: RunResult;
}> {
  override get message(): string {
    const detail =
      this.result.stderr.trim() ||
      this.result.stdout.trim() ||
      `exit ${this.result.exitCode}`;
    return `${this.argv.join(" ")}: ${detail}`;
  }
}

export class ProcTimeoutError extends Data.TaggedError("ProcTimeoutError")<{
  readonly argv: readonly string[];
  readonly timeoutMs: number;
  readonly result: RunResult;
}> {
  override get message(): string {
    return `${this.argv.join(" ")}: timed out after ${this.timeoutMs}ms`;
  }
}

export class ProcInterruptedError extends Data.TaggedError(
  "ProcInterruptedError",
)<{
  readonly argv: readonly string[];
}> {
  override get message(): string {
    return `${this.argv.join(" ")}: aborted`;
  }
}

export type ProcError =
  | ProcSpawnError
  | ProcReadError
  | ProcNonZeroExitError
  | ProcTimeoutError
  | ProcInterruptedError;

const RUN_CONCURRENCY = 8;
const TERMINATION_GRACE_MS = 1_000;
const runSemaphore = Semaphore.makeUnsafe(RUN_CONCURRENCY);

type CapturedProcess = {
  readonly proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  readonly stdout: PromiseSettledResult<string>;
  readonly stderr: PromiseSettledResult<string>;
  readonly exited: PromiseSettledResult<number>;
};

type RunningProcess = {
  readonly proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  readonly settled: Promise<CapturedProcess>;
};

type KillableProcess = {
  readonly exitCode: number | null;
  kill(signal?: number | NodeJS.Signals): void;
};

/**
 * Terminate an inherited-stdio child without allowing scope shutdown to
 * wait forever. Interactive handoffs cannot use the captured-process runner,
 * but they need the same TERM, bounded grace, KILL, join contract.
 */
export const terminateSubprocess = Effect.fn("terminateSubprocess")(function* (
  proc: KillableProcess & { readonly exited: Promise<number> },
  graceMs = TERMINATION_GRACE_MS,
) {
  const joined = Effect.promise(() => proc.exited.then(() => undefined, () => undefined));
  if (proc.exitCode !== null) return;
  killProcess(proc, "SIGTERM");
  const graceful = yield* joined.pipe(Effect.timeoutOption(graceMs));
  if (graceful._tag === "Some") return;
  killProcess(proc, "SIGKILL");
  yield* joined;
});

function killProcess(proc: KillableProcess, signal: NodeJS.Signals): void {
  if (proc.exitCode !== null) return;
  try {
    proc.kill(signal);
  } catch {
    // A process may exit between the exitCode check and kill.
  }
}

function killProcessGroup(
  proc: KillableProcess & { readonly pid: number },
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    killProcess(proc, signal);
  }
}

const spawnCaptured = Effect.fnUntraced(function* (
  argv: readonly string[],
  opts: Pick<RunOptions, "cwd" | "env" | "input">,
): Effect.fn.Return<RunningProcess, ProcSpawnError> {
    const proc = yield* Effect.try({
      try: () =>
        Bun.spawn([...argv], {
          cwd: opts.cwd,
          stdin: opts.input !== undefined ? "pipe" : "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: opts.env ? { ...process.env, ...opts.env } : process.env,
          detached: true,
        }),
      catch: (cause) => new ProcSpawnError({ argv, cause }),
    });

    const stdoutPromise = new Response(proc.stdout).text().catch((cause) => {
      killProcessGroup(proc, "SIGTERM");
      throw cause;
    });
    const stderrPromise = new Response(proc.stderr).text().catch((cause) => {
      killProcessGroup(proc, "SIGTERM");
      throw cause;
    });
    const exitedPromise = proc.exited;
    const settled = Promise.allSettled([
      stdoutPromise,
      stderrPromise,
      exitedPromise,
    ]).then(([stdout, stderr, exited]) => ({ proc, stdout, stderr, exited }));

    return { proc, settled };
});

function writeInput(
  argv: readonly string[],
  running: RunningProcess,
  input: string | undefined,
): Effect.Effect<void, ProcReadError> {
  if (input === undefined || !running.proc.stdin) return Effect.void;
  const stdin = running.proc.stdin;
  return Effect.try({
    try: () => {
      stdin.write(input);
      stdin.end();
    },
    catch: (cause) => new ProcReadError({ argv, stream: "stdin", cause }),
  });
}

const awaitCaptured = (running: RunningProcess) =>
  Effect.promise(() => running.settled).pipe(Effect.asVoid);

const terminateCaptured = Effect.fnUntraced(function* (running: RunningProcess) {
  killProcessGroup(running.proc, "SIGTERM");
  const graceful = yield* Effect.interruptible(awaitCaptured(running)).pipe(
    Effect.timeoutOption(TERMINATION_GRACE_MS),
  );
  if (graceful._tag === "None") {
    killProcessGroup(running.proc, "SIGKILL");
    yield* awaitCaptured(running);
  }
});

function joinCaptured(
  argv: readonly string[],
  running: RunningProcess,
): Effect.Effect<CapturedProcess, ProcReadError> {
  return Effect.callback<CapturedProcess, ProcReadError>((resume, signal) => {
    const onAbort = () => killProcessGroup(running.proc, "SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });
    void running.settled.then((captured) => {
      signal.removeEventListener("abort", onAbort);
      if (captured.stdout.status === "rejected") {
        resume(
          Effect.fail(
            new ProcReadError({
              argv,
              stream: "stdout",
              cause: captured.stdout.reason,
            }),
          ),
        );
      } else if (captured.stderr.status === "rejected") {
        resume(
          Effect.fail(
            new ProcReadError({
              argv,
              stream: "stderr",
              cause: captured.stderr.reason,
            }),
          ),
        );
      } else if (captured.exited.status === "rejected") {
        resume(
          Effect.fail(
            new ProcReadError({
              argv,
              stream: "stderr",
              cause: captured.exited.reason,
            }),
          ),
        );
      } else {
        resume(Effect.succeed(captured));
      }
    });

    // Effect runs this cleanup uninterruptibly. Kill first, then join all
    // stream drains and the child before the semaphore permit is released.
    return terminateCaptured(running);
  });
}

const releaseCaptured = (
  running: RunningProcess,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<void> =>
  Exit.isSuccess(exit) ? awaitCaptured(running) : terminateCaptured(running);

function externalInterruption(
  argv: readonly string[],
  signal: AbortSignal,
): Effect.Effect<never, ProcInterruptedError> {
  return Effect.callback<never, ProcInterruptedError>((resume) => {
    const abort = () => resume(Effect.fail(new ProcInterruptedError({ argv })));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", abort));
  });
}

const capturedRunEffect = Effect.fnUntraced(function* (
  argv: readonly string[],
  opts: RunOptions,
): Effect.fn.Return<RunResult, ProcSpawnError | ProcReadError | ProcInterruptedError, Scope.Scope> {
  const cwd = opts.cwd ?? config.paths.mainClone;
  if (opts.signal?.aborted) {
    return yield* new ProcInterruptedError({ argv });
  }
  const running = yield* Effect.acquireRelease(
    spawnCaptured(argv, { cwd, env: opts.env, input: opts.input }),
    releaseCaptured,
  );
  yield* writeInput(argv, running, opts.input);
  if (opts.signal) {
    // AbortSignal is the compatibility boundary used by Promise callers.
    // After spawn, preserve their captured partial output as a nonzero
    // RunResult; native Effect callers interrupt the fiber itself and the
    // scoped finalizer kills and joins the child before interruption ends.
    yield* Effect.forkScoped(
      externalInterruption(argv, opts.signal).pipe(
        Effect.catch(() => terminateCaptured(running)),
      ),
    );
  }
  const timedOut = yield* Ref.make(false);
  if (opts.timeoutMs !== undefined && opts.timeoutMs > 0) {
    yield* Effect.forkScoped(
      Effect.sleep(opts.timeoutMs).pipe(
        Effect.andThen(Ref.set(timedOut, true)),
        Effect.andThen(
          Effect.sync(() => killProcessGroup(running.proc, "SIGKILL")),
        ),
      ),
    );
  }
  const captured = yield* joinCaptured(argv, running);
  const didTimeOut = yield* Ref.get(timedOut);
  return {
    stdout:
      captured.stdout.status === "fulfilled" ? captured.stdout.value : "",
    stderr:
      captured.stderr.status === "fulfilled" ? captured.stderr.value : "",
    exitCode:
      captured.exited.status === "fulfilled" ? captured.exited.value : -1,
    timedOut: didTimeOut,
  };
}, Effect.scoped);

/** Effect-native captured subprocess execution. */
export function run(
  argv: readonly string[],
  opts: RunOptions = {},
): Effect.Effect<
  RunResult,
  ProcSpawnError | ProcReadError | ProcInterruptedError
> {
  const acquirePermit = opts.signal
    ? Effect.raceFirst(
        runSemaphore.take(1),
        externalInterruption(argv, opts.signal),
      )
    : runSemaphore.take(1);
  // Match Semaphore.withPermits' masked acquire/use/release shape while racing
  // only queued acquisition against an external AbortSignal. A cancelled take
  // leaves Effect's waiter set, and a successful take cannot be interrupted in
  // the gap before its release finalizer is installed.
  return Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(restore(acquirePermit), (permits) =>
      Effect.ensuring(
        restore(capturedRunEffect(argv, opts)),
        runSemaphore.release(permits),
      ),
    ),
  );
}

/** Run and return trimmed stdout, failing with the precise expected cause. */
export function runOk(
  argv: readonly string[],
  opts: RunOptions = {},
): Effect.Effect<string, ProcError> {
  return run(argv, opts).pipe(
    Effect.flatMap(
      (
        result,
      ): Effect.Effect<string, ProcTimeoutError | ProcNonZeroExitError> => {
        if (result.timedOut) {
          return Effect.fail(
            new ProcTimeoutError({
              argv,
              timeoutMs: opts.timeoutMs ?? 0,
              result,
            }),
          );
        }
        if (result.exitCode !== 0) {
          return Effect.fail(new ProcNonZeroExitError({ argv, result }));
        }
        return Effect.succeed(result.stdout.trimEnd());
      },
    ),
  );
}

/** Returns true when the command exits zero. */
export function runQuiet(
  argv: readonly string[],
  opts: RunOptions = {},
): Effect.Effect<
  boolean,
  ProcSpawnError | ProcReadError | ProcInterruptedError
> {
  return run(argv, opts).pipe(
    Effect.map((result) => result.exitCode === 0),
  );
}

function failedRunResult(
  error: ProcSpawnError | ProcReadError | ProcInterruptedError,
): RunResult {
  return { stdout: "", stderr: error.message, exitCode: -1 };
}

/** Compatibility boundary. Captures every expected failure as a RunResult. */
export function runPromise(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  return Effect.runPromise(
    run(argv, opts).pipe(
      Effect.catch((error) => Effect.succeed(failedRunResult(error))),
    ),
  );
}

/** Compatibility boundary for callers not yet migrated to Effect. */
export function runOkPromise(argv: string[], opts: RunOptions = {}): Promise<string> {
  return Effect.runPromise(runOk(argv, opts));
}

/** Compatibility boundary for callers not yet migrated to Effect. */
export function runQuietPromise(
  argv: string[],
  opts: RunOptions = {},
): Promise<boolean> {
  return Effect.runPromise(
    runQuiet(argv, opts).pipe(
      Effect.catch(() => Effect.succeed(false)),
    ),
  );
}

// eslint-disable-next-line no-control-regex
const ANSI_RE =
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function sanitizeLine(line: string): string {
  let value = line.replace(ANSI_RE, "");
  const lastCr = value.lastIndexOf("\r");
  if (lastCr >= 0) value = value.slice(lastCr + 1);
  value = value.replace(/\t/g, " ");
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

/** Effect-native, interruptible line drain with scoped reader cancellation. */
export function streamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Effect.Effect<void, ProcReadError> {
  const argv = ["<stream>"] as const;
  return Effect.acquireUseRelease(
    Effect.sync(() => stream.getReader()),
    (reader) =>
      Effect.gen(function* () {
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const chunk = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: (cause) =>
              new ProcReadError({ argv, stream: "stdout", cause }),
          });
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = sanitizeLine(buffer.slice(0, newline));
            yield* Effect.try({
              try: () => onLine(line),
              catch: (cause) =>
                new ProcReadError({ argv, stream: "stdout", cause }),
            });
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
          }
        }
        const tail = buffer + decoder.decode();
        if (tail) {
          yield* Effect.try({
            try: () => onLine(sanitizeLine(tail)),
            catch: (cause) =>
              new ProcReadError({ argv, stream: "stdout", cause }),
          });
        }
      }),
    (reader) =>
      Effect.promise(async () => {
        try {
          await reader.cancel();
        } catch {
          // The process may already have closed the stream.
        }
        try {
          reader.releaseLock();
        } catch {
          // The lock may already have been released after a read failure.
        }
      }),
  );
}

/** Compatibility boundary for non-Effect stream consumers. */
export function streamLinesPromise(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  return Effect.runPromise(streamLines(stream, onLine));
}

type StreamingProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

const awaitStreaming = (proc: StreamingProcess) =>
  Effect.promise(() => proc.exited).pipe(Effect.asVoid);

const terminateStreaming = Effect.fnUntraced(function* (proc: StreamingProcess) {
  killProcessGroup(proc, "SIGTERM");
  const graceful = yield* Effect.interruptible(awaitStreaming(proc)).pipe(
    Effect.timeoutOption(TERMINATION_GRACE_MS),
  );
  if (graceful._tag === "None") {
    killProcessGroup(proc, "SIGKILL");
    yield* awaitStreaming(proc);
  }
});

const releaseStreaming = (
  proc: StreamingProcess,
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<void> =>
  Exit.isSuccess(exit) ? awaitStreaming(proc) : terminateStreaming(proc);

/** Effect-native streaming subprocess execution. */
export const runStreaming = Effect.fn("runStreaming")(function* (
  argv: readonly string[],
  opts: RunStreamingOptions = {},
): Effect.fn.Return<number, ProcSpawnError | ProcReadError, Scope.Scope> {
  const emit = opts.onLine ?? (() => {});
  const proc = yield* Effect.acquireRelease(
    Effect.try({
      try: () =>
        Bun.spawn([...argv], {
          cwd: opts.cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: opts.env ? { ...process.env, ...opts.env } : process.env,
          detached: true,
        }),
      catch: (cause) => new ProcSpawnError({ argv, cause }),
    }),
    releaseStreaming,
  );

  if (opts.killAfterMs !== undefined && opts.killAfterMs > 0) {
    yield* Effect.forkScoped(
      Effect.interruptible(
        Effect.sleep(opts.killAfterMs).pipe(
          Effect.andThen(
            Effect.sync(() => {
              emit(
                `timed out after ${Math.round(opts.killAfterMs! / 1000)}s — killing`,
              );
              killProcessGroup(proc, "SIGKILL");
            }),
          ),
        ),
      ),
    );
  }

  const [exitCode] = yield* Effect.all(
    [
      Effect.tryPromise({
        try: () => proc.exited,
        catch: (cause) =>
          new ProcReadError({ argv, stream: "stderr", cause }),
      }),
      streamLines(proc.stdout, emit),
      streamLines(proc.stderr, emit),
    ],
    { concurrency: "unbounded" },
  );
  return exitCode;
}, Effect.scoped);
