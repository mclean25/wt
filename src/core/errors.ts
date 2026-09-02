/**
 * Shared error helpers. Leaf module: no config, no I/O, so anything
 * (including the config-free update/rollback path) can import it.
 */
import { Data, Effect } from "effect";

/** Human-readable text for an arbitrary thrown/failed value. */
export function causeMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name;
  if (typeof cause === "string") return cause;
  if (cause !== null && typeof cause === "object" && "message" in cause && typeof cause.message === "string") {
    return cause.message;
  }
  return String(cause);
}

/**
 * The one wrapper for code that crosses an untyped boundary — a sync
 * call that may throw, a Promise API, a dynamic `import()`. `source`
 * names the module or command, `operation` the step; the message reads
 * `operation: cause` so a boundary renderer never prints a bare tag.
 *
 * Domain failures with fields consumers match on (`GitError`,
 * `ProcError`, `GithubFetchError`, ...) stay their own tagged classes.
 * This exists so a boundary does not mint a per-file `XCommandError` /
 * `XFlowError` / `XQueryError` that nothing ever matches by tag.
 */
export class OperationError extends Data.TaggedError("OperationError")<{
  readonly source: string;
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.operation}: ${causeMessage(this.cause)}`;
  }
}

export interface OperationErrors {
  /** `Effect.mapError` / `catch` callback that tags a failure. */
  readonly wrap: (operation: string) => (cause: unknown) => OperationError;
  /** Run a synchronous, possibly-throwing computation. */
  readonly sync: <A>(operation: string, evaluate: () => A) => Effect.Effect<A, OperationError>;
  /** Adopt a Promise API. Interruption aborts the signal. */
  readonly promise: <A>(
    operation: string,
    evaluate: (signal: AbortSignal) => PromiseLike<A>,
  ) => Effect.Effect<A, OperationError>;
}

/** Per-module boundary helpers: `const io = operationErrors("wt rm")`. */
export function operationErrors(source: string): OperationErrors {
  const wrap = (operation: string) => (cause: unknown) =>
    new OperationError({ source, operation, cause });
  return {
    wrap,
    sync: (operation, evaluate) => Effect.try({ try: evaluate, catch: wrap(operation) }),
    promise: (operation, evaluate) => Effect.tryPromise({ try: evaluate, catch: wrap(operation) }),
  };
}
