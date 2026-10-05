import type { AsyncStorage } from "@tanstack/query-persist-client-core";
import { Effect } from "effect";

import { createLogger } from "../core/logger.ts";
import { operationErrors } from "../core/errors.ts";
import type {
  CacheRequest,
  CacheResult,
  CacheValue,
} from "./persister-protocol.ts";

const log = createLogger("[cache]");
const io = operationErrors("query cache");
const CLOSE_TIMEOUT_MS = 2_000;
const MAX_PENDING = 256;

/** AsyncStorage backed by a worker-owned SQLite connection. */
export type AsyncStorageDb = AsyncStorage<string> & {
  entries: () => Promise<Array<[string, string]>>;
  close: () => Promise<void>;
};

type Pending = {
  resolve: (value: CacheValue) => void;
  fallback: CacheValue;
};

type CacheWorker = Worker & {
  postMessage(message: CacheRequest): void;
};

/**
 * Wipe persisted query data through the same off-thread SQLite boundary as
 * ordinary cache reads and writes. A missing database is a successful no-op.
 */
export const clearPersistedCache = Effect.fn("clearPersistedCache")((dbPath: string): Effect.Effect<void> =>
  Effect.acquireUseRelease(
    Effect.sync(() => new CacheStorageWorker(dbPath)),
    (worker) => io.promise("clear", () => worker.clear()),
    (worker) => Effect.promise(() => worker.close()),
  ).pipe(
    Effect.catch((err) =>
      Effect.sync(() => {
        log.error(err instanceof Error ? err : String(err), { dbPath });
      }),
    ),
  ),
);

class CacheStorageWorker {
  private worker: CacheWorker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private closing: Promise<void> | null = null;

  constructor(private readonly dbPath: string) {}

  get(key: string): Promise<string | null> {
    return this.request("get", null, key) as Promise<string | null>;
  }

  set(key: string, value: string): Promise<void> {
    return this.request("set", undefined, key, value) as Promise<void>;
  }

  remove(key: string): Promise<void> {
    return this.request("remove", undefined, key) as Promise<void>;
  }

  entries(): Promise<Array<[string, string]>> {
    return this.request("entries", [] as Array<[string, string]>) as Promise<
      Array<[string, string]>
    >;
  }

  clear(): Promise<void> {
    return this.request("clear", undefined) as Promise<void>;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    if (!this.worker) return Promise.resolve();
    const worker = this.worker;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = Promise.withResolvers<boolean>();
    timer = setTimeout(() => timeout.resolve(false), CLOSE_TIMEOUT_MS);
    const closeRequest = this.request(
      "close",
      undefined,
      undefined,
      undefined,
      true,
    ).then(() => true);
    this.closing = Promise.race([closeRequest, timeout.promise]).then((closed) => {
      if (timer !== undefined) clearTimeout(timer);
      if (!closed) this.failWorker("shutdown timed out", worker);
      if (this.worker === worker) {
        worker.terminate();
        this.worker = null;
      }
    });
    return this.closing;
  }

  private request<T extends CacheValue>(
    type: CacheRequest["type"],
    fallback: T,
    key?: string,
    value?: string,
    allowClosing = false,
  ): Promise<T> {
    if (this.closed && !allowClosing) return Promise.resolve(fallback);
    // A busy disk must not turn disposable cache writes into an unbounded
    // message backlog. Shutdown still gets its ordered close request.
    if (!allowClosing && this.pending.size >= MAX_PENDING) return Promise.resolve(fallback);
    const id = this.nextId++;
    const result = Promise.withResolvers<T>();
    const pending: Pending = {
      resolve: (value) => result.resolve(value as T),
      fallback,
    };
    this.pending.set(id, pending);
    try {
      const worker = this.ensureWorker();
      worker.postMessage({ type, id, dbPath: this.dbPath, key, value });
    } catch (err) {
      this.failWorker(
        err instanceof Error ? err.message : String(err),
        this.worker ?? undefined,
      );
    }
    return result.promise;
  }

  private ensureWorker(): CacheWorker {
    if (this.worker) return this.worker;
    const worker = new Worker(
      new URL("./persister-worker.ts", import.meta.url).href,
    ) as CacheWorker;
    worker.addEventListener("message", (event: MessageEvent<CacheResult>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      if (event.data.type === "error") {
        log.warn(`cache ${event.data.operation} failed`, {
          err: event.data.message,
        });
        pending.resolve(pending.fallback);
      } else {
        pending.resolve(event.data.value);
      }
    });
    worker.addEventListener("error", (event) => {
      this.failWorker(event.message || "worker error", worker);
    });
    worker.addEventListener("close", () =>
      this.failWorker("worker exited", worker),
    );
    worker.unref?.();
    this.worker = worker;
    return worker;
  }

  private failWorker(reason: string, failed = this.worker): void {
    // Late events from a terminated worker must not tear down its replacement.
    if (failed && this.worker !== failed) return;
    this.worker = null;
    try {
      failed?.terminate();
    } catch {
      // Worker already exited.
    }
    if (this.pending.size === 0) return;
    log.warn("cache worker unavailable", { err: reason });
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.resolve(pending.fallback);
    }
  }
}

// Kept as a plain constructor: SQLite initialization happens lazily inside
// the worker, never on the TUI thread.
export function createSqliteAsyncStorage(dbPath: string): AsyncStorageDb {
  const storage = new CacheStorageWorker(dbPath);
  return {
    getItem: (key) => storage.get(key),
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.remove(key),
    entries: () => storage.entries(),
    close: () => storage.close(),
  };
}
