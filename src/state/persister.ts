import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

import type { AsyncStorage } from "@tanstack/query-persist-client-core";
import { Effect } from "effect";

import { createLogger } from "../core/logger.ts";

const log = createLogger("[cache]");

/**
 * Per-query SQLite storage for `experimental_createQueryPersister`.
 * Each cached query becomes one row keyed by `<prefix>-<queryHash>`.
 * Replaced the prior whole-blob persister, which re-serialised the
 * entire dehydrated client on every change — fine when the cache was
 * a few kB, but per-query reads/writes scale better as the cache fills
 * with AI summaries (each up to a few hundred bytes; one row each).
 *
 * `bun:sqlite` is synchronous and fast; the AsyncStorage interface
 * permits sync return values via `MaybePromise`. We return them
 * synchronously so first-paint pre-warm doesn't pay an extra event-
 * loop tick per restored query.
 */

/**
 * Concrete shape returned by `createSqliteAsyncStorage`. Conforms to
 * the library's `AsyncStorage<string>` so the persister boundary
 * type-checks structurally — a future minor bump that narrows
 * `AsyncStorage` will surface here at the storage definition rather
 * than as a silent shape mismatch deep in the persister.
 */
export type AsyncStorageDb = AsyncStorage<string> & {
  /** Required (not optional) so `restoreQueries` pre-warm works. */
  entries: () => Array<[string, string]>;
  close: () => void;
};

/**
 * Stateless helper to wipe the persisted cache without holding a
 * long-lived handle. Used by the TUI's "clear all data" action; it
 * opens a short-lived connection, truncates, closes. Handles the
 * "db never created" case via `existsSync`.
 */
export function clearPersistedCache(dbPath: string): void {
  Effect.runSync(
    Effect.suspend(() => {
      if (!existsSync(dbPath)) return Effect.void;
      return Effect.acquireUseRelease(
        Effect.sync(
          // bun:sqlite requires at least one of READONLY / READWRITE when any
          // options are passed; we set `readwrite: true` explicitly. We
          // already gated on existsSync so `create: false` is safe.
          () => new Database(dbPath, { readwrite: true, create: false }),
        ),
        (db) =>
          Effect.try(() => db.exec("DELETE FROM cache")).pipe(
            Effect.catch((err) =>
              Effect.sync(() => {
                // Schema drift between versions shouldn't crash the action.
                log.error(err instanceof Error ? err : String(err), { dbPath });
              }),
            ),
          ),
        (db) => Effect.sync(() => db.close()),
      );
    }),
  );
}

export function createSqliteAsyncStorage(dbPath: string): AsyncStorageDb {
  return Effect.runSync(
    Effect.sync(() => {
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new Database(dbPath, { create: true });
      // Two wt instances briefly coexist more often than it seems (a
      // restart overlapping the old process, a scratch TUI next to the
      // real one). WAL lets a reader and a writer coexist, and the busy
      // timeout absorbs write-write collisions instead of throwing
      // SQLITE_BUSY out of the persister mid-render.
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA busy_timeout = 1500;");
      db.exec(`
    CREATE TABLE IF NOT EXISTS cache (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

      const readStmt = db.query<{ data: string }, [string]>(
        "SELECT data FROM cache WHERE id = ? LIMIT 1",
      );
      const writeStmt = db.prepare(
        "INSERT OR REPLACE INTO cache (id, data, updated_at) VALUES (?, ?, ?)",
      );
      const deleteStmt = db.prepare("DELETE FROM cache WHERE id = ?");
      const entriesStmt = db.query<{ id: string; data: string }, []>(
        "SELECT id, data FROM cache",
      );

      // The query persister schedules its `setItem` writes via
      // `notifyManager.schedule` (`setTimeout(0)`), which means a queryFn
      // that resolves just before shutdown can fire its persist callback
      // *after* `close()` has run — and bun:sqlite throws on any operation
      // against a closed handle. Every storage call gates on this flag and
      // becomes a no-op once shutdown has started.
      let closed = false;

      // Cache persistence is best-effort by definition — a failed write
      // costs one cold query on the next boot, while an uncaught throw
      // here surfaces as a raw stack trace painted over the TUI (the
      // persister invokes storage outside any React error boundary). Log
      // file-only and move on.
      function swallow<T>(op: string, fallback: T, fn: () => T): T {
        return Effect.runSync(
          Effect.try(fn).pipe(
            Effect.catch((err) =>
              Effect.sync(() => {
                log.warn(`cache ${op} failed`, {
                  err: err instanceof Error ? err.message : String(err),
                });
                return fallback;
              }),
            ),
          ),
        );
      }

      return {
        getItem(key) {
          if (closed) return null;
          return swallow("read", null, () => {
            const row = readStmt.get(key);
            return row ? row.data : null;
          });
        },
        setItem(key, value) {
          if (closed) return;
          swallow("write", undefined, () => {
            writeStmt.run(key, value, Date.now());
          });
        },
        removeItem(key) {
          if (closed) return;
          swallow("delete", undefined, () => {
            deleteStmt.run(key);
          });
        },
        entries() {
          if (closed) return [];
          return swallow("scan", [] as Array<[string, string]>, () =>
            entriesStmt.all().map((r) => [r.id, r.data] as [string, string]),
          );
        },
        close() {
          if (closed) return;
          closed = true;
          db.close();
        },
      };
    }),
  );
}
