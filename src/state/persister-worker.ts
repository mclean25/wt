/** Owns all disposable query-cache SQLite access off the TUI thread. */
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

import type { CacheRequest, CacheResult, CacheValue } from "./persister-protocol.ts";

declare var self: Worker;

let dbPath: string | null = null;
let db: Database | null = null;

function open(path: string): Database {
  if (db && dbPath === path) return db;
  if (db) db.close();
  db = null;
  dbPath = null;
  mkdirSync(dirname(path), { recursive: true });
  const next = new Database(path, { create: true });
  try {
    // Opening or switching journal mode also takes SQLite locks. Install
    // the bounded wait before initialization so a closing/checkpointing
    // connection cannot turn the first read into an immediate cache miss.
    next.exec("PRAGMA busy_timeout = 1500;");
    next.exec("PRAGMA journal_mode = WAL;");
    next.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  } catch (err) {
    // Initialization is deliberately best-effort; do not leak a partially
    // initialized handle after returning the error to the caller.
    try {
      next.close();
    } catch {
      // Already closed.
    }
    throw err;
  }
  dbPath = path;
  db = next;
  return next;
}

function reply(message: CacheResult): void {
  postMessage(message);
}

self.onmessage = (event: MessageEvent<CacheRequest>) => {
  const request = event.data;
  try {
    let value: CacheValue;
    if (request.type === "clear") {
      // Do not create a database just to clear one that has never existed.
      if (existsSync(request.dbPath)) {
        const handle = open(request.dbPath);
        handle.exec("DELETE FROM cache");
      }
      value = undefined;
    } else if (request.type === "close") {
      if (db) db.close();
      db = null;
      dbPath = null;
      value = undefined;
    } else {
      const handle = open(request.dbPath);
      switch (request.type) {
        case "get": {
          const row = handle
            .query<{ data: string }, [string]>(
              "SELECT data FROM cache WHERE id = ? LIMIT 1",
            )
            .get(request.key ?? "");
          value = row?.data ?? null;
          break;
        }
        case "set":
          handle
            .prepare(
              "INSERT OR REPLACE INTO cache (id, data, updated_at) VALUES (?, ?, ?)",
            )
            .run(request.key ?? "", request.value ?? "", Date.now());
          value = undefined;
          break;
        case "remove":
          handle
            .prepare("DELETE FROM cache WHERE id = ?")
            .run(request.key ?? "");
          value = undefined;
          break;
        case "entries":
          value = handle
            .query<{ id: string; data: string }, []>(
              "SELECT id, data FROM cache",
            )
            .all()
            .map((row) => [row.id, row.data]);
          break;
      }
    }
    reply({ type: "result", id: request.id, value });
  } catch (err) {
    reply({
      type: "error",
      id: request.id,
      operation: request.type,
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
