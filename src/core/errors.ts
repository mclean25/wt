/**
 * Shared error helpers. Leaf module: no config, no I/O, so anything
 * (including the config-free update/rollback path) can import it.
 */

/** Human-readable text for an arbitrary thrown/failed value. */
export function causeMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name;
  if (typeof cause === "string") return cause;
  if (cause !== null && typeof cause === "object" && "message" in cause && typeof cause.message === "string") {
    return cause.message;
  }
  return String(cause);
}
